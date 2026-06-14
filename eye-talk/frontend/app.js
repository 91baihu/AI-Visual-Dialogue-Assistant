// ============================================================
//  EyeTalk — AI视觉对话助手 · 前端逻辑
// ============================================================

const WS_URL = "ws://localhost:8000/ws";
const AI_TIMEOUT = 60000;
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
const voiceWaveCanvas  = document.getElementById("voiceWaveCanvas");
const waveCtx          = voiceWaveCanvas.getContext("2d");
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
const sttPanel         = document.getElementById("sttPanel");
const sttStatusDot     = document.getElementById("sttStatusDot");
const sttStatusText    = document.getElementById("sttStatusText");
const sttConfidence    = document.getElementById("sttConfidence");
const sttMeterBar      = document.getElementById("sttMeterBar");
const sttInterim       = document.getElementById("sttInterim");
const sttEngineTag     = document.getElementById("sttEngineTag");

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
let _hasUserInteracted = false; // TTS 需要用户先交互

// 监听用户首次交互，解锁 TTS
["click", "keydown", "touchstart"].forEach(evt => {
  document.addEventListener(evt, () => { _hasUserInteracted = true; }, { once: true });
});

// ==================== STT Panel State ====================
let sttPanelTimer = null;       // auto-hide timer
let sttMeterRaf = null;         // requestAnimationFrame for volume meter
let sttMeterAnalyser = null;    // AnalyserNode for volume meter
let sttMeterDataArray = null;   // Uint8Array for frequency data

// ==================== Audio Visualization ====================
let audioContext = null;      // Web Audio API context
let analyser = null;          // AnalyserNode for frequency data
let micStream = null;         // MediaStream from microphone
let waveAnimFrame = null;     // requestAnimationFrame ID
const WAVE_BAR_COUNT = 32;    // number of bars in the waveform
const WAVE_BAR_GAP = 2;       // gap between bars in px

// ==================== Utils ====================
function scrollToBottom() {
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ==================== TTS (Web Speech API) ====================
let currentUtterance = null;
let currentSpeakBtn = null;

function speakText(text, btnEl) {
  if (!window.speechSynthesis) return;
  // 浏览器要求用户先交互才能播放语音
  if (!_hasUserInteracted) {
    console.log("[TTS] Waiting for user interaction before speaking");
    return;
  }
  // 停止当前朗读
  window.speechSynthesis.cancel();

  // 清除 HTML 标签、emoji 表情、装饰符号
  const clean = text
    .replace(/<[^>]*>/g, "")
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{2B50}\u{2B55}]/gu, "")
    .replace(/[★●►▶◆◇■□▲△•·※✨❗✅❌⚡❤️➡️⬅️⬆️⬇️]/g, "")
    .trim();
  if (!clean) return;

  const utter = new SpeechSynthesisUtterance(clean);
  utter.lang = "zh-CN";
  utter.rate = 1.0;
  utter.pitch = 1.0;

  // 尝试选择中文语音
  const voices = window.speechSynthesis.getVoices();
  const zhVoice = voices.find(v => v.lang.startsWith("zh")) || null;
  if (zhVoice) utter.voice = zhVoice;

  currentUtterance = utter;
  currentSpeakBtn = btnEl;

  // 更新按钮状态
  if (btnEl) {
    btnEl.textContent = "⏸";
    btnEl.classList.add("speaking");
  }

  utter.onend = () => {
    resetSpeakBtn();
  };
  utter.onerror = () => {
    resetSpeakBtn();
  };

  window.speechSynthesis.speak(utter);
}

function stopSpeaking() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  resetSpeakBtn();
}

function resetSpeakBtn() {
  if (currentSpeakBtn) {
    currentSpeakBtn.textContent = "🔊";
    currentSpeakBtn.classList.remove("speaking");
  }
  currentUtterance = null;
  currentSpeakBtn = null;
}

