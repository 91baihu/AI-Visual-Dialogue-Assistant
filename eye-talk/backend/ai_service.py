import os
import re
import time
import logging
from typing import Optional
from openai import OpenAI

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "你是一个AI视觉助手，用户会通过摄像头向你展示事物，"
    "你需要仔细观察图片内容并回答用户的问题。回答要简洁、准确、友好。"
    "如果图片中有文字请帮忙识别。\n\n"
    "【输出格式要求 - 必须严格遵守】\n"
    "1. 只输出纯文字，绝对禁止使用任何Markdown标记（如**加粗**、#标题、-列表、```代码块```等）\n"
    "2. 绝对禁止使用emoji表情符号（如😊👍🔥❤️😂等一切emoji），绝对禁止使用HTML标签\n"
    "3. 绝对禁止使用特殊装饰符号（如★●►▶◆◇■□▲△•·※→←↑↓等）\n"
    "4. 禁止使用编号列表和项目符号，用自然语句表达\n"
    "5. 简短问题回答控制在50字以内，场景描述控制在100字以内\n"
    "6. 语气口语化，适合语音朗读\n"
    "7. 违反以上任何一条都是错误的，你的回复必须是普通人打出来的纯文字"
)

# 正则：剥离 AI 回复中的 emoji 表情符号
_EMOJI_PATTERN = re.compile(
    "["
    "\U0001F600-\U0001F64F"  # emoticons
    "\U0001F300-\U0001F5FF"  # symbols & pictographs
    "\U0001F680-\U0001F6FF"  # transport & map
    "\U0001F1E0-\U0001F1FF"  # flags
    "\U00002702-\U000027B0"  # dingbats
    "\U0001F900-\U0001F9FF"  # supplemental symbols
    "\U0001FA00-\U0001FA6F"  # chess symbols
    "\U0001FA70-\U0001FAFF"  # symbols extended
    "\U00002600-\U000026FF"  # misc symbols
    "\U0000FE00-\U0000FE0F"  # variation selectors
    "\U0000200D"             # zero width joiner
    "\U00002B50\U00002B55"   # stars
    "\U0000231A-\U0000231B"  # watch, hourglass
    "\U00002328"             # keyboard
    "\U000023CF"             # eject
    "\U000023E9-\U000023F3"  # various symbols
    "\U000023F8-\U000023FA"  # various symbols
    "\U000025AA-\U000025AB"  # squares
    "\U000025B6\U000025C0"   # play/reverse
    "\U000025FB-\U000025FE"  # squares
    "\U00002614-\U00002615"  # umbrella, coffee
    "\U00002648-\U00002653"  # zodiac
    "\U0000267F"             # wheelchair
    "\U00002693"             # anchor
    "\U000026A1"             # lightning
    "\U000026AA-\U000026AB"  # circles
    "\U000026BD-\U000026BE"  # soccer, baseball
    "\U000026C4-\U000026C5"  # snowman, sun
    "\U000026CE\U000026D4"   # ophiuchus, no entry
    "\U000026EA"             # church
    "\U000026F2-\U000026F3"  # fountain, golf
    "\U000026F5"             # sailboat
    "\U000026FA\U000026FD"   # tent, fuel pump
    "\U00002702\U00002705"   # scissors, check
    "\U00002708-\U0000270D"  # various
    "\U0000270F\U00002712"   # pencil, nib
    "\U00002714\U00002716"   # check, multiplication
    "\U0000271D\U00002721"   # cross, star of david
    "\U00002728"             # sparkles
    "\U00002733-\U00002734"  # asterisk
    "\U00002744\U00002747"   # snowflake, sparkle
    "\U0000274C\U0000274E"   # cross marks
    "\U00002753-\U00002755"  # question marks
    "\U00002757"             # exclamation
    "\U00002763-\U00002764"  # hearts
    "\U00002795-\U00002797"  # plus, minus, divide
    "\U000027A1"             # arrow
    "\U000027B0\U000027BF"   # loops
    "\U00002934-\U00002935"  # arrows
    "\U00002B05-\U00002B07"  # arrows
    "\U00002B1B-\U00002B1C"  # squares
    "\U00003030\U0000303D"   # wavy dash, part alternation
    "\U00003297\U00003299"   # circled ideographs
    "]+",
    flags=re.UNICODE,
)

