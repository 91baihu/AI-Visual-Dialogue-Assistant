// ============================================================
//  EyeTalk — AI视觉对话助手 · 前端逻辑
// ============================================================

const WS_URL = "ws://localhost:8000/ws";
const AI_TIMEOUT = 15000;
const RECONNECT_INTERVAL = 3000;
const AUTO_SAMPLE_INTERVAL = 2000;
const FRAME_DIFF_THRESHOLD = 15;
const COST_WARN_THRESHOLD = 5.0;

// Quick command presets
const QUICK_COMMANDS = {
  ocr:        "请识别图片中的所有文字，保持原始排版",
  translate:  "请识别图片中的文字，如果是外文请翻译成中文",
  objects:    "请识别图片中的主要物体，给出名称和简要介绍",
  scene:      "请详细描述这个场景，包括环境、人物、物品等",
};

// ==================== DOM ====================
const videoEl          = document.getElementById("videoEl");
const canvasEl         = document.getElementById("canvasEl");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const cameraState      = document.getElementById("cameraState");
const btnStartCam      = document.getElementById("btnStartCam");
const btnStopCam       = document.getElementById("btnStopCam");
const messagesDiv      = document.getElementById("messages");
const textInput        = document.getElementById("textInput");
const btnSend          = document.getElementById("btnSend");
const btnVoice         = document.getElementById("btnVoice");
const voicePulse       = document.getElementById("voicePulse");
const interimBar       = document.getElementById("interimBar");
const interimText      = document.getElementById("interimText");
const wsStatusEl       = document.getElementById("wsStatus");
const btnClear         = document.getElementById("btnClear");
const btnReconnect     = document.getElementById("btnReconnect");
const toggleAutoMode   = document.getElementById("toggleAutoMode");
const autoStatus       = document.getElementById("autoStatus");
const autoStatusText   = autoStatus.querySelector(".auto-status-text");
const autoHint         = document.getElementById("autoHint");
const statCalls        = document.getElementById("statCalls");
const statTokens       = document.getElementById("statTokens");
const statCost         = document.getElementById("statCost");
const statsBar         = document.getElementById("statsBar");
const liveBadge        = document.getElementById("liveBadge");
const quickActions     = document.getElementById("quickActions");

// ==================== State ====================
let ws = null;
let cameraStream = null;
let recognition = null;
let isRecording = false;
let aiTimeoutTimer = null;
let reconnectTimer = null;
let shouldReconnect = true;
let autoMode = false;
let autoSampleTimer = null;
let prevFrameData = null;
let isAutoSending = false;
let lastAIReply = ""; // for screenshot feature

// ==================== Utils ====================
function scrollToBottom() {
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ==================== Messages (with avatars) ====================
function addMessage(role, content) {
  const wrapper = document.createElement("div");
  wrapper.className = `msg msg-${role}`;

  if (role === "system") {
    const bubble = document.createElement("div");
    bubble.className = "bubble bubble-system";
    bubble.textContent = content;
    wrapper.appendChild(bubble);
  } else if (role === "user") {
    const bubble = document.createElement("div");
    bubble.className = "bubble bubble-user";
    bubble.textContent = content;
    const avatar = document.createElement("div");
    avatar.className = "avatar avatar-user";
    avatar.textContent = "👤";
    wrapper.appendChild(bubble);
    wrapper.appendChild(avatar);
  } else if (role === "ai") {
    const avatar = document.createElement("div");
    avatar.className = "avatar avatar-ai";
    avatar.textContent = "🤖";
    const bubble = document.createElement("div");
    bubble.className = "bubble bubble-ai";
    bubble.innerHTML = content;
    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
  }

  messagesDiv.appendChild(wrapper);
  scrollToBottom();
  return wrapper;
}

function showThinking() {
  removeThinking();
  const wrapper = document.createElement("div");
  wrapper.className = "msg msg-ai";
  wrapper.id = "thinkingMsg";
  const avatar = document.createElement("div");
  avatar.className = "avatar avatar-ai";
  avatar.textContent = "🤖";
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble-ai";
  bubble.innerHTML = `
    <div class="thinking">
      <span>思考中</span>
      <span class="thinking-dots"><span></span><span></span><span></span></span>
    </div>
  `;
  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  messagesDiv.appendChild(wrapper);
  scrollToBottom();
  aiTimeoutTimer = setTimeout(() => {
    removeThinking();
    addMessage("system", "⏰ AI 思考超时，请重试");
  }, AI_TIMEOUT);
}

function removeThinking() {
  const el = document.getElementById("thinkingMsg");
  if (el) el.remove();
  if (aiTimeoutTimer) { clearTimeout(aiTimeoutTimer); aiTimeoutTimer = null; }
}

function addSpeakingIndicator(bubbleEl) {
  const indicator = document.createElement("span");
  indicator.className = "speaking-indicator";
  indicator.innerHTML = `<span class="speaking-bar"></span><span class="speaking-bar"></span><span class="speaking-bar"></span><span class="speaking-bar"></span>`;
  bubbleEl.appendChild(indicator);
  return indicator;
}

function removeSpeakingIndicator(el) { if (el) el.remove(); }

// ==================== Camera ====================
btnStartCam.addEventListener("click", async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    videoEl.srcObject = cameraStream;
    videoEl.classList.add("active");
    videoPlaceholder.classList.add("hidden");
    cameraState.textContent = "运行中";
    cameraState.classList.add("active");
    liveBadge.classList.add("active");
    btnStartCam.disabled = true;
    btnStopCam.disabled = false;
    prevFrameData = null;
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      addMessage("system", "📷 摄像头权限被拒绝，请在浏览器地址栏点击🔒图标允许摄像头权限");
    } else if (err.name === "NotFoundError") {
      addMessage("system", "📷 未检测到摄像头设备");
    } else {
      addMessage("system", "📷 无法访问摄像头: " + err.message);
    }
  }
});