function toggleSpeak(text, btnEl) {
  if (btnEl && btnEl.classList.contains("speaking")) {
    stopSpeaking();
  } else {
    speakText(text, btnEl);
  }
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

    // 朗读按钮
    const speakBtn = document.createElement("button");
    speakBtn.className = "btn-speak";
    speakBtn.textContent = "🔊";
    speakBtn.title = "朗读 / 停止";
    speakBtn.addEventListener("click", () => toggleSpeak(content, speakBtn));
    bubble.appendChild(speakBtn);

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
  // 缩放到更小尺寸以加速 API 识别
  const MAX_W = 480, MAX_H = 360;
  let w = videoEl.videoWidth, h = videoEl.videoHeight;
  if (w > MAX_W || h > MAX_H) {
    const scale = Math.min(MAX_W / w, MAX_H / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  canvasEl.width = w;
  canvasEl.height = h;
  const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const base64 = canvasEl.toDataURL("image/jpeg", 0.6);
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
    isAutoSending = false;
    try {
      const data = JSON.parse(event.data);

      if (data.type === "reply") {
        removeThinking();
        const wrapper = addMessage("ai", data.text);
        lastAIReply = data.text;
        if (data.usage) updateStats(data.usage);
        // 自动朗读 AI 回复
        const speakBtn = wrapper.querySelector(".btn-speak");
        speakText(data.text, speakBtn);

      } else {
        removeThinking();
        addMessage("ai", data.text || event.data);
      }
    } catch {
      removeThinking();
      addMessage("ai", event.data);
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
    const resp = await fetch("/api/stats");
    if (resp.ok) updateStats(await resp.json());
  } catch (e) {
    console.warn("[Stats] fetch failed:", e);
  }
}

setInterval(fetchStats, 3000);
fetchStats();

// ==================== Speech Recognition ====================
// 优先使用后端 WebSocket 流式识别（DashScope），降级到 Web Speech API

let sttWs = null;                // STT WebSocket 连接
let sttPcmNode = null;           // ScriptProcessor 节点
let sttPcmStream = null;         // 麦克风 MediaStream
let sttFallbackMode = false;     // 是否使用 Web Speech API 降级模式
let sttTimeoutTimer = null;      // 超时计时器

const STT_WS_URL = "ws://localhost:8000/ws/stt";
const STT_TIMEOUT = 30000;       // 30秒无结果超时
const STT_PCM_BUFFER_SIZE = 4096; // ScriptProcessor buffer size
const STT_SAMPLE_RATE = 16000;   // 目标采样率

/** 初始化语音识别（尝试后端，降级 Web Speech API） */
function initSpeechRecognition() {
  // 先测试后端 WebSocket 是否可用
  _testSttBackend().then(ok => {
    if (ok) {
      console.log("[STT] Using backend WebSocket mode");
      sttFallbackMode = false;
      _setSttEngineTag("backend", "DashScope 实时");
    } else {
      console.log("[STT] Backend unavailable, using Web Speech API fallback");
      sttFallbackMode = true;
      _setSttEngineTag("fallback", "Web Speech");
      _initWebSpeechFallback();
    }
  });
}

/** 更新 STT 引擎标签 */
function _setSttEngineTag(cls, text) {
  if (!sttEngineTag) return;
  sttEngineTag.className = "stt-engine-tag " + cls;
  sttEngineTag.textContent = text;
}

/** 测试后端 STT 是否可用 */
async function _testSttBackend() {
  return new Promise(resolve => {
    try {
      const testWs = new WebSocket(STT_WS_URL);
      const timer = setTimeout(() => {
        testWs.close();
        resolve(false);
      }, 2000);
      testWs.onopen = () => {
        clearTimeout(timer);
        testWs.close();
        resolve(true);
      };
      testWs.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    } catch {
      resolve(false);
    }
  });
}

// ==================== Backend WebSocket STT ====================

/** 启动后端流式 STT */
async function _startBackendStt() {
  return new Promise((resolve, reject) => {
    try {
      sttWs = new WebSocket(STT_WS_URL);
    } catch (e) {
      reject(e);
      return;
    }

    sttWs.onopen = () => {
      console.log("[STT-WS] Connected");
      setSttStatus("listening", "监听中...");
      _startPcmCapture().then(resolve).catch(reject);
    };

    sttWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "stt_result") {
          _handleSttResult(data);
        } else if (data.type === "stt_end") {
          console.log("[STT-WS] Session ended");
        }
      } catch {}
    };

    sttWs.onerror = (e) => {
      console.warn("[STT-WS] Error:", e);
      setSttStatus("error", "连接错误，已切换到浏览器识别");
      // 降级到 Web Speech API
      sttFallbackMode = true;
      _setSttEngineTag("fallback", "Web Speech");
      _initWebSpeechFallback();
    };

    sttWs.onclose = () => {
      console.log("[STT-WS] Closed");
      sttWs = null;
    };
  });
}

