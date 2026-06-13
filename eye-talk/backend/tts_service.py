"""
Edge TTS Service — 微软免费神经网络语音合成
使用 edge-tts 库，无需 API Key，中文语音效果接近真人。
支持流式输出：边合成边推送音频块，前端可即时播放。
"""

import logging
from typing import Optional, AsyncGenerator
import edge_tts

logger = logging.getLogger(__name__)

# 5 款差异化中文语音包（Edge TTS 微软神经网络语音）
TTS_VOICE_CONFIG = {
    "doubao": {
        "voice": "zh-CN-XiaoxiaoNeural",
        "name": "晓晓（默认）",
        "style": "女声 · 温润自然",
    },
    "warm": {
        "voice": "zh-CN-XiaoyiNeural",
        "name": "晓伊",
        "style": "女声 · 柔和亲切",
    },
    "news": {
        "voice": "zh-CN-YunyangNeural",
        "name": "云扬",
        "style": "男声 · 新闻播报",
    },
    "cute": {
        "voice": "zh-CN-YunxiaNeural",
        "name": "云夏",
        "style": "男声 · 活泼俏皮",
    },
    "serious": {
        "voice": "zh-CN-YunjianNeural",
        "name": "云健",
        "style": "男声 · 沉稳有力",
    },
}


def _build_params(voice_id, speed_ratio, pitch_ratio):
    """构建 edge-tts 参数。"""
    voice_config = TTS_VOICE_CONFIG.get(voice_id, TTS_VOICE_CONFIG["doubao"])
    voice = voice_config["voice"]
    speed_pct = int((speed_ratio - 1.0) * 100)
    rate_str = f"+{speed_pct}%" if speed_pct >= 0 else f"{speed_pct}%"
    pitch_hz = int((pitch_ratio - 1.0) * 50)
    pitch_str = f"+{pitch_hz}Hz" if pitch_hz >= 0 else f"{pitch_hz}Hz"
    return voice, rate_str, pitch_str


async def synthesize_speech_stream(
    text: str,
    voice_id: str = "doubao",
    speed_ratio: float = 1.0,
    volume_ratio: float = 1.0,
    pitch_ratio: float = 1.0,
) -> AsyncGenerator[bytes, None]:
    """
    流式合成语音：逐块 yield MP3 数据，前端可边接收边播放。
    """
    voice, rate_str, pitch_str = _build_params(voice_id, speed_ratio, pitch_ratio)

    if len(text) > 5000:
        text = text[:5000]

    communicate = edge_tts.Communicate(
        text=text, voice=voice, rate=rate_str, pitch=pitch_str,
    )
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]


async def synthesize_speech(
    text: str,
    voice_id: str = "doubao",
    speed_ratio: float = 1.0,
    volume_ratio: float = 1.0,
    pitch_ratio: float = 1.0,
) -> Optional[bytes]:
    """
    完整合成语音，返回全部 MP3 bytes（用于试听等需要完整音频的场景）。
    """
    voice, rate_str, pitch_str = _build_params(voice_id, speed_ratio, pitch_ratio)

    if len(text) > 5000:
        text = text[:5000]

    try:
        communicate = edge_tts.Communicate(
            text=text, voice=voice, rate=rate_str, pitch=pitch_str,
        )
        audio_chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        if audio_chunks:
            data = b"".join(audio_chunks)
            logger.info(f"[TTS] Synthesized {len(data)} bytes, voice={voice_id}")
            return data
        logger.error("[TTS] No audio data received")
        return None
    except Exception as e:
        logger.error(f"[TTS] Synthesis failed: {e}")
        return None


def get_voice_list() -> list:
    """返回可用音色列表。"""
    return [
        {"id": vid, "name": cfg["name"], "style": cfg["style"], "voice": cfg["voice"]}
        for vid, cfg in TTS_VOICE_CONFIG.items()
    ]
