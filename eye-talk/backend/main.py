import os
import json
import time
import logging
from dotenv import load_dotenv
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
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


# Mount frontend static files — must be AFTER all API routes
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