/** STT 重试状态 */
let _sttRetryCount = 0;
const _STT_MAX_RETRY = 1;

/** 处理后端返回的识别结果 */
function _handleSttResult(data) {
  // 识别失败：显示错误，首次自动重试
  if (data.is_final && data.success === false) {
    const errMsg = data.error || "识别失败";
    console.warn("[STT] Recognition failed:", errMsg);
    setSttStatus("error", errMsg);

    if (_sttRetryCount < _STT_MAX_RETRY) {
      _sttRetryCount++;
      setSttStatus("recognizing", `识别失败，${1}秒后重试...`);
      setTimeout(() => {
        if (sttWs && sttWs.readyState === WebSocket.OPEN) {
          setSttStatus("recognizing", "重试中...");
          // 发送 end 信号触发服务端最终识别
          sttWs.send(JSON.stringify({ type: "end" }));
        }
      }, 1000);
    } else {
      // 重试耗尽，显示最终错误
      setSttStatus("error", "识别失败: " + errMsg);
      hideSttPanel(3000);
      _sttRetryCount = 0;
    }
    return;
  }

  // 识别成功
  if (data.text) {
    _sttRetryCount = 0;  // 重置重试计数
    if (data.is_final) {
      // 最终结果
      textInput.value = (textInput.value + data.text).trim();
      setSttStatus("done", "识别完成");
      showSttConfidence(data.confidence);
      sttInterim.classList.remove("active");
      hideSttPanel(2000);
      // 重置超时
      if (sttTimeoutTimer) { clearTimeout(sttTimeoutTimer); sttTimeoutTimer = null; }
    } else {
      // 中间结果
      setSttStatus("recognizing", "识别中...");
      sttInterim.textContent = data.text;
      sttInterim.classList.add("active");
    }
  }
}

/** 启动 PCM 音频采集 */
async function _startPcmCapture() {
  try {
    sttPcmStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: STT_SAMPLE_RATE,
      },
    });

    // 使用 AudioContext 进行采样率转换
    const srcCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: STT_SAMPLE_RATE,
    });
    const source = srcCtx.createMediaStreamSource(sttPcmStream);
    sttPcmNode = srcCtx.createScriptProcessor(STT_PCM_BUFFER_SIZE, 1, 1);

    sttPcmNode.onaudioprocess = (e) => {
      if (!isRecording || !sttWs || sttWs.readyState !== WebSocket.OPEN) return;

      const float32 = e.inputBuffer.getChannelData(0);
      // Float32 → Int16 PCM
      const pcm = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      sttWs.send(pcm.buffer);
    };

    source.connect(sttPcmNode);
    sttPcmNode.connect(srcCtx.destination);
    console.log("[STT-WS] PCM capture started");
  } catch (e) {
    console.warn("[STT-WS] PCM capture failed:", e);
    throw e;
  }
}

/** 停止 PCM 采集 */
function _stopPcmCapture() {
  if (sttPcmNode) {
    sttPcmNode.disconnect();
    sttPcmNode = null;
  }
  if (sttPcmStream) {
    sttPcmStream.getTracks().forEach(t => t.stop());
    sttPcmStream = null;
  }
}

