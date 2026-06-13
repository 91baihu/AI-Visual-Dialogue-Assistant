import os
import sys
import json
import time
import logging
from dotenv import load_dotenv, set_key
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, field_validator
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from ai_service import ChatService

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="EyeTalk - AI Visual Dialogue")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
ENV_PATH = Path(__file__).parent / ".env"
print(f"[DEBUG] ENV_PATH = {ENV_PATH.resolve()}  exists={ENV_PATH.exists()}")

# Provider name → env var name mapping
PROVIDER_KEY_MAP = {
    "deepseek": "DEEPSEEK_API_KEY",
    "qwen":     "QWEN_API_KEY",
    "zhipu":    "ZHIPU_API_KEY",
    "kimi":     "KIMI_API_KEY",
    "openai":   "OPENAI_API_KEY",
}


def get_key_env_name(provider: str) -> str:
    """Map provider name to its API key env var name."""
    return PROVIDER_KEY_MAP.get(provider.lower(), f"{provider.upper()}_API_KEY")


PROVIDER_BASE_URL = {
    "deepseek": "https://api.deepseek.com",
    "qwen":     "https://dashscope.aliyuncs.com/compatible-mode",
    "zhipu":    "https://open.bigmodel.cn/api/paas",
    "kimi":     "https://api.moonshot.cn",
    "openai":   "https://api.openai.com",
}


async def _test_api_key(provider: str, api_key: str) -> dict:
    """Test if an API key is valid by sending a minimal request."""
    import httpx
    base_url = PROVIDER_BASE_URL.get(provider, "")
    if not base_url:
        return {"valid": False, "reason": f"未知提供商 {provider}，无法测试"}

    url = f"{base_url}/v1/models"
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                return {"valid": True, "reason": ""}
            elif resp.status_code == 401:
                return {"valid": False, "reason": "API Key 无效（认证失败）"}
            else:
                return {"valid": False, "reason": f"API 返回状态码 {resp.status_code}"}
    except httpx.ConnectTimeout:
        return {"valid": False, "reason": "连接超时，请检查网络"}
    except httpx.ConnectError:
        return {"valid": False, "reason": "无法连接到 API 服务器"}
    except Exception as e:
        return {"valid": False, "reason": str(e)[:100]}


class ConfigUpdate(BaseModel):
    provider: str
    api_key: str
    test: Optional[bool] = False

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v):
        if v.lower() not in PROVIDER_KEY_MAP:
            raise ValueError(f"不支持的提供商: {v}，可选值: {', '.join(PROVIDER_KEY_MAP.keys())}")
        return v.lower()

    @field_validator("api_key")
    @classmethod
    def validate_api_key(cls, v):
        if not v or len(v.strip()) < 10:
            raise ValueError("API Key 长度不能少于 10 个字符")
        return v.strip()

# Global token stats across all connections
import threading
_global_stats_lock = threading.Lock()
_global_stats = {
    "total_calls": 0,
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
    "estimated_cost": 0.0,
}


def merge_stats(token_usage):
    """Merge a ChatService's token usage into global stats"""
    d = token_usage.to_dict()
    with _global_stats_lock:
        _global_stats["total_calls"] += d["total_calls"] - _global_stats.get("_last_calls", 0)
        _global_stats["prompt_tokens"] += d["prompt_tokens"] - _global_stats.get("_last_prompt", 0)
        _global_stats["completion_tokens"] += d["completion_tokens"] - _global_stats.get("_last_completion", 0)
        _global_stats["total_tokens"] = _global_stats["prompt_tokens"] + _global_stats["completion_tokens"]
        _global_stats["estimated_cost"] = round(
            _global_stats["prompt_tokens"] / 1_000_000 * 1.0 +
            _global_stats["completion_tokens"] / 1_000_000 * 2.0, 6
        )


@app.get("/")
async def root():
    """Redirect to frontend app"""
    return RedirectResponse(url="/app/")


@app.get("/app")
async def app_no_slash():
    """Redirect /app to /app/ so StaticFiles(html=True) can find index.html"""
    return RedirectResponse(url="/app/")


@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "message": "EyeTalk backend running",
        "api_key_configured": bool(DEEPSEEK_API_KEY and DEEPSEEK_API_KEY != "your_key_here"),
    }


@app.get("/api/stats")
async def get_stats():
    with _global_stats_lock:
        return dict(_global_stats)


@app.get("/api/config")
async def get_config():
    """Return current config and which providers have keys configured"""
    configured = {}
    for provider, env_name in PROVIDER_KEY_MAP.items():
        val = os.getenv(env_name, "")
        configured[provider] = bool(val and val != "your_key_here")
    return {
        "provider": os.getenv("AI_PROVIDER", "deepseek"),
        "configured": configured,
    }


