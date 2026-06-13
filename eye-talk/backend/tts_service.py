"""
Edge TTS Service — 微软免费神经网络语音合成
使用 edge-tts 库，无需 API Key，中文语音效果接近真人。
"""

import logging
from typing import Optional
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


async def synthesize_speech(
    text: str,
    voice_id: str = "doubao",
    speed_ratio: float = 1.0,
    volume_ratio: float = 1.0,
    pitch_ratio: float = 1.0,
) -> Optional[bytes]:
    """
    使用 Edge TTS 合成语音，返回 MP3 音频 bytes。

    Args:
        text: 要合成的文本
        voice_id: 音色包 ID (doubao, warm, news, cute, serious)
        speed_ratio: 语速 (0.5 ~ 2.0)，1.0 为正常
        volume_ratio: 音量 (0.1 ~ 3.0)，1.0 为正常（edge-tts 不直接支持，忽略）
        pitch_ratio: 音调 (0.5 ~ 2.0)，1.0 为正常

    Returns:
        MP3 音频 bytes，失败返回 None
    """
    voice_config = TTS_VOICE_CONFIG.get(voice_id, TTS_VOICE_CONFIG["doubao"])
    voice = voice_config["voice"]

    # 截断过长文本
    if len(text) > 5000:
        text = text[:5000]
        logger.warning("[TTS] Text truncated to 5000 chars")

    # 语速：edge-tts 用 "+N%" / "-N%" 格式
    speed_pct = int((speed_ratio - 1.0) * 100)
    rate_str = f"+{speed_pct}%" if speed_pct >= 0 else f"{speed_pct}%"

    # 音调：edge-tts 用 "+NHz" / "-NHz" 格式
    pitch_hz = int((pitch_ratio - 1.0) * 50)
    pitch_str = f"+{pitch_hz}Hz" if pitch_hz >= 0 else f"{pitch_hz}Hz"

    try:
        communicate = edge_tts.Communicate(
            text=text,
            voice=voice,
            rate=rate_str,
            pitch=pitch_str,
        )

        audio_chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        if audio_chunks:
            audio_data = b"".join(audio_chunks)
            logger.info(f"[TTS] Synthesized {len(audio_data)} bytes, voice={voice_id} ({voice})")
            return audio_data
        else:
            logger.error("[TTS] No audio data received")
            return None

    except Exception as e:
        logger.error(f"[TTS] Synthesis failed: {e}")
        return None


def get_voice_list() -> list:
    """返回可用音色列表。"""
    return [
        {
            "id": voice_id,
            "name": config["name"],
            "style": config["style"],
            "voice": config["voice"],
        }
        for voice_id, config in TTS_VOICE_CONFIG.items()
    ]