/** 停止后端 STT */
function _stopBackendStt() {
  // 发送 end 信号
  if (sttWs && sttWs.readyState === WebSocket.OPEN) {
    try {
      sttWs.send(JSON.stringify({ type: "end" }));
    } catch {}
    // 延迟关闭，等待最终结果
    setTimeout(() => {
      if (sttWs) {
        sttWs.close();
        sttWs = null;
      }
    }, 1000);
  }
  _stopPcmCapture();
}

// ==================== Web Speech API Fallback ====================

function _initWebSpeechFallback() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btnVoice.classList.add("unsupported");
    btnVoice.querySelector(".voice-label").textContent = "浏览器不支持";
    btnVoice.addEventListener("click", () => addMessage("system", "🎤 请使用 Chrome 或 Edge 浏览器"));
    return;
  }
  recognition = new SR();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (e) => {
    let finalText = "", interim = "";
    let lastConfidence = 0;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        finalText += t;
        lastConfidence = e.results[i][0].confidence || 0;
      } else {
        interim += t;
      }
    }
    if (finalText) {
      textInput.value = (textInput.value + finalText).trim();
      setSttStatus("done", "识别完成");
      showSttConfidence(lastConfidence);
      hideSttPanel(2000);
    }
    if (interim) {
      interimBar.classList.add("active");
      interimText.textContent = interim;
      setSttStatus("recognizing", "识别中...");
      sttInterim.textContent = interim;
      sttInterim.classList.add("active");
    } else {
      interimBar.classList.remove("active");
      sttInterim.classList.remove("active");
    }
  };

  recognition.onstart = () => {
    setSttStatus("listening", "监听中...");
  };

  recognition.onerror = (e) => {
    console.log("[SR] error:", e.error);
    if (e.error === "not-allowed") {
      addMessage("system", "🎤 麦克风权限被拒绝");
      btnVoice.classList.add("unsupported");
      setSttStatus("error", "麦克风权限被拒绝");
      hideSttPanel(3000);
      stopRecording();
    } else if (e.error === "no-speech") {
      setSttStatus("error", "未检测到语音");
    } else if (e.error === "network") {
      setSttStatus("error", "网络错误");
    } else {
      setSttStatus("error", "识别出错: " + e.error);
    }
  };

  recognition.onend = () => {
    if (isRecording) {
      try { recognition.start(); } catch {}
    }
  };
}

// ==================== Recording Control ====================

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  btnVoice.classList.add("recording");
  btnVoice.querySelector(".voice-label").textContent = "松开结束";

  // STT 面板
  showSttPanel();
  setSttStatus("listening", "正在启动...");
  sttInterim.textContent = "";
  sttInterim.classList.remove("active");
  sttConfidence.classList.remove("visible");

  // 启动音量表
  startAudioVisualization().then(() => startSttMeter());

  // 启动识别
  if (sttFallbackMode) {
    // Web Speech API 模式
    if (!recognition) {
      _initWebSpeechFallback();
    }
    if (recognition) {
      try { recognition.start(); } catch {}
    }
  } else {
    // 后端 WebSocket 模式
    _startBackendStt().catch(e => {
      console.warn("[STT] Backend start failed, falling back:", e);
      sttFallbackMode = true;
      _initWebSpeechFallback();
      if (recognition) {
        try { recognition.start(); } catch {}
      }
    });
  }

  // 超时处理
  sttTimeoutTimer = setTimeout(() => {
    if (isRecording) {
      setSttStatus("error", "识别超时，请重试");
      hideSttPanel(3000);
    }
  }, STT_TIMEOUT);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  btnVoice.classList.remove("recording");
  btnVoice.querySelector(".voice-label").textContent = "按住说话";
  interimBar.classList.remove("active");
  sttInterim.classList.remove("active");

  // 停止音量表
  stopSttMeter();
  stopAudioVisualization();

  // 清除超时
  if (sttTimeoutTimer) { clearTimeout(sttTimeoutTimer); sttTimeoutTimer = null; }

  // 停止识别
  if (sttFallbackMode) {
    if (recognition) try { recognition.stop(); } catch {}
  } else {
    _stopBackendStt();
  }

  // 延迟隐藏面板
  hideSttPanel(2000);
}

