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
from fastapi.responses import RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from ai_service import ChatService, PROVIDER_CONFIG, get_api_key_env_name
from tts_service import synthesize_speech, synthesize_speech_stream, get_voice_list

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

# Global ChatService instance (recreated on provider switch)
ai_service = ChatService()

# Track connected WebSocket clients for broadcast
_ws_clients: dict[int, WebSocket] = {}


async def _test_api_key(provider: str, api_key: str) -> dict:
    """Test if an API key is valid by sending a minimal chat request."""
    if provider not in PROVIDER_CONFIG:
        return {"valid": False, "reason": f"未知提供商: {provider}"}

    config = PROVIDER_CONFIG[provider]
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url=config["base_url"])
        resp = client.chat.completions.create(
            model=config["chat_model"],
            messages=[{"role": "user", "content": "Hi"}],
            max_tokens=5,
            timeout=10,
        )
        return {"valid": True, "reason": ""}
    except Exception as e:
        err = str(e).lower()
        if "401" in err or "unauthorized" in err or "invalid" in err:
            return {"valid": False, "reason": "API Key 无效（认证失败）"}
        if "timeout" in err or "timed out" in err:
            return {"valid": False, "reason": "连接超时，请检查网络"}
        if "connect" in err:
            return {"valid": False, "reason": "无法连接到 API 服务器"}
        return {"valid": False, "reason": str(e)[:120]}


class ConfigUpdate(BaseModel):
    provider: str
    api_key: str
    test: Optional[bool] = False

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v):
        if v.lower() not in PROVIDER_CONFIG:
            raise ValueError(f"不支持的提供商: {v}，可选值: {', '.join(PROVIDER_CONFIG.keys())}")
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
    """Merge a ChatService's token usage into global stats.

    Computes delta from the service's own accumulators so cost is always
    calculated at the *current* provider's rate for each batch of tokens.
    After a provider switch the new service starts at zero, so the delta
    correctly reflects only new usage.
    """
    d = token_usage.to_dict()
    with _global_stats_lock:
        delta_calls = d["total_calls"] - _global_stats.get("_last_calls", 0)
        delta_prompt = d["prompt_tokens"] - _global_stats.get("_last_prompt", 0)
        delta_completion = d["completion_tokens"] - _global_stats.get("_last_completion", 0)

        _global_stats["total_calls"] += delta_calls
        _global_stats["prompt_tokens"] += delta_prompt
        _global_stats["completion_tokens"] += delta_completion
        _global_stats["total_tokens"] = _global_stats["prompt_tokens"] + _global_stats["completion_tokens"]

        # Accumulate cost as delta — each batch is priced at its provider's rate
        delta_cost = (
            delta_prompt / 1_000_000 * token_usage.input_price +
            delta_completion / 1_000_000 * token_usage.output_price
        )
        _global_stats["estimated_cost"] = round(
            _global_stats.get("estimated_cost", 0.0) + delta_cost, 6
        )

        _global_stats["_last_calls"] = d["total_calls"]
        _global_stats["_last_prompt"] = d["prompt_tokens"]
        _global_stats["_last_completion"] = d["completion_tokens"]


@app.get("/")
async def root():
    """Redirect to landing page"""
    return RedirectResponse(url="/app/landing.html")


@app.get("/app")
async def app_no_slash():
    """Redirect /app to /app/ so StaticFiles(html=True) can find index.html"""
    return RedirectResponse(url="/app/")


@app.get("/api/health")
async def health_check():
    env_key = get_api_key_env_name(ai_service.provider)
    key_val = os.getenv(env_key, "")
    return {
        "status": "ok",
        "message": "EyeTalk backend running",
        "provider": ai_service.provider_name,
        "api_key_configured": bool(key_val and key_val != "your_key_here"),
    }


@app.get("/api/stats")
async def get_stats():
    with _global_stats_lock:
        return dict(_global_stats)


# ==================== TTS Endpoints ====================

@app.get("/api/tts/voices")
async def tts_voices():
    """Return available TTS voice list."""
    return {"voices": get_voice_list()}