@app.post("/api/config")
async def update_config(config: ConfigUpdate):
    """Save provider and API key to .env file, optionally test the key"""
    try:
        # Optional: test API key validity
        if config.test:
            test_result = await _test_api_key(config.provider, config.api_key)
            if not test_result["valid"]:
                return {"success": False, "message": f"密钥验证失败: {test_result['reason']}"}

        env_name = get_key_env_name(config.provider)
        logger.info(f"Saving config: provider={config.provider}, key_env={env_name}, path={ENV_PATH}")

        set_key(str(ENV_PATH), "AI_PROVIDER", config.provider)
        set_key(str(ENV_PATH), env_name, config.api_key)
        os.environ["AI_PROVIDER"] = config.provider
        os.environ[env_name] = config.api_key
        return {"success": True, "message": "配置已保存"}
    except Exception as e:
        logger.error(f"Failed to save config: {e}")
        return {"success": False, "message": f"保存失败: {str(e)}"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    chat_service = ChatService()
    conn_id = id(websocket)
    last_calls = 0
    logger.info(f"[WS:{conn_id}] client connected")

    try:
        while True:
            raw = await websocket.receive_text()

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({
                    "type": "reply",
                    "text": "echo: " + raw,
                }))
                continue

            msg_type = data.get("type", "chat")
            text = data.get("text", "")
            image = data.get("image", "")

            if msg_type == "chat":
                has_image = bool(image)
                logger.info(f"[WS:{conn_id}] type=chat text={text!r} image={'yes' if has_image else 'no'}")

                start = time.time()
                try:
                    if has_image:
                        reply = chat_service.chat_with_image(text, image)
                    else:
                        reply = chat_service.chat(text)

                    elapsed = time.time() - start
                    logger.info(f"[WS:{conn_id}] AI replied in {elapsed:.2f}s, {len(reply)} chars")

                    # Update global stats
                    merge_stats(chat_service.tokens)

                    await websocket.send_text(json.dumps({
                        "type": "reply",
                        "text": reply,
                        "usage": chat_service.tokens.to_dict(),
                    }))

                except Exception as e:
                    elapsed = time.time() - start
                    logger.error(f"[WS:{conn_id}] API error after {elapsed:.2f}s: {e}")

                    if "timeout" in str(e).lower() or "timed out" in str(e).lower():
                        error_msg = "AI 响应超时，请稍后重试"
                    else:
                        error_msg = f"AI 调用出错: {str(e)[:100]}"

                    await websocket.send_text(json.dumps({
                        "type": "reply",
                        "text": error_msg,
                    }))

            elif msg_type == "clear":
                chat_service.clear_history()
                await websocket.send_text(json.dumps({
                    "type": "reply",
                    "text": "对话已清空",
                }))

            else:
                await websocket.send_text(json.dumps({
                    "type": "reply",
                    "text": f"未知消息类型: {msg_type}",
                }))

    except WebSocketDisconnect:
        logger.info(f"[WS:{conn_id}] client disconnected")
    except Exception as e:
        logger.error(f"[WS:{conn_id}] unexpected error: {e}")
    finally:
        merge_stats(chat_service.tokens)
        del chat_service
        logger.info(f"[WS:{conn_id}] ChatService cleaned up")


# Mount frontend static files under /app to avoid conflicting with API routes
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
print(f"[DEBUG] FRONTEND_DIR resolved to: {FRONTEND_DIR}")
print(f"[DEBUG] FRONTEND_DIR exists: {FRONTEND_DIR.exists()}")
print(f"[DEBUG] index.html exists: {(FRONTEND_DIR / 'index.html').exists()}")
app.mount("/app", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


def find_available_port(host, preferred_port, max_tries=10):
    """Find an available port, starting with the preferred one."""
    import socket
    for i in range(max_tries):
        port = preferred_port + i
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    return None


def get_port_occupier(port):
    """Try to identify which process is using the given port."""
    import subprocess
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.splitlines():
            if f":{port} " in line and "LISTENING" in line:
                pid = line.strip().split()[-1]
                return pid
    except Exception:
        pass
    return None


if __name__ == "__main__":
    # Fix Windows terminal encoding for emoji/Chinese output
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    HOST = "0.0.0.0"
    PREFERRED_PORT = 8000

    # Check port availability
    PORT = find_available_port(HOST, PREFERRED_PORT)

    if PORT is None:
        pid = get_port_occupier(PREFERRED_PORT)
        print("=" * 50)
        print("  错误: 无法找到可用端口")
        print("=" * 50)
        print(f"  端口 {PREFERRED_PORT} 被占用")
        if pid:
            print(f"  占用进程 PID: {pid}")
            print(f"  终止命令:     taskkill /F /PID {pid}")
        print(f"  或手动指定其他端口: python main.py --port 9000")
        print("=" * 50)
        sys.exit(1)

    if PORT != PREFERRED_PORT:
        pid = get_port_occupier(PREFERRED_PORT)
        print(f"  端口 {PREFERRED_PORT} 已被占用", end="")
        if pid:
            print(f" (PID: {pid})", end="")
        print(f"，自动切换到端口 {PORT}")

    print("=" * 50)
    print("  EyeTalk AI视觉对话助手")
    print("=" * 50)
    print(f"  后端API地址  → http://localhost:{PORT}")
    print(f"  前端页面地址 → http://localhost:{PORT}/")
    print(f"  API文档地址  → http://localhost:{PORT}/docs")
    print("=" * 50)

    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