// ==================== Audio Visualization ====================
function initAudioVisualization() {
  if (audioContext) return; // already initialized
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
  } catch (e) {
    console.warn("[EyeTalk] AudioContext 初始化失败:", e);
  }
}

async function startAudioVisualization() {
  try {
    initAudioVisualization();
    if (!audioContext || !analyser) return;

    // Resume context if suspended (required by some browsers)
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const source = audioContext.createMediaStreamSource(micStream);
    source.connect(analyser);

    // Size canvas to button dimensions (use offsetWidth/Height which work even when hidden)
    const btnRect = btnVoice.getBoundingClientRect();
    voiceWaveCanvas.width = btnRect.width * window.devicePixelRatio;
    voiceWaveCanvas.height = btnRect.height * window.devicePixelRatio;
    waveCtx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);

    drawWaveLoop();
  } catch (e) {
    console.warn("[EyeTalk] 麦克风音频流获取失败:", e);
  }
}

function drawWaveLoop() {
  if (!isRecording || !analyser) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteFrequencyData(dataArray);

  const w = voiceWaveCanvas.width / window.devicePixelRatio;
  const h = voiceWaveCanvas.height / window.devicePixelRatio;
  waveCtx.clearRect(0, 0, w, h);

  const barWidth = (w - WAVE_BAR_GAP * (WAVE_BAR_COUNT - 1)) / WAVE_BAR_COUNT;
  const step = Math.floor(bufferLength / WAVE_BAR_COUNT);

  for (let i = 0; i < WAVE_BAR_COUNT; i++) {
    // Average a slice of frequency bins for each bar
    let sum = 0;
    for (let j = 0; j < step; j++) {
      sum += dataArray[i * step + j];
    }
    const avg = sum / step;
    const barHeight = Math.max(2, (avg / 255) * h * 0.9);
    const x = i * (barWidth + WAVE_BAR_GAP);
    const y = (h - barHeight) / 2;

    // Gradient from accent to highlight color
    const gradient = waveCtx.createLinearGradient(x, y, x, y + barHeight);
    gradient.addColorStop(0, "rgba(233, 69, 96, 0.9)");
    gradient.addColorStop(1, "rgba(15, 52, 96, 0.6)");
    waveCtx.fillStyle = gradient;
    waveCtx.beginPath();
    waveCtx.roundRect(x, y, barWidth, barHeight, 2);
    waveCtx.fill();
  }

  waveAnimFrame = requestAnimationFrame(drawWaveLoop);
}