class TTSRequest(BaseModel):
    text: str
    voice_id: str = "doubao"
    speed_ratio: Optional[float] = 1.0
    volume_ratio: Optional[float] = 1.0
    pitch_ratio: Optional[float] = 1.0

    @field_validator("text")
    @classmethod
    def validate_text(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("文本不能为空")
        if len(v) > 5000:
            raise ValueError("文本长度不能超过 5000 字符")
        return v

    @field_validator("voice_id")
    @classmethod
    def validate_voice_id(cls, v):
        from tts_service import TTS_VOICE_CONFIG
        if v not in TTS_VOICE_CONFIG:
            raise ValueError(f"未知音色: {v}，可选值: {', '.join(TTS_VOICE_CONFIG.keys())}")
        return v


@app.post("/api/tts")
async def tts_synthesize(req: TTSRequest):
    """Synthesize speech and return complete MP3 (for preview/test)."""
    audio = await synthesize_speech(
        text=req.text,
        voice_id=req.voice_id,
        speed_ratio=req.speed_ratio or 1.0,
        volume_ratio=req.volume_ratio or 1.0,
        pitch_ratio=req.pitch_ratio or 1.0,
    )
    if not audio:
        raise HTTPException(status_code=500, detail="语音合成失败")
    return Response(content=audio, media_type="audio/mpeg")


@app.post("/api/tts/stream")
async def tts_stream(req: TTSRequest):
    """Stream synthesized speech: audio chunks pushed as they are generated (low latency)."""
    async def audio_generator():
        async for chunk in synthesize_speech_stream(
            text=req.text,
            voice_id=req.voice_id,
            speed_ratio=req.speed_ratio or 1.0,
            volume_ratio=req.volume_ratio or 1.0,
            pitch_ratio=req.pitch_ratio or 1.0,
        ):
            yield chunk

    return StreamingResponse(
        audio_generator(),
        media_type="audio/mpeg",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@app.get("/api/config")
async def get_config():
    """Return current provider info, configured keys, models, and connection status."""
    # Check which providers have keys configured (without exposing values)
    configured = {}
    for provider in PROVIDER_CONFIG:
        env_name = get_api_key_env_name(provider)
        val = os.getenv(env_name, "")
        configured[provider] = bool(val and val != "your_key_here")

    # Quick connection test on current provider
    env_key = get_api_key_env_name(ai_service.provider)
    key_val = os.getenv(env_key, "")
    if key_val and key_val != "your_key_here":
        test_result = await _test_api_key(ai_service.provider, key_val)
        connection_ok = test_result["valid"]
        connection_reason = test_result.get("reason", "")
    else:
        connection_ok = False
        connection_reason = "API Key 未配置"

    return {
        "provider": ai_service.provider,
        "provider_name": ai_service.provider_name,
        "chat_model": ai_service.chat_model,
        "vision_model": ai_service.vision_model,
        "supports_vision": ai_service.supports_vision,
        "configured": configured,
        "connection_ok": connection_ok,
        "connection_reason": connection_reason,
    }


@app.post("/api/config")
async def update_config(config: ConfigUpdate):
    """Save provider and API key, test first, then switch gracefully."""
    global ai_service

    # 1. Test the new key before committing
    test_result = await _test_api_key(config.provider, config.api_key)
    if not test_result["valid"]:
        return {
            "success": False,
            "message": f"密钥验证失败: {test_result['reason']}",
            "provider": ai_service.provider_name,
        }

    # 2. Save to .env and update runtime env
    env_name = get_api_key_env_name(config.provider)
    logger.info(f"Switching provider: {ai_service.provider} -> {config.provider}")

    try:
        set_key(str(ENV_PATH), "AI_PROVIDER", config.provider)
        set_key(str(ENV_PATH), env_name, config.api_key)
        os.environ["AI_PROVIDER"] = config.provider
        os.environ[env_name] = config.api_key
    except Exception as e:
        logger.error(f"Failed to save .env: {e}")
        return {"success": False, "message": f"保存配置失败: {str(e)}"}

    # 3. Create new ChatService (uses updated env vars)
    try:
        new_service = ChatService()
    except Exception as e:
        logger.error(f"Failed to init new ChatService: {e}")
        return {"success": False, "message": f"新提供商初始化失败: {str(e)}"}

    # 4. Swap in the new service
    old_provider = ai_service.provider_name
    ai_service = new_service

    # 4b. Reset global stats so old provider's tokens/cost don't pollute new provider
    with _global_stats_lock:
        _global_stats.update({
            "total_calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "estimated_cost": 0.0,
            "_last_calls": 0,
            "_last_prompt": 0,
            "_last_completion": 0,
        })

    # 5. Notify all connected WebSocket clients
    broadcast_msg = json.dumps({
        "type": "provider_changed",
        "provider": ai_service.provider,
        "provider_name": ai_service.provider_name,
        "chat_model": ai_service.chat_model,
        "vision_model": ai_service.vision_model,
    })
    disconnected = []
    for conn_id, ws in _ws_clients.items():
        try:
            await ws.send_text(broadcast_msg)
        except Exception:
            disconnected.append(conn_id)
    for conn_id in disconnected:
        _ws_clients.pop(conn_id, None)

    logger.info(f"Provider switched: {old_provider} -> {ai_service.provider_name}")

    return {
        "success": True,
        "message": f"已切换到 {ai_service.provider_name}",
        "provider": ai_service.provider,
        "provider_name": ai_service.provider_name,
        "chat_model": ai_service.chat_model,
        "vision_model": ai_service.vision_model,
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    conn_id = id(websocket)
    _ws_clients[conn_id] = websocket
    logger.info(f"[WS:{conn_id}] client connected ({len(_ws_clients)} total)")

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
                        reply = ai_service.chat_with_image(text, image)
                    else:
                        reply = ai_service.chat(text)

                    elapsed = time.time() - start
                    logger.info(f"[WS:{conn_id}] AI replied in {elapsed:.2f}s, {len(reply)} chars")

                    # Update global stats
                    merge_stats(ai_service.tokens)

                    await websocket.send_text(json.dumps({
                        "type": "reply",
                        "text": reply,
                        "usage": ai_service.tokens.to_dict(),
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
                ai_service.clear_history()
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
        _ws_clients.pop(conn_id, None)
        merge_stats(ai_service.tokens)
        logger.info(f"[WS:{conn_id}] cleaned up ({len(_ws_clients)} remaining)")


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
