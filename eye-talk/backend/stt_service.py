"""
Speech-to-Text Service
前端直接录制 WAV（PCM 16kHz），后端无需格式转换。
优先：DashScope Paraformer → 降级：Google 免费 API
"""

import os
import logging
import tempfile

logger = logging.getLogger(__name__)


async def transcribe_audio(audio_bytes: bytes, mime_type: str = "audio/wav") -> dict:
    """
    转写 WAV 音频为文字。
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
                        logger.info(f"[STT] DashScope OK: {text[:80]}")
                        return {"text": text, "success": True, "error": None}
                return {"text": "", "success": False, "error": "识别结果为空"}
            else:
                err = getattr(result.output, 'message', result.output.task_status)
                return {"text": "", "success": False, "error": f"DashScope: {err}"}
        finally:
            os.unlink(tmp_path)

    except Exception as e:
        logger.error(f"[STT] DashScope error: {e}")
        return {"text": "", "success": False, "error": str(e)}


def _google_transcribe(audio_bytes: bytes) -> dict:
    """Google 免费语音识别（直接读 WAV）。"""
    try:
        import speech_recognition as sr
    except ImportError:
        return {"text": "", "success": False, "error": "未安装 SpeechRecognition"}

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
        return {"text": text, "success": True, "error": None}
    except sr.UnknownValueError:
        return {"text": "", "success": False, "error": "未能识别语音内容，请再试一次"}
    except sr.RequestError as e:
        return {"text": "", "success": False, "error": f"Google 语音服务不可用: {e}"}
    except Exception as e:
        return {"text": "", "success": False, "error": f"识别失败: {e}"}
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except:
                pass