btnStopCam.addEventListener("click", stopCamera);

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  videoEl.srcObject = null;
  videoEl.classList.remove("active");
  videoPlaceholder.classList.remove("hidden");
  cameraState.textContent = "未开启";
  cameraState.classList.remove("active");
  liveBadge.classList.remove("active");
  btnStartCam.disabled = false;
  btnStopCam.disabled = true;
  prevFrameData = null;
  if (autoMode) stopAutoMode();
}

// ==================== Frame Capture & Diff ====================
function captureFrame() {
  if (!cameraStream) return { base64: null, imageData: null };
  canvasEl.width = videoEl.videoWidth;
  canvasEl.height = videoEl.videoHeight;
  const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
  const base64 = canvasEl.toDataURL("image/jpeg", 0.8);
  return { base64, imageData };
}

function calcMSE(data1, data2) {
  if (!data1 || !data2) return Infinity;
  if (data1.data.length !== data2.data.length) return Infinity;
  const px1 = data1.data;
  const px2 = data2.data;
  let sum = 0;
  let count = 0;
  const step = 16;
  for (let i = 0; i < px1.length; i += step) {
    const dr = px1[i] - px2[i];
    const dg = px1[i+1] - px2[i+1];
    const db = px1[i+2] - px2[i+2];
    sum += dr*dr + dg*dg + db*db;
    count++;
  }
  return sum / count / 3;
}

function captureFrameSmart() {
  const { base64, imageData } = captureFrame();
  if (!base64) return null;
  const mse = calcMSE(prevFrameData, imageData);
  if (mse < FRAME_DIFF_THRESHOLD) return null;
  prevFrameData = imageData;
  return base64;
}

// ==================== Auto Mode ====================
toggleAutoMode.addEventListener("change", () => {
  if (toggleAutoMode.checked) startAutoMode();
  else stopAutoMode();
});

function startAutoMode() {
  if (!cameraStream) {
    addMessage("system", "📷 请先开启摄像头再启用自动观察模式");
    toggleAutoMode.checked = false;
    return;
  }
  autoMode = true;
  autoStatus.classList.add("active");
  autoStatusText.textContent = "采样中";
  autoHint.textContent = "每2秒检测画面变化";
  prevFrameData = null;
  autoSampleTimer = setInterval(autoSampleTick, AUTO_SAMPLE_INTERVAL);
  addMessage("system", "🔍 自动观察模式已开启，AI 将持续关注画面变化");
}

function stopAutoMode() {
  autoMode = false;
  if (autoSampleTimer) { clearInterval(autoSampleTimer); autoSampleTimer = null; }
  autoStatus.classList.remove("active", "change");
  toggleAutoMode.checked = false;
  autoHint.textContent = "AI将持续观察画面变化";
}

