import os
import sys
import json
import time
import logging
from dotenv import load_dotenv
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
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
