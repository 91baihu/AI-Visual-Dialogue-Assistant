"""
Speech-to-Text Service
支持两种模式：
  1. 批量转写（transcribe_audio）— 接收完整音频文件
  2. 流式转写（StreamTranscriber）— 接收 PCM 实时音频流，带 VAD
优先：DashScope Paraformer → 降级：Google 免费 API
"""

import os
import io
import struct
import logging
import tempfile
import time
from typing import Optional

logger = logging.getLogger(__name__)

# VAD 参数
VAD_SILENCE_THRESHOLD = 300      # PCM 16-bit 静音阈值（振幅）
VAD_SILENCE_DURATION_MS = 1500   # 连续静音超过此值则判定说话结束
VAD_MIN_SPEECH_MS = 300          # 最短有效语音时长
SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit


def _compute_rms(pcm_bytes: bytes) -> float:
    """计算 PCM 16-bit 音频的 RMS 振幅。"""
    if len(pcm_bytes) < 2:
        return 0
    count = len(pcm_bytes) // 2
    samples = struct.unpack(f"<{count}h", pcm_bytes[:count * 2])
    if not samples:
        return 0
    sum_sq = sum(s * s for s in samples)
    return (sum_sq / count) ** 0.5


def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    """将原始 PCM 16-bit mono 转换为 WAV 格式。"""
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


class StreamTranscriber:
    """
    流式语音转写器。
    用法：
        transcriber = StreamTranscriber()
        for chunk in audio_chunks:
            result = transcriber.feed(chunk)
            if result:
                yield result  # {text, is_final, confidence, duration_ms}
        final = transcriber.finish()
        if final:
            yield final
    """

    def __init__(self):
        self._pcm_buffer = bytearray()      # 累积的 PCM 数据
        self._speech_start: Optional[float] = None  # 语音开始时间
        self._last_voice_time: Optional[float] = None  # 最后一次检测到语音的时间
        self._is_speaking = False
        self._total_duration_ms = 0

    def feed(self, pcm_chunk: bytes) -> Optional[dict]:
        """
        喂入一帧 PCM 音频数据。
        返回 None 表示还在等待，返回 dict 表示识别出结果。
        """
        if not pcm_chunk:
            return None

        self._pcm_buffer.extend(pcm_chunk)
        rms = _compute_rms(pcm_chunk)
        now = time.time()

        # VAD: 检测语音活动
        if rms > VAD_SILENCE_THRESHOLD:
            if not self._is_speaking:
                self._is_speaking = True
                self._speech_start = now
                logger.info(f"[STT-VAD] Speech started (rms={rms:.0f})")
            self._last_voice_time = now
        elif self._is_speaking:
            # 正在说话但当前帧静音，检查是否持续静音
            silence_ms = (now - (self._last_voice_time or now)) * 1000
            if silence_ms >= VAD_SILENCE_DURATION_MS:
                # 静音超时，判定说话结束
                speech_duration_ms = (now - (self._speech_start or now)) * 1000
                if speech_duration_ms >= VAD_MIN_SPEECH_MS:
                    logger.info(f"[STT-VAD] Speech ended (duration={speech_duration_ms:.0f}ms)")
                    return self._do_recognize()
                else:
                    # 太短，可能是噪声，重置
                    logger.info(f"[STT-VAD] Speech too short ({speech_duration_ms:.0f}ms), discarding")
                    self._reset()

        return None

    def finish(self) -> Optional[dict]:
        """主动结束转写（用户松开按钮时调用），返回最终识别结果。"""
        if len(self._pcm_buffer) < SAMPLE_RATE:  # 不到1秒的数据
            # 但仍然尝试识别
            pass
        if self._pcm_buffer:
            return self._do_recognize()
        return None

    def _reset(self):
        """重置状态。"""
        self._pcm_buffer.clear()
        self._speech_start = None
        self._last_voice_time = None
        self._is_speaking = False

    def _do_recognize(self) -> Optional[dict]:
        """执行批量识别并返回结果。"""
        pcm_data = bytes(self._pcm_buffer)
        duration_ms = len(pcm_data) / (SAMPLE_RATE * SAMPLE_WIDTH) * 1000
        self._reset()

        if duration_ms < 100:
            return None

        # 转换为 WAV 并识别
        wav_bytes = _pcm_to_wav(pcm_data)
        result = transcribe_audio_sync(wav_bytes)

        return {
            "text": result.get("text", ""),
            "is_final": True,
            "confidence": result.get("confidence", 0),
            "duration_ms": round(duration_ms),
            "success": result.get("success", False),
            "error": result.get("error"),
        }