function autoSampleTick() {
  if (!cameraStream || isAutoSending) return;
  const base64 = captureFrameSmart();
  if (!base64) {
    autoStatus.classList.remove("change");
    autoStatusText.textContent = "静止";
    return;
  }
  autoStatus.classList.add("change");
  autoStatusText.textContent = "检测到变化";
  isAutoSending = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    showThinking();
    ws.send(JSON.stringify({ type: "chat", text: "请描述当前画面的变化", image: base64 }));
  } else {
    isAutoSending = false;
  }
}

// ==================== WebSocket ====================
function connectWS() {
  if (ws) {
    shouldReconnect = false;
    ws.close();
    ws = null;
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  shouldReconnect = true;
  wsStatusEl.textContent = "🟡 连接中...";
  wsStatusEl.classList.remove("connected");

  try { ws = new WebSocket(WS_URL); }
  catch { wsStatusEl.textContent = "🔴 连接失败"; scheduleReconnect(); return; }

  ws.onopen = () => {
    wsStatusEl.textContent = "🟢 已连接";
    wsStatusEl.classList.add("connected");
    const sysMsgs = messagesDiv.querySelectorAll(".msg-system .bubble-system");
    sysMsgs.forEach((el) => {
      if (el.textContent.includes("服务未启动") || el.textContent.includes("连接已断开")) {
        el.closest(".msg").remove();
      }
    });
  };

  ws.onmessage = (event) => {
    removeThinking();
    isAutoSending = false;
    try {
      const data = JSON.parse(event.data);
      if (data.type === "reply") {
        const wrapper = addMessage("ai", data.text);
        lastAIReply = data.text;
        const bubble = wrapper.querySelector(".bubble-ai");
        speakText(data.text, bubble);
        if (data.usage) updateStats(data.usage);
      } else {
        const wrapper = addMessage("ai", data.text || event.data);
        const bubble = wrapper.querySelector(".bubble-ai");
        speakText(data.text || event.data, bubble);
      }
    } catch {
      const wrapper = addMessage("ai", event.data);
      const bubble = wrapper.querySelector(".bubble-ai");
      speakText(event.data, bubble);
    }
  };

  ws.onclose = () => {
    wsStatusEl.textContent = "🔴 已断开";
    wsStatusEl.classList.remove("connected");
    isAutoSending = false;
    if (shouldReconnect) scheduleReconnect();
  };

  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shouldReconnect) connectWS();
  }, RECONNECT_INTERVAL);
}

btnReconnect.addEventListener("click", () => {
  addMessage("system", "🔄 正在重新连接...");
  connectWS();
});

// Send message
function sendMessage(text, imageBase64) {
  if (!text || !text.trim()) return;
  if (imageBase64 === undefined) {
    imageBase64 = cameraStream ? captureFrameSmart() : null;
  }
  const userLabel = imageBase64 ? `📸 ${text}` : text;
  addMessage("user", userLabel);
  showThinking();
  const payload = { type: "chat", text: text.trim() };
  if (imageBase64) payload.image = imageBase64;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    removeThinking();
    addMessage("system", "⚠️ 服务未启动，请先启动后端（python main.py），然后点击「🔄 重连」");
  }
}

// ==================== Quick Actions ====================
quickActions.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const cmd = chip.dataset.cmd;

  if (cmd === "screenshot") {
    doScreenshot();
    return;
  }

  const preset = QUICK_COMMANDS[cmd];
  if (!preset) return;

  if (!cameraStream) {
    addMessage("system", "📷 请先开启摄像头再使用快捷指令");
    return;
  }

  const imageBase64 = captureFrame();
  if (imageBase64.base64) {
    sendMessage(preset, imageBase64.base64);
  } else {
    sendMessage(preset);
  }
});

