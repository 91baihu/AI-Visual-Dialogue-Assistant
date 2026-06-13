"""
Speech-to-Text Service
优先：阿里 DashScope Paraformer（中文识别极好，用现有 key，支持 webm）
降级：Google 免费语音识别（需要转 WAV）
"""

import os
import io
import uuid
import logging
import tempfile
import asyncio

logger = logging.getLogger(__name__)


async def transcribe_audio(audio_bytes: bytes, mime_type: str = "audio/webm") -> dict:
    """
    转写音频为文字。
    优先 DashScope Paraformer → 降级 Google 免费 API。
    """
    # 1. 尝试 DashScope（直接支持 webm/ogg/mp3）
    dash_key = os.getenv("DASHSCOPE_API_KEY", "")
    if dash_key and dash_key != "your_key_here":
        result = await _dashscope_transcribe(audio_bytes, mime_type, dash_key)
        if result["success"]:
            return result
        logger.warning(f"[STT] DashScope failed: {result['error']}")

    # 2. 降级 Google（需要 WAV 格式）
    return await _google_transcribe(audio_bytes, mime_type)


async def _dashscope_transcribe(audio_bytes: bytes, mime_type: str, api_key: str) -> dict:
    """使用 DashScope Paraformer-v2 语音识别（支持多种音频格式）。"""
    try:
        import dashscope
        from dashscope.audio.asr import Transcription

        dashscope.api_key = api_key

        # 写入临时文件（DashScope SDK 需要文件路径）
        ext_map = {
            "audio/webm": ".wav",
            "audio/ogg": ".ogg",
            "audio/wav": ".wav",
            "audio/mp3": ".mp3",
            "audio/mpeg": ".mp3",
        }
        ext = ext_map.get(mime_type, ".wav")

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
                f.write(audio_bytes)
                tmp_path = f.name

            # 提交异步识别任务
            response = Transcription.async_call(
                model="paraformer-v2",
                file_urls=[f"file://{tmp_path}"],
                language_hints=["zh"],
            )

            # 等待结果
            result = Transcription.wait(response.output.task_id)
            status = result.output.task_status

            if status == "SUCCEEDED":
                results = result.output.results
                if results and results[0].transcription_url:
                    # 下载识别结果
                    import httpx
                    resp = httpx.get(results[0].transcription_url, timeout=10)
                    data = resp.json()
                    # 结果格式: {"transcripts": [{"text": "..."}]}
                    transcripts = data.get("transcripts", [])
                    if transcripts:
                        text = transcripts[0].get("text", "").strip()
                        logger.info(f"[STT] DashScope OK: {text[:80]}")
                        return {"text": text, "success": True, "error": None}
                return {"text": "", "success": False, "error": "识别结果为空"}
            else:
                err_msg = result.output.message if hasattr(result.output, 'message') else status
                return {"text": "", "success": False, "error": f"DashScope: {err_msg}"}

        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except:
                    pass

    except Exception as e:
        logger.error(f"[STT] DashScope error: {e}")
        return {"text": "", "success": False, "error": str(e)}


async def _google_transcribe(audio_bytes: bytes, mime_type: str) -> dict:
    """降级：Google 免费语音识别。webm 需要转 WAV。"""
    try:
        import speech_recognition as sr
    except ImportError:
        return {"text": "", "success": False, "error": "未安装 SpeechRecognition"}

    # 尝试用 pydub 转换格式
    wav_bytes = _convert_to_wav(audio_bytes, mime_type)
    if wav_bytes is None:
        return {"text": "", "success": False, "error": "音频格式转换失败，请安装 ffmpeg"}

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav_bytes)
            tmp_path = f.name

        recognizer = sr.Recognizer()
        with sr.AudioFile(tmp_path) as source:
            audio_data = recognizer.record(source)

        text = recognizer.recognize_google(audio_data, language="zh-CN")
        logger.info(f"[STT] Google OK: {text[:80]}")
        return {"text": text, "success": True, "error": None}
    except Exception as e:
        return {"text": "", "success": False, "error": f"识别失败: {e}"}
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except:
                pass


def _convert_to_wav(audio_bytes: bytes, mime_type: str):
    """将音频转换为 WAV 格式。尝试 pydub，失败则尝试 raw PCM。"""
    # 如果已经是 WAV，直接返回
    if audio_bytes[:4] == b"RIFF":
        return audio_bytes

    try:
        from pydub import AudioSegment
        # pydub 需要 ffmpeg 来处理 webm/ogg
        ext_map = {
            "audio/webm": "webm",
            "audio/ogg": "ogg",
            "audio/mp3": "mp3",
            "audio/mpeg": "mp3",
            "audio/wav": "wav",
        }
        fmt = ext_map.get(mime_type, "webm")
        audio = AudioSegment.from_file(io.BytesIO(audio_bytes), format=fmt)
        audio = audio.set_frame_rate(16000).set_channels(1)
        buf = io.BytesIO()
        audio.export(buf, format="wav")
        return buf.getvalue()
    except Exception as e:
        logger.warning(f"[STT] pydub conversion failed: {e}")
        return None