def transcribe_audio_sync(audio_bytes: bytes) -> dict:
    """
    同步转写 WAV 音频为文字。
    优先 DashScope Paraformer → 降级 Google 免费 API。
    """
    # 1. 尝试 DashScope
    dash_key = os.getenv("DASHSCOPE_API_KEY", "")
    if dash_key and dash_key != "your_key_here":
        result = _dashscope_transcribe(audio_bytes, dash_key)
        if result["success"]:
            return result
        logger.warning(f"[STT] DashScope failed: {result['error']}")

    # 2. 降级 Google
    return _google_transcribe(audio_bytes)


async def transcribe_audio(audio_bytes: bytes, mime_type: str = "audio/wav") -> dict:
    """异步转写（兼容旧接口）。"""
    return transcribe_audio_sync(audio_bytes)


def _dashscope_transcribe(audio_bytes: bytes, api_key: str) -> dict:
    """DashScope Paraformer-v2 语音识别。"""
    try:
        import dashscope
        from dashscope.audio.asr import Transcription

        dashscope.api_key = api_key

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        try:
            response = Transcription.async_call(
                model="paraformer-v2",
                file_urls=[f"file://{tmp_path}"],
                language_hints=["zh"],
            )
            result = Transcription.wait(response.output.task_id)

            if result.output.task_status == "SUCCEEDED":
                results = result.output.results
                if results and results[0].transcription_url:
                    import httpx
                    resp = httpx.get(results[0].transcription_url, timeout=10)
                    transcripts = resp.json().get("transcripts", [])
                    if transcripts:
                        text = transcripts[0].get("text", "").strip()
                        confidence = transcripts[0].get("confidence", 0)
                        logger.info(f"[STT] DashScope OK: {text[:80]}")
                        return {
                            "text": text,
                            "success": True,
                            "error": None,
                            "confidence": confidence,
                        }
                return {"text": "", "success": False, "error": "识别结果为空", "confidence": 0}
            else:
                err = getattr(result.output, "message", result.output.task_status)
                return {"text": "", "success": False, "error": f"DashScope: {err}", "confidence": 0}
        finally:
            os.unlink(tmp_path)

    except Exception as e:
        logger.error(f"[STT] DashScope error: {e}")
        return {"text": "", "success": False, "error": str(e), "confidence": 0}


def _google_transcribe(audio_bytes: bytes) -> dict:
    """Google 免费语音识别。"""
    try:
        import speech_recognition as sr
    except ImportError:
        return {"text": "", "success": False, "error": "未安装 SpeechRecognition", "confidence": 0}

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        recognizer = sr.Recognizer()
        with sr.AudioFile(tmp_path) as source:
            audio_data = recognizer.record(source)

        text = recognizer.recognize_google(audio_data, language="zh-CN")
        logger.info(f"[STT] Google OK: {text[:80]}")
        return {"text": text, "success": True, "error": None, "confidence": 0.8}
    except sr.UnknownValueError:
        return {"text": "", "success": False, "error": "未能识别语音内容，请再试一次", "confidence": 0}
    except sr.RequestError as e:
        return {"text": "", "success": False, "error": f"Google 语音服务不可用: {e}", "confidence": 0}
    except Exception as e:
        return {"text": "", "success": False, "error": f"识别失败: {e}", "confidence": 0}
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except:
                pass
