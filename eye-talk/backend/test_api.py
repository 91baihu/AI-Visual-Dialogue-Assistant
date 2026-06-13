"""
EyeTalk API test script — ChatService + HTTP endpoint tests
Usage: cd backend && python test_api.py
"""
import os
import sys
import time
import json
import base64
import io

# Fix Windows console encoding
sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
load_dotenv()

PASS = 0
FAIL = 0
SKIP = 0


def result(name, ok, detail="", skip=False):
    global PASS, FAIL, SKIP
    if skip:
        SKIP += 1
        print(f"  SKIP  {name}")
    elif ok:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}")
    if detail:
        print(f"        {detail}")


# ============================================================
#  Part A: Direct ChatService tests
# ============================================================
print("\n" + "=" * 50)
print("  Part A: ChatService direct tests")
print("=" * 50)

from ai_service import ChatService, PROVIDER_CONFIG, get_api_key_env_name


# ---------- A1: Provider config completeness ----------
print("\n[A1] Provider config completeness")
print("-" * 40)

required_keys = {"name", "base_url", "vision_model", "chat_model",
                 "input_price", "output_price", "max_tokens", "timeout",
                 "supports_vision", "default_temperature"}
for provider, cfg in PROVIDER_CONFIG.items():
    missing = required_keys - set(cfg.keys())
    result(f"{provider} config has all keys", len(missing) == 0,
           f"missing: {missing}" if missing else "")


# ---------- A2: get_api_key_env_name ----------
print("\n[A2] get_api_key_env_name")
print("-" * 40)

expected_env = {
    "deepseek": "DEEPSEEK_API_KEY",
    "qwen": "DASHSCOPE_API_KEY",
    "zhipu": "ZHIPU_API_KEY",
    "kimi": "KIMI_API_KEY",
    "openai": "OPENAI_API_KEY",
}
for provider, expected in expected_env.items():
    got = get_api_key_env_name(provider)
    result(f"{provider} -> {expected}", got == expected, f"got: {got}")

# Fallback for unknown provider
got_unknown = get_api_key_env_name("foobar")
result("unknown provider fallback", got_unknown == "FOOBAR_API_KEY", f"got: {got_unknown}")


# ---------- A3: ChatService init with env ----------
print("\n[A3] ChatService init")
print("-" * 40)

provider = os.getenv("AI_PROVIDER", "deepseek")
env_key = get_api_key_env_name(provider)
api_key = os.getenv(env_key, "")
has_key = bool(api_key and api_key != "your_key_here")

svc = ChatService()
result("provider resolved", svc.provider == provider,
       f"expected={provider}, got={svc.provider}")
result("provider_name set", len(svc.provider_name) > 0, svc.provider_name)
result("chat_model set", len(svc.chat_model) > 0, svc.chat_model)
result("vision_model set", len(svc.vision_model) > 0, svc.vision_model)
result("max_tokens > 0", svc.max_tokens > 0, str(svc.max_tokens))
result("timeout > 0", svc.timeout > 0, str(svc.timeout))


# ---------- A4: get_provider_info ----------
print("\n[A4] get_provider_info")
print("-" * 40)

info = svc.get_provider_info()
result("returns dict", isinstance(info, dict))
result("has provider key", "provider" in info)
result("has tokens key", "tokens" in info)
result("tokens is dict", isinstance(info.get("tokens"), dict))


# ---------- A5: test_connection ----------
print("\n[A5] test_connection")
print("-" * 40)

if has_key:
    conn = svc.test_connection()
    result("returns ok key", "ok" in conn)
    result("returns provider", "provider" in conn)
    if conn["ok"]:
        result("connection works", True, conn.get("reply_preview", "")[:50])
    else:
        result("connection works", False, conn.get("error", ""))
else:
    conn = svc.test_connection()
    result("missing key detected", not conn["ok"],
           conn.get("error", ""))


# ---------- A6: Text chat ----------
print("\n[A6] Text chat")
print("-" * 40)

if has_key:
    start = time.time()
    try:
        reply = svc.chat("Hello, introduce yourself briefly")
        elapsed = time.time() - start
        result("text chat", len(reply) > 0, f"{elapsed:.2f}s, {len(reply)} chars")
        print(f"  reply: {reply[:80]}...")
    except Exception as e:
        elapsed = time.time() - start
        result("text chat", False, f"{elapsed:.2f}s: {e}")
else:
    result("text chat", False, skip=True, detail="no API key")


# ---------- A7: Multi-turn context ----------
print("\n[A7] Multi-turn context")
print("-" * 40)

if has_key:
    svc_ctx = ChatService()
    start = time.time()
    try:
        r1 = svc_ctx.chat("My name is Alice")
        r2 = svc_ctx.chat("What is my name?")
        elapsed = time.time() - start
        has_name = "alice" in r2.lower()
        result("context preserved", has_name, f"{elapsed:.2f}s")
    except Exception as e:
        elapsed = time.time() - start
        result("context preserved", False, f"{elapsed:.2f}s: {e}")