function stopAudioVisualization() {
  if (waveAnimFrame) {
    cancelAnimationFrame(waveAnimFrame);
    waveAnimFrame = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  // Clear canvas and reset transform
  if (voiceWaveCanvas) {
    waveCtx.setTransform(1, 0, 0, 1, 0, 0);
    waveCtx.clearRect(0, 0, voiceWaveCanvas.width, voiceWaveCanvas.height);
  }
}


// ==================== STT Panel ====================
function showSttPanel() {
  if (sttPanelTimer) { clearTimeout(sttPanelTimer); sttPanelTimer = null; }
  sttPanel.classList.add("active");
}

function hideSttPanel(delay) {
  if (sttPanelTimer) clearTimeout(sttPanelTimer);
  if (delay) {
    sttPanelTimer = setTimeout(() => {
      sttPanel.classList.remove("active");
      sttPanelTimer = null;
    }, delay);
  } else {
    sttPanel.classList.remove("active");
  }
}

function setSttStatus(state, text) {
  sttStatusDot.className = "stt-status-dot " + state;
  sttStatusText.textContent = text;
  // Hide confidence when not done
  if (state !== "done") {
    sttConfidence.classList.remove("visible");
    sttConfidence.textContent = "";
  }
}

function showSttConfidence(conf) {
  if (conf != null && conf > 0) {
    sttConfidence.textContent = Math.round(conf * 100) + "%";
    sttConfidence.classList.add("visible");
  }
}

/** Start real-time RMS volume meter using the existing micStream */
function startSttMeter() {
  if (!audioContext || !micStream) return;
  try {
    sttMeterAnalyser = audioContext.createAnalyser();
    sttMeterAnalyser.fftSize = 256;
    const source = audioContext.createMediaStreamSource(micStream);
    source.connect(sttMeterAnalyser);
    sttMeterDataArray = new Uint8Array(sttMeterAnalyser.frequencyBinCount);
    drawSttMeter();
  } catch (e) {
    console.warn("[STT Panel] meter init failed:", e);
  }
}

function drawSttMeter() {
  if (!isRecording || !sttMeterAnalyser) {
    if (sttMeterBar) sttMeterBar.style.width = "0%";
    return;
  }
  sttMeterAnalyser.getByteFrequencyData(sttMeterDataArray);
  let sum = 0;
  for (let i = 0; i < sttMeterDataArray.length; i++) sum += sttMeterDataArray[i];
  const avg = sum / sttMeterDataArray.length;
  const pct = Math.min(100, (avg / 128) * 100);
  sttMeterBar.style.width = pct + "%";
  sttMeterRaf = requestAnimationFrame(drawSttMeter);
}

function stopSttMeter() {
  if (sttMeterRaf) { cancelAnimationFrame(sttMeterRaf); sttMeterRaf = null; }
  sttMeterAnalyser = null;
  sttMeterDataArray = null;
  if (sttMeterBar) sttMeterBar.style.width = "0%";
}

btnVoice.addEventListener("mousedown", (e) => { e.preventDefault(); startRecording(); });
btnVoice.addEventListener("mouseup",   (e) => { e.preventDefault(); stopRecording();  });
btnVoice.addEventListener("mouseleave",(e) => { if (isRecording) stopRecording();     });
btnVoice.addEventListener("touchstart",(e) => { e.preventDefault(); startRecording(); });
btnVoice.addEventListener("touchend",  (e) => { e.preventDefault(); stopRecording();  });

// ==================== Debug ====================
console.log("[EyeTalk] page location:", window.location.href);

// ==================== Toast ====================
function showToast(msg, type = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity 0.3s"; }, 2000);
  setTimeout(() => el.remove(), 2300);
}

// ==================== Settings Modal ====================
const settingsModal   = document.getElementById("settingsModal");
const settingsBtn     = document.getElementById("settingsBtn");
const modalCloseBtn   = document.getElementById("modalCloseBtn");
const cancelConfigBtn = document.getElementById("cancelConfigBtn");
const saveConfigBtn   = document.getElementById("saveConfigBtn");
const providerSelect  = document.getElementById("providerSelect");
const apiKeyInput     = document.getElementById("apiKeyInput");
const configStatus    = document.getElementById("configStatus");
const currentProviderTag = document.getElementById("currentProviderTag");
const toggleKeyBtn    = document.getElementById("toggleKeyBtn");

function openSettings() {
  settingsModal.classList.remove("hidden");
  loadConfig();
}

function closeSettings() {
  settingsModal.classList.add("hidden");
  configStatus.textContent = "";
  configStatus.className = "";
}

settingsBtn.addEventListener("click", openSettings);
modalCloseBtn.addEventListener("click", closeSettings);
cancelConfigBtn.addEventListener("click", closeSettings);

// Click overlay background to close
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettings();
});

// Toggle password visibility
const _SVG_EYE = '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const _SVG_EYE_OFF = '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

toggleKeyBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleKeyBtn.innerHTML = isPassword ? _SVG_EYE_OFF : _SVG_EYE;
});

