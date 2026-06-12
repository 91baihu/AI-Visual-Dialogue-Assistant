"""
DeepSeek API test script
Usage: cd backend && python test_api.py
"""
import os
import sys
import time
import base64
import io

# Fix Windows console encoding
sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
load_dotenv()

api_key = os.getenv("DEEPSEEK_API_KEY", "")
if not api_key or api_key == "your_key_here":
    print("ERROR: set DEEPSEEK_API_KEY in .env first")
    sys.exit(1)

print(f"API Key: {api_key[:8]}...{api_key[-4:]}")
print("=" * 50)

from ai_service import ChatService

PASS = 0
FAIL = 0

def result(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}")
    if detail:
        print(f"        {detail}")


# ---------- Test 1: Text chat ----------
print("\n[TEST 1] Text chat")
print("-" * 40)

svc1 = ChatService()
start = time.time()
try:
    reply1 = svc1.chat("Hello, introduce yourself briefly")
    elapsed1 = time.time() - start
    result("text chat", len(reply1) > 0, f"{elapsed1:.2f}s, {len(reply1)} chars")
    print(f"  reply: {reply1[:80]}...")
except Exception as e:
    elapsed1 = time.time() - start
    result("text chat", False, f"{elapsed1:.2f}s: {e}")


# ---------- Test 2: Multi-turn context ----------
print("\n[TEST 2] Multi-turn context")
print("-" * 40)

svc2 = ChatService()
start = time.time()
try:
    r1 = svc2.chat("My name is Alice")
    r2 = svc2.chat("What is my name?")
    elapsed2 = time.time() - start
    has_name = "alice" in r2.lower()
    result("context preserved", has_name, f"{elapsed2:.2f}s")
    print(f"  reply1: {r1[:60]}...")
    print(f"  reply2: {r2[:60]}...")
except Exception as e:
    elapsed2 = time.time() - start
    result("context preserved", False, f"{elapsed2:.2f}s: {e}")


# ---------- Test 3: Image + text ----------
print("\n[TEST 3] Image + text (with fallback)")
print("-" * 40)

try:
    from PIL import Image

    img = Image.new("RGB", (100, 100), color=(255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    img_b64 = base64.b64encode(buf.getvalue()).decode()
    print(f"  test image: red 100x100, base64={len(img_b64)} chars")

    svc3 = ChatService()
    start = time.time()
    reply3 = svc3.chat_with_image("Please describe this image", img_b64)
    elapsed3 = time.time() - start
    result("image+text", len(reply3) > 0, f"{elapsed3:.2f}s, {len(reply3)} chars")
    print(f"  reply: {reply3[:80]}...")

except ImportError:
    result("image+text", False, "Pillow not installed")
except Exception as e:
    elapsed3 = time.time() - start
    result("image+text", False, f"{elapsed3:.2f}s: {e}")


# ---------- Test 4: Image with data URI prefix ----------
print("\n[TEST 4] Image with data URI prefix")
print("-" * 40)

try:
    from PIL import Image

    img = Image.new("RGB", (50, 50), color=(0, 128, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    img_b64_prefix = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    svc4 = ChatService()
    start = time.time()
    reply4 = svc4.chat_with_image("What color is this?", img_b64_prefix)
    elapsed4 = time.time() - start
    result("data URI prefix", len(reply4) > 0, f"{elapsed4:.2f}s, {len(reply4)} chars")
    print(f"  reply: {reply4[:80]}...")

except Exception as e:
    elapsed4 = time.time() - start
    result("data URI prefix", False, f"{elapsed4:.2f}s: {e}")


# ---------- Test 5: History trim ----------
print("\n[TEST 5] History trim (20 messages max)")
print("-" * 40)

svc5 = ChatService()
try:
    for i in range(12):
        svc5.chat(f"Message {i+1}")
    hist_len = len(svc5.messages)
    trimmed = hist_len <= 21  # 1 system + 20 max
    result("history trimmed", trimmed, f"messages in history: {hist_len}")
except Exception as e:
    result("history trimmed", False, str(e))


# ---------- Summary ----------
print("\n" + "=" * 50)
print(f"Results: {PASS} passed, {FAIL} failed")
print("=" * 50)
if FAIL:
    sys.exit(1)