# 常见装饰符号（非 emoji 但 AI 常用的）
_DECORATIVE_PATTERN = re.compile(r'[★●►▶◆◇■□▲△•·※✨❗✅❌⚡❤️➡️⬅️⬆️⬇️]')


def _clean_reply(text: str) -> str:
    """剥离 AI 回复中的 emoji、装饰符号和多余空白。"""
    text = _EMOJI_PATTERN.sub('', text)
    text = _DECORATIVE_PATTERN.sub('', text)
    text = re.sub(r'  +', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

MAX_HISTORY = 20

# Provider configurations
PROVIDER_CONFIG = {
    "deepseek": {
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "vision_model": "deepseek-v4-pro",
        "chat_model": "deepseek-chat",
        "input_price": 1.0,       # CNY per million tokens
        "output_price": 2.0,
        "max_tokens": 1024,
        "timeout": 30,
        "supports_vision": True,
        "default_temperature": 1.0,
    },
    "qwen": {
        "name": "通义千问",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "vision_model": "qwen-vl-max",
        "chat_model": "qwen-turbo",
        "input_price": 0.3,
        "output_price": 0.6,
        "max_tokens": 1024,
        "timeout": 30,
        "supports_vision": True,
        "default_temperature": 1.0,
    },
    "zhipu": {
        "name": "智谱AI",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "vision_model": "glm-4v",
        "chat_model": "glm-4-flash",
        "input_price": 0.1,
        "output_price": 0.1,
        "max_tokens": 1024,
        "timeout": 30,
        "supports_vision": True,
        "default_temperature": 0.7,
    },
    "kimi": {
        "name": "Kimi",
        "base_url": "https://api.moonshot.cn/v1",
        "vision_model": "moonshot-v1-8k-vision",
        "chat_model": "moonshot-v1-8k",
        "input_price": 12.0,
        "output_price": 12.0,
        "max_tokens": 1024,
        "timeout": 30,
        "supports_vision": True,
        "default_temperature": 0.7,
    },
    "openai": {
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "vision_model": "gpt-4o",
        "chat_model": "gpt-4o-mini",
        "input_price": 0.15,      # USD per million tokens
        "output_price": 0.60,
        "max_tokens": 4096,
        "timeout": 60,
        "supports_vision": True,
        "default_temperature": 1.0,
    },
}


def get_api_key_env_name(provider: str) -> str:
    """Return the environment variable name for a provider's API key."""
    env_map = {
        "deepseek": "DEEPSEEK_API_KEY",
        "qwen": "DASHSCOPE_API_KEY",
        "zhipu": "ZHIPU_API_KEY",
        "kimi": "KIMI_API_KEY",
        "openai": "OPENAI_API_KEY",
    }
    return env_map.get(provider, f"{provider.upper()}_API_KEY")


class TokenUsage:
    """Token usage accumulator"""
    def __init__(self, input_price: float = 1.0, output_price: float = 2.0):
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_calls = 0
        self.input_price = input_price
        self.output_price = output_price

    def add(self, prompt_tokens, completion_tokens):
        self.prompt_tokens += prompt_tokens
        self.completion_tokens += completion_tokens
        self.total_calls += 1

    def to_dict(self):
        total = self.prompt_tokens + self.completion_tokens
        cost = (self.prompt_tokens / 1_000_000 * self.input_price +
                self.completion_tokens / 1_000_000 * self.output_price)
        return {
            "total_calls": self.total_calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": total,
            "estimated_cost": round(cost, 6),
        }


class ChatService:
    """Multi-provider AI API wrapper with token tracking"""

    def __init__(self):
        # Resolve provider from environment (default: deepseek)
        provider = os.getenv("AI_PROVIDER", "deepseek").lower()
        if provider not in PROVIDER_CONFIG:
            logger.warning(f"Unknown provider '{provider}', falling back to deepseek")
            provider = "deepseek"

        config = PROVIDER_CONFIG[provider]
        self.provider = provider
        self.provider_name = config["name"]
        self.vision_model = config["vision_model"]
        self.chat_model = config["chat_model"]
        self.input_price = config["input_price"]
        self.output_price = config["output_price"]
        self.max_tokens = config["max_tokens"]
        self.timeout = config["timeout"]
        self.supports_vision = config["supports_vision"]
        self.default_temperature = config["default_temperature"]

        # Resolve API key
        env_key_name = get_api_key_env_name(provider)
        api_key = os.getenv(env_key_name, "")

        # Create OpenAI-compatible client (use placeholder if key is empty
        # so the client can be created; API calls will fail until a real key is set)
        self.client = OpenAI(
            api_key=api_key or "not-set",
            base_url=config["base_url"],
        )

        self.messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        self._vision_supported = None
        self.tokens = TokenUsage(self.input_price, self.output_price)

        logger.info(
            f"ChatService initialized: provider={self.provider_name} "
            f"chat={self.chat_model} vision={self.vision_model} "
            f"key={'set' if api_key else 'MISSING'} ({env_key_name})"
        )

    def _trim_history(self):
        if len(self.messages) > MAX_HISTORY + 1:
            self.messages = [self.messages[0]] + self.messages[-(MAX_HISTORY):]

    def _call_api(self, model, messages, max_tokens=None, timeout=None):
        if max_tokens is None:
            max_tokens = self.max_tokens
        if timeout is None:
            timeout = self.timeout
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
            resp = self._call_api(self.chat_model, self.messages)
            reply = resp.choices[0].message.content
            reply = _clean_reply(reply)
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
            resp = self._call_api(self.vision_model, self.messages)
            reply = resp.choices[0].message.content
            reply = _clean_reply(reply)
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

            # Detect vision-capability failures across providers:
            #   - "unknown variant" / "image_url" : provider doesn't accept image_url content type
            #   - "not supported" / "not support"  : model doesn't support vision
            #   - 404 / "model_not_found"           : vision model doesn't exist
            #   - "invalid_request" + "image"       : provider rejects image content
            vision_fail = any(kw in err_str for kw in (
                "unknown variant", "image_url",
                "not supported", "not support",
                "model_not_found", "model not found",
                "404", "does not exist",
                "invalid_request", "invalid model",
            ))

            if vision_fail:
                logger.warning(
                    f"[chat_with_image] vision not supported for {self.provider}/{self.vision_model}, "
                    f"falling back to text-only ({elapsed:.2f}s): {str(e)[:100]}"
                )
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
            resp = self._call_api(self.chat_model, self.messages)
            reply = resp.choices[0].message.content
            reply = _clean_reply(reply)
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

    def get_provider_info(self) -> dict:
        """Return current provider details and usage stats."""
        return {
            "provider": self.provider,
            "provider_name": self.provider_name,
            "chat_model": self.chat_model,
            "vision_model": self.vision_model,
            "supports_vision": self.supports_vision,
            "max_tokens": self.max_tokens,
            "timeout": self.timeout,
            "input_price": self.input_price,
            "output_price": self.output_price,
            "tokens": self.tokens.to_dict(),
        }

    def test_connection(self) -> dict:
        """Send a minimal chat request to verify API connectivity."""
        env_key_name = get_api_key_env_name(self.provider)
        api_key = os.getenv(env_key_name, "")
        if not api_key:
            return {
                "ok": False,
                "error": f"API key not set: {env_key_name}",
                "provider": self.provider_name,
            }

        try:
            resp = self.client.chat.completions.create(
                model=self.chat_model,
                messages=[{"role": "user", "content": "Hi"}],
                max_tokens=5,
                timeout=10,
            )
            reply = resp.choices[0].message.content or ""
            return {
                "ok": True,
                "provider": self.provider_name,
                "model": self.chat_model,
                "reply_preview": reply[:50],
            }
        except Exception as e:
            return {
                "ok": False,
                "provider": self.provider_name,
                "model": self.chat_model,
                "error": str(e),
            }