async function loadConfig() {
  const url = "/api/config";
  console.log("[Config] GET", url);
  try {
    const resp = await fetch(url);
    console.log("[Config] response status:", resp.status);
    const data = await resp.json();

    providerSelect.value = data.provider || localStorage.getItem("eyeTalk_provider") || "deepseek";

    const configured = data.configured || {};
    const current = providerSelect.value;
    const hasKey = configured[current] || false;

    currentProviderTag.textContent = hasKey ? "已配置" : "未配置";
    currentProviderTag.className = "tag " + (hasKey ? "ok" : "no");

    updateProviderInfo(current);
  } catch (e) {
    configStatus.textContent = "加载配置失败";
    configStatus.className = "err";
  }
}

function updateProviderInfo(provider) {
  document.querySelectorAll("#providerInfo p").forEach((p) => {
    p.style.display = p.dataset.provider === provider ? "block" : "none";
  });
  document.querySelectorAll("#providerLinks a").forEach((a) => {
    a.style.display = a.dataset.provider === provider ? "inline-block" : "none";
  });
}

providerSelect.addEventListener("change", (e) => {
  const provider = e.target.value;
  updateProviderInfo(provider);
  currentProviderTag.textContent = "";
  currentProviderTag.className = "tag";
  apiKeyInput.value = "";
  localStorage.setItem("eyeTalk_provider", provider);
});

async function saveConfig() {
  const provider = providerSelect.value;
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    showToast("请输入 API 密钥", "err");
    return;
  }

  saveConfigBtn.disabled = true;
  saveConfigBtn.textContent = "保存中...";
  configStatus.textContent = "";
  configStatus.className = "";

  const url = "/api/config";
  const payload = { provider, api_key: apiKey };
  console.log("[Config] POST", url, payload);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    console.log("[Config] response status:", resp.status);

    // Handle 422 validation errors
    if (resp.status === 422) {
      const errData = await resp.json();
      const detail = errData.detail;
      let msg = "参数验证失败";
      if (Array.isArray(detail) && detail.length > 0) {
        msg = detail.map((d) => d.msg).join("; ");
      } else if (typeof detail === "string") {
        msg = detail;
      }
      showSaveError(msg);
      console.error("[Config] 422 validation error:", detail);
      return;
    }

    const data = await resp.json();

    if (data.success) {
      configStatus.textContent = "✓ 配置已保存，正在测试连接...";
      configStatus.className = "ok";
      apiKeyInput.value = "";
      localStorage.setItem("eyeTalk_provider", provider);

      // Reconnect WebSocket to use new provider
      if (ws) ws.close();
      connectWS();

      showToast("配置已保存，已切换到 " + provider, "ok");
      setTimeout(closeSettings, 1200);
    } else {
      showSaveError(data.message || "保存失败");
      console.error("[Config] server error:", data.message);
    }
  } catch (e) {
    if (e.name === "AbortError") {
      showSaveError("请求超时，请检查网络后重试");
      console.error("[Config] request timeout");
    } else if (e.message && e.message.includes("Failed to fetch")) {
      showSaveError("无法连接到服务器，请确认后端已启动");
      console.error("[Config] network error:", e);
    } else {
      showSaveError("请求失败: " + (e.message || "未知错误"));
      console.error("[Config] unexpected error:", e);
    }
  } finally {
    saveConfigBtn.disabled = false;
    saveConfigBtn.textContent = "保存";
  }
}

function showSaveError(msg) {
  configStatus.innerHTML = msg + ' <a href="#" id="retryLink">重试</a>';
  configStatus.className = "err";
  document.getElementById("retryLink").addEventListener("click", (e) => {
    e.preventDefault();
    saveConfig();
  });
}

saveConfigBtn.addEventListener("click", saveConfig);

// ==================== Init ====================
// Restore last used provider from localStorage
const savedProvider = localStorage.getItem("eyeTalk_provider");
if (savedProvider && providerSelect) providerSelect.value = savedProvider;

connectWS();
initSpeechRecognition();

// Pre-load TTS voices (some browsers load async)
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    window.speechSynthesis.getVoices();
  });
}