else:
    result("context preserved", False, skip=True, detail="no API key")


# ---------- A8: Image + text ----------
print("\n[A8] Image + text (with fallback)")
print("-" * 40)

if has_key:
    try:
        from PIL import Image
        img = Image.new("RGB", (100, 100), color=(255, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        img_b64 = base64.b64encode(buf.getvalue()).decode()

        svc_img = ChatService()
        start = time.time()
        reply_img = svc_img.chat_with_image("Please describe this image", img_b64)
        elapsed = time.time() - start
        result("image+text", len(reply_img) > 0, f"{elapsed:.2f}s, {len(reply_img)} chars")
    except ImportError:
        result("image+text", False, "Pillow not installed")
    except Exception as e:
        elapsed = time.time() - start
        result("image+text", False, f"{elapsed:.2f}s: {e}")
else:
    result("image+text", False, skip=True, detail="no API key")


# ---------- A9: Image with data URI prefix ----------
print("\n[A9] Image with data URI prefix")
print("-" * 40)

if has_key:
    try:
        from PIL import Image
        img = Image.new("RGB", (50, 50), color=(0, 128, 255))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        img_b64_prefix = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

        svc_uri = ChatService()
        start = time.time()
        reply_uri = svc_uri.chat_with_image("What color is this?", img_b64_prefix)
        elapsed = time.time() - start
        result("data URI prefix", len(reply_uri) > 0, f"{elapsed:.2f}s, {len(reply_uri)} chars")
    except Exception as e:
        elapsed = time.time() - start
        result("data URI prefix", False, f"{elapsed:.2f}s: {e}")
else:
    result("data URI prefix", False, skip=True, detail="no API key")


# ---------- A10: History trim ----------
print("\n[A10] History trim (20 messages max)")
print("-" * 40)

if has_key:
    svc_trim = ChatService()
    try:
        for i in range(12):
            svc_trim.chat(f"Message {i+1}")
        hist_len = len(svc_trim.messages)
        trimmed = hist_len <= 21  # 1 system + 20 max
        result("history trimmed", trimmed, f"messages in history: {hist_len}")
    except Exception as e:
        result("history trimmed", False, str(e))
else:
    result("history trimmed", False, skip=True, detail="no API key")


# ============================================================
#  Part B: HTTP endpoint tests
# ============================================================
print("\n" + "=" * 50)
print("  Part B: HTTP endpoint tests")
print("=" * 50)

import httpx

BASE_URL = "http://127.0.0.1:8000"


def _api(method, path, **kwargs):
    """Helper to call API endpoints."""
    url = f"{BASE_URL}{path}"
    try:
        with httpx.Client(timeout=15) as client:
            resp = getattr(client, method)(url, **kwargs)
            return resp.status_code, resp.json()
    except httpx.ConnectError:
        return 0, {"error": "connection refused — is the server running?"}
    except Exception as e:
        return 0, {"error": str(e)}


# ---------- B1: Health check ----------
print("\n[B1] GET /api/health")
print("-" * 40)

code, body = _api("get", "/api/health")
result("health 200", code == 200, f"code={code}")
if code == 200:
    result("has provider field", "provider" in body, body.get("provider", ""))
    result("has api_key_configured", "api_key_configured" in body)


# ---------- B2: GET /api/config ----------
print("\n[B2] GET /api/config")
print("-" * 40)

code, body = _api("get", "/api/config")
result("config 200", code == 200, f"code={code}")
if code == 200:
    result("has provider", "provider" in body, body.get("provider", ""))
    result("has provider_name", "provider_name" in body, body.get("provider_name", ""))
    result("has chat_model", "chat_model" in body, body.get("chat_model", ""))
    result("has vision_model", "vision_model" in body, body.get("vision_model", ""))
    result("has supports_vision (bool)", isinstance(body.get("supports_vision"), bool),
           str(body.get("supports_vision")))
    result("has configured dict", isinstance(body.get("configured"), dict))
    result("has connection_ok", "connection_ok" in body)
    result("has connection_reason", "connection_reason" in body)

    # All known providers should be in configured
    for p in PROVIDER_CONFIG:
        result(f"configured has {p}", p in body.get("configured", {}))

    # configured values should be bool
    for p, val in body.get("configured", {}).items():
        result(f"  {p} value is bool", isinstance(val, bool))


# ---------- B3: POST /api/config — valid key ----------
print("\n[B3] POST /api/config — valid deepseek key")
print("-" * 40)

test_key = os.getenv("DEEPSEEK_API_KEY", "")
if test_key and test_key != "your_key_here":
    code, body = _api("post", "/api/config", json={
        "provider": "deepseek",
        "api_key": test_key,
    })
    result("returns 200", code == 200, f"code={code}")
    if code == 200:
        result("success=true", body.get("success") is True)
        result("has provider", body.get("provider") == "deepseek")
        result("has provider_name", "provider_name" in body)
        result("has chat_model", "chat_model" in body)
        result("has vision_model", "vision_model" in body)
else:
    result("valid key test", False, skip=True, detail="no DEEPSEEK_API_KEY set")


# ---------- B4: POST /api/config — empty key (validation) ----------
print("\n[B4] POST /api/config — empty API key")
print("-" * 40)

code, body = _api("post", "/api/config", json={
    "provider": "deepseek",
    "api_key": "",
})
# Pydantic validation returns 422
result("rejects empty key", code == 422, f"code={code}")


# ---------- B5: POST /api/config — short key (validation) ----------
print("\n[B5] POST /api/config — short API key")
print("-" * 40)

code, body = _api("post", "/api/config", json={
    "provider": "deepseek",
    "api_key": "short",
})
result("rejects short key", code == 422, f"code={code}")


# ---------- B6: POST /api/config — invalid provider ----------
print("\n[B6] POST /api/config — invalid provider name")
print("-" * 40)

code, body = _api("post", "/api/config", json={
    "provider": "nonexistent",
    "api_key": "sk-1234567890abcdef",
})
result("rejects invalid provider", code == 422, f"code={code}")


# ---------- B7: POST /api/config — invalid key (test mode) ----------
print("\n[B7] POST /api/config — invalid key with test")
print("-" * 40)

code, body = _api("post", "/api/config", json={
    "provider": "deepseek",
    "api_key": "sk-00000000000000000000000000000000",
})
# Should return 200 with success=False (key validation always runs)
if code == 200:
    result("rejects invalid key (success=false)", body.get("success") is False,
           body.get("message", ""))
    result("has message", "message" in body and len(body["message"]) > 0,
           body.get("message", "")[:60])
else:
    result("rejects invalid key (success=false)", False,
           f"expected 200, got {code}")


# ---------- B8: POST /api/config — switch & verify each provider ----------
print("\n[B8] POST /api/config — provider switch & response fields")
print("-" * 40)

# Save original provider to restore later
orig_provider = os.getenv("AI_PROVIDER", "deepseek")
orig_key = os.getenv(get_api_key_env_name(orig_provider), "")

# Try switching to each provider that has a key configured
for test_prov in PROVIDER_CONFIG:
    env_name = get_api_key_env_name(test_prov)
    key = os.getenv(env_name, "")
    if not key or key == "your_key_here":
        result(f"switch to {test_prov}", False, skip=True, detail="no key configured")
        continue

    code, body = _api("post", "/api/config", json={
        "provider": test_prov,
        "api_key": key,
    })
    result(f"POST {test_prov} returns 200", code == 200, f"code={code}")
    if code == 200 and body.get("success"):
        result(f"  success=true", body.get("success") is True)
        result(f"  provider={test_prov}", body.get("provider") == test_prov)
        result(f"  has provider_name", len(body.get("provider_name", "")) > 0,
               body.get("provider_name", ""))
        result(f"  has chat_model", len(body.get("chat_model", "")) > 0,
               body.get("chat_model", ""))
        result(f"  has vision_model", len(body.get("vision_model", "")) > 0,
               body.get("vision_model", ""))
        # Verify GET /api/config reflects the switch
        g_code, g_body = _api("get", "/api/config")
        if g_code == 200:
            result(f"  GET confirms provider={test_prov}",
                   g_body.get("provider") == test_prov,
                   f"got: {g_body.get('provider')}")
            result(f"  GET confirms provider_name",
                   g_body.get("provider_name") == body.get("provider_name"))
    elif code == 200:
        result(f"  success=true", False, body.get("message", ""))
    else:
        result(f"switch to {test_prov}", False, body.get("message", f"code={code}"))

# Restore original provider
if orig_key and orig_key != "your_key_here":
    _api("post", "/api/config", json={
        "provider": orig_provider,
        "api_key": orig_key,
    })


# ---------- B9: POST /api/config — test parameter ----------
print("\n[B9] POST /api/config — test parameter behavior")
print("-" * 40)

# The API always tests the key regardless of test param
code, body = _api("post", "/api/config", json={
    "provider": "deepseek",
    "api_key": "sk-00000000000000000000000000000000",
    "test": True,
})
if code == 200:
    result("test=true rejects invalid key", body.get("success") is False,
           body.get("message", "")[:60])

code2, body2 = _api("post", "/api/config", json={
    "provider": "deepseek",
    "api_key": "sk-00000000000000000000000000000000",
    "test": False,
})
if code2 == 200:
    result("test=false still tests key", body2.get("success") is False,
           body2.get("message", "")[:60])


# ---------- B10: GET /api/stats ----------
print("\n[B10] GET /api/stats")
print("-" * 40)

code, body = _api("get", "/api/stats")
result("stats 200", code == 200, f"code={code}")
if code == 200:
    result("has total_calls", "total_calls" in body)
    result("has total_tokens", "total_tokens" in body)
    result("has estimated_cost", "estimated_cost" in body)


# ---------- Summary ----------
print("\n" + "=" * 50)
print(f"  Results: {PASS} passed, {FAIL} failed, {SKIP} skipped")
print("=" * 50)
if FAIL:
    sys.exit(1)
