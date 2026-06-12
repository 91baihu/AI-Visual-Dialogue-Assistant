import os
import time
import logging
from typing import Optional
from openai import OpenAI

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "你是一个AI视觉助手，用户会通过摄像头向你展示事物，"
    "你需要仔细观察图片内容并回答用户的问题。回答要简洁、准确、友好。"
    "如果图片中有文字请帮忙识别。"
)

VISION_MODEL = "deepseek-v4-pro"
TEXT_MODEL = "deepseek-chat"

MAX_HISTORY = 20

# DeepSeek pricing (CNY per million tokens)
PRICE_INPUT = 1.0
PRICE_OUTPUT = 2.0


class TokenUsage:
    """Token usage accumulator"""
    def __init__(self):
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_calls = 0

    def add(self, prompt_tokens, completion_tokens):
        self.prompt_tokens += prompt_tokens
        self.completion_tokens += completion_tokens
        self.total_calls += 1

    def to_dict(self):
        total = self.prompt_tokens + self.completion_tokens
        cost = (self.prompt_tokens / 1_000_000 * PRICE_INPUT +
                self.completion_tokens / 1_000_000 * PRICE_OUTPUT)
        return {
            "total_calls": self.total_calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": total,
            "estimated_cost": round(cost, 6),
        }


class ChatService:
    """DeepSeek API wrapper with token tracking"""

    def __init__(self):
        self.client = OpenAI(
            api_key=os.getenv("DEEPSEEK_API_KEY", ""),
            base_url="https://api.deepseek.com",
        )
        self.messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        self._vision_supported = None
        self.tokens = TokenUsage()
        logger.info("ChatService initialized")

    def _trim_history(self):
        if len(self.messages) > MAX_HISTORY + 1:
            self.messages = [self.messages[0]] + self.messages[-(MAX_HISTORY):]

    def _call_api(self, model, messages, max_tokens=1024, timeout=30):
        return self.client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            timeout=timeout,
        )

    def _track_usage(self, resp):
        """Extract and accumulate token usage from API response"""
        if resp.usage:
            self.tokens.add(resp.usage.prompt_tokens, resp.usage.completion_tokens)
            logger.debug(f"[tokens] +{resp.usage.prompt_tokens}+{resp.usage.completion_tokens} = {self.tokens.to_dict()['total_tokens']}")

    def chat(self, text: str, history: Optional[list] = None) -> str:
        self.messages.append({"role": "user", "content": text})
        self._trim_history()

        start = time.time()
        try:
            resp = self._call_api(TEXT_MODEL, self.messages)
            reply = resp.choices[0].message.content
            self._track_usage(resp)
            elapsed = time.time() - start
            logger.info(f"[chat] text={text[:50]}... -> {len(reply)} chars, {elapsed:.2f}s")

            self.messages.append({"role": "assistant", "content": reply})
            self._trim_history()
            return reply

        except Exception as e:
            elapsed = time.time() - start
            logger.error(f"[chat] failed after {elapsed:.2f}s: {e}")
            self.messages.pop()
            raise

    def chat_with_image(self, text: str, image_base64: str, history: Optional[list] = None) -> str:
        if self._vision_supported is False:
            return self._chat_image_fallback(text, image_base64)

        if not image_base64.startswith("data:"):
            image_url = f"data:image/jpeg;base64,{image_base64}"
        else:
            image_url = image_base64

        user_content = [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]

        self.messages.append({"role": "user", "content": user_content})
        self._trim_history()

        start = time.time()
        try:
            resp = self._call_api(VISION_MODEL, self.messages)
            reply = resp.choices[0].message.content
            self._track_usage(resp)
            elapsed = time.time() - start
            logger.info(f"[chat_with_image] OK {elapsed:.2f}s -> {len(reply)} chars")

            self._vision_supported = True
            self.messages.append({"role": "assistant", "content": reply})
            self._trim_history()
            return reply

        except Exception as e:
            elapsed = time.time() - start
            err_str = str(e).lower()

            if "unknown variant" in err_str or "image_url" in err_str:
                logger.warning(f"[chat_with_image] vision not supported, falling back ({elapsed:.2f}s)")
                self._vision_supported = False
                self.messages.pop()
                return self._chat_image_fallback(text, image_base64)

            logger.error(f"[chat_with_image] failed after {elapsed:.2f}s: {e}")
            self.messages.pop()
            raise

    def _chat_image_fallback(self, text: str, image_base64: str) -> str:
        fallback_text = (
            f"{text}\n\n"
            f"[系统提示：用户发送了一张摄像头截图（base64, {len(image_base64)} 字符），"
            f"但当前 API 不支持图片识别。请根据用户的文字描述来回复。]"
        )
        self.messages.append({"role": "user", "content": fallback_text})
        self._trim_history()

        start = time.time()
        try:
            resp = self._call_api(TEXT_MODEL, self.messages)
            reply = resp.choices[0].message.content
            self._track_usage(resp)
            elapsed = time.time() - start
            logger.info(f"[chat_image_fallback] {elapsed:.2f}s -> {len(reply)} chars")

            self.messages.append({"role": "assistant", "content": reply})
            self._trim_history()
            return reply

        except Exception as e:
            elapsed = time.time() - start
            logger.error(f"[chat_image_fallback] failed after {elapsed:.2f}s: {e}")
            self.messages.pop()
            raise

    def clear_history(self):
        self.messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        logger.info("History cleared")