function doScreenshot() {
  const { base64 } = captureFrame();
  if (!base64) {
    addMessage("system", "📷 无画面可截图，请先开启摄像头");
    return;
  }

  // Create a canvas to combine frame + AI reply
  const img = new Image();
  img.onload = () => {
    const padding = 20;
    const textHeight = lastAIReply ? 80 : 0;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height + textHeight + padding * 2;
    const ctx = c.getContext("2d");

    // Background
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, c.width, c.height);

    // Draw frame
    ctx.drawImage(img, 0, 0);

    // Draw AI reply text
    if (lastAIReply) {
      ctx.fillStyle = "#e2e2e8";
      ctx.font = "16px sans-serif";
      const clean = lastAIReply.replace(/<[^>]*>/g, "");
      const y = img.height + padding + 20;
      const maxWidth = c.width - padding * 2;
      let line = "";
      let lineY = y;
      for (const char of clean) {
        const test = line + char;
        if (ctx.measureText(test).width > maxWidth) {
          ctx.fillText(line, padding, lineY);
          line = char;
          lineY += 22;
          if (lineY > c.height - 10) break;
        } else {
          line = test;
        }
      }
      if (lineY <= c.height - 10) ctx.fillText(line, padding, lineY);
    }

    // Download
    const link = document.createElement("a");
    link.download = `eyetalk-screenshot-${Date.now()}.png`;
    link.href = c.toDataURL("image/png");
    link.click();
    addMessage("system", "💾 截图已保存");
  };
  img.src = base64;
}

// ==================== Send & Enter ====================
btnSend.addEventListener("click", () => { sendMessage(textInput.value); textInput.value = ""; });

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(textInput.value);
    textInput.value = "";
  }
});

// ==================== Clear ====================
btnClear.addEventListener("click", () => {
  messagesDiv.innerHTML = "";
  addMessage("system", "对话已清空");
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "clear" }));
});

// ==================== Stats ====================
function updateStats(usage) {
  statCalls.textContent = usage.total_calls;
  statTokens.textContent = usage.total_tokens.toLocaleString();
  statCost.textContent = usage.estimated_cost.toFixed(3);
  if (usage.estimated_cost >= COST_WARN_THRESHOLD) statsBar.classList.add("warn");
  else statsBar.classList.remove("warn");
}

async function fetchStats() {
  try {
    const resp = await fetch("http://localhost:8000/api/stats");
    if (resp.ok) updateStats(await resp.json());
  } catch {}
}

setInterval(fetchStats, 5000);
fetchStats();

// ==================== Speech Recognition ====================
function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !navigator.mediaDevices) {
    btnVoice.style.display = "none";
    return;
  }

  recognition = new SR();
  recognition.lang = "zh-CN";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interim = "", final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += t;
      else interim += t;
    }
    if (interim) { interimBar.classList.add("active"); interimText.textContent = interim; }
    if (final) { interimBar.classList.remove("active"); interimText.textContent = ""; sendMessage(final); }
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed") { addMessage("system", "🎤 麦克风权限被拒绝"); btnVoice.style.display = "none"; }
    else if (event.error !== "no-speech") console.warn("语音识别错误:", event.error);
    stopRecording();
  };

  recognition.onend = () => stopRecording();
}

function startRecording() {
  if (!recognition || isRecording) return;
  isRecording = true;
  btnVoice.classList.add("recording");
  btnVoice.querySelector(".voice-label").textContent = "松开结束";
  try { recognition.start(); } catch { stopRecording(); }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  btnVoice.classList.remove("recording");
  btnVoice.querySelector(".voice-label").textContent = "按住说话";
  interimBar.classList.remove("active");
  interimText.textContent = "";
  if (recognition) try { recognition.stop(); } catch {}
}

btnVoice.addEventListener("mousedown", (e) => { e.preventDefault(); startRecording(); });
btnVoice.addEventListener("mouseup",   (e) => { e.preventDefault(); stopRecording();  });
btnVoice.addEventListener("mouseleave",(e) => { if (isRecording) stopRecording();     });
btnVoice.addEventListener("touchstart",(e) => { e.preventDefault(); startRecording(); });
btnVoice.addEventListener("touchend",  (e) => { e.preventDefault(); stopRecording();  });

// ==================== TTS ====================
function speakText(text, bubbleEl) {
  if (!("speechSynthesis" in window)) return;
  const clean = text.replace(/<[^>]*>/g, "").trim();
  if (!clean) return;
  const utter = new SpeechSynthesisUtterance(clean);
  utter.lang = "zh-CN";
  utter.rate = 1.0;
  let indicator = null;
  utter.onstart = () => { indicator = addSpeakingIndicator(bubbleEl); };
  utter.onend = () => removeSpeakingIndicator(indicator);
  utter.onerror = () => removeSpeakingIndicator(indicator);
  speechSynthesis.speak(utter);
}

// ==================== Init ====================
connectWS();
initSpeechRecognition();
