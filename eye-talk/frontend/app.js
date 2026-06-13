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

// ==================== State ====================
let ws = null;
let cameraStream = null;
let recognition = null;
let isRecording = false;
let selectedVoice = null;    // 当前选中的 TTS 音色
let aiTimeoutTimer = null;
let reconnectTimer = null;
let shouldReconnect = true;
let autoMode = false;
let autoSampleTimer = null;
let prevFrameData = null;
let isAutoSending = false;
let lastAIReply = ""; // for screenshot feature

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
  if (!bubbleEl) return null;
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
    isAutoSending = false;
    try {
      const data = JSON.parse(event.data);

      if (data.type === "reply") {
        removeThinking();
        const wrapper = addMessage("ai", data.text);
        lastAIReply = data.text;
        if (data.usage) updateStats(data.usage);

      } else if (data.type === "audio") {
        // 后端推送的音频块，加入队列播放
        _enqueueAudio(data);

      } else if (data.type === "audio_end") {
        // 所有音频块已推送完毕
        ttsTotalChunks = data.total || ttsTotalChunks;
        console.log("[TTS] All", ttsTotalChunks, "chunks dispatched");

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
  const payload = { type: "chat", text: text.trim(), voice_id: selectedVoice?.id || "doubao" };
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
// 优先使用后端 WebSocket 流式识别（DashScope），降级到 Web Speech API

let sttWs = null;                // STT WebSocket 连接
let sttPcmNode = null;           // ScriptProcessor 节点
let sttPcmStream = null;         // 麦克风 MediaStream
let sttFallbackMode = false;     // 是否使用 Web Speech API 降级模式
let sttTimeoutTimer = null;      // 超时计时器

const STT_WS_URL = "ws://localhost:8000/ws/stt";
const STT_TIMEOUT = 15000;       // 15秒无结果超时
const STT_PCM_BUFFER_SIZE = 4096; // ScriptProcessor buffer size
const STT_SAMPLE_RATE = 16000;   // 目标采样率

/** 初始化语音识别（尝试后端，降级 Web Speech API） */
function initSpeechRecognition() {
  // 先测试后端 WebSocket 是否可用
  _testSttBackend().then(ok => {
    if (ok) {
      console.log("[STT] Using backend WebSocket mode");
      sttFallbackMode = false;
    } else {
      console.log("[STT] Backend unavailable, using Web Speech API fallback");
      sttFallbackMode = true;
      _initWebSpeechFallback();
    }
  });
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
      setSttStatus("error", "连接错误");
      // 降级到 Web Speech API
      sttFallbackMode = true;
      _initWebSpeechFallback();
    };

    sttWs.onclose = () => {
      console.log("[STT-WS] Closed");
      sttWs = null;
    };
  });
}

/** 处理后端返回的识别结果 */
function _handleSttResult(data) {
  if (data.text) {
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
  stopCurrentAudio();
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

// ==================== TTS ====================
// 音色包配置（Edge TTS 微软神经网络语音）
const VOICE_PACKS = [
  { id: "doubao",    name: "晓晓（默认）",  style: "女声 · 温润自然" },
  { id: "warm",      name: "晓伊",          style: "女声 · 柔和亲切" },
  { id: "news",      name: "云扬",          style: "男声 · 新闻播报" },
  { id: "cute",      name: "云夏",          style: "男声 · 活泼俏皮" },
  { id: "serious",   name: "云健",          style: "男声 · 沉稳有力" },
];

// TTS 播放状态管理
let currentAudio = null;        // 当前 Audio 实例
let currentAudioUrl = null;     // 当前 blob URL（需要手动释放）
let currentIndicator = null;    // 当前说话指示器
let currentProgressEl = null;   // 播放进度元素
let ttsAbortCtrl = null;        // AbortController（取消上一次请求）
let ttsRequestId = 0;           // 请求序号（防止过期请求覆盖）
let audioQueue = [];            // 后端推送的音频块队列
let isPlayingQueue = false;     // 是否正在播放队列
let ttsTotalChunks = 0;         // 总音频块数
let ttsCurrentIndex = 0;        // 当前播放到第几块

function initVoicePacks() {
  const saved = localStorage.getItem("eyetalk_voice") || "doubao";
  selectedVoice = VOICE_PACKS.find(v => v.id === saved) || VOICE_PACKS[0];
}

/** 停止当前所有音频播放 + 清理资源 */
function stopCurrentAudio() {
  // 通知后端取消后续合成
  if (isPlayingQueue && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "audio_cancel" }));
  }
  if (ttsAbortCtrl) {
    ttsAbortCtrl.abort();
    ttsAbortCtrl = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  if (currentIndicator) {
    removeSpeakingIndicator(currentIndicator);
    currentIndicator = null;
  }
  if (currentProgressEl) {
    currentProgressEl.remove();
    currentProgressEl = null;
  }
  // 清空音频队列
  audioQueue = [];
  isPlayingQueue = false;
  ttsTotalChunks = 0;
  ttsCurrentIndex = 0;
}

/** 创建播放进度指示器 */
function _createProgressIndicator() {
  const el = document.createElement("span");
  el.className = "tts-progress";
  el.style.cssText = "font-size:0.72rem;color:#FF6900;margin-left:6px;font-weight:600;";
  return el;
}

/** 更新播放进度 */
function _updateProgress(current, total) {
  if (!currentProgressEl) {
    currentProgressEl = _createProgressIndicator();
    // 尝试附加到最后一个 AI 气泡
    const aiBubbles = messagesDiv.querySelectorAll(".msg-ai .bubble-ai");
    if (aiBubbles.length > 0) {
      aiBubbles[aiBubbles.length - 1].appendChild(currentProgressEl);
    }
  }
  currentProgressEl.textContent = `${current + 1}/${total}`;
}

/** 将后端推送的音频块加入队列并触发播放 */
function _enqueueAudio(chunk) {
  const audioBytes = Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0));
  const blob = new Blob([audioBytes], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  audioQueue.push({ url, index: chunk.index, total: chunk.total });
  ttsTotalChunks = chunk.total;

  // 第一块到达时显示指示器并立即播放
  if (!isPlayingQueue) {
    isPlayingQueue = true;
    ttsCurrentIndex = 0;
    currentIndicator = addSpeakingIndicator(null);
    _playNextInQueue();
  }
}

/** 按顺序播放队列中的音频块 */
async function _playNextInQueue() {
  if (audioQueue.length === 0) {
    isPlayingQueue = false;
    if (currentIndicator) {
      removeSpeakingIndicator(currentIndicator);
      currentIndicator = null;
    }
    if (currentProgressEl) {
      currentProgressEl.remove();
      currentProgressEl = null;
    }
    return;
  }

  const item = audioQueue.shift();
  ttsCurrentIndex = item.index;
  _updateProgress(item.index, item.total);

  const audio = new Audio(item.url);
  currentAudio = audio;
  currentAudioUrl = item.url;

  audio.onended = () => {
    URL.revokeObjectURL(item.url);
    currentAudio = null;
    currentAudioUrl = null;
    _playNextInQueue();
  };

  audio.onerror = () => {
    URL.revokeObjectURL(item.url);
    currentAudio = null;
    currentAudioUrl = null;
    _playNextInQueue();
  };

  try {
    await audio.play();
  } catch {
    _playNextInQueue();
  }
}

/**
 * 通过后端流式 TTS 接口播放语音。
 * 使用 MediaSource 实现边接收边播放，首包即响。
 */
async function speakText(text, bubbleEl) {
  const clean = text.replace(/<[^>]*>/g, "").trim();
  if (!clean) return;

  stopCurrentAudio();

  const voiceId = selectedVoice?.id || "doubao";
  const reqId = ++ttsRequestId;
  const t0 = performance.now();

  try {
    ttsAbortCtrl = new AbortController();
    currentIndicator = addSpeakingIndicator(bubbleEl);

    const resp = await fetch("/api/tts/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean, voice_id: voiceId }),
      signal: ttsAbortCtrl.signal,
    });

    if (reqId !== ttsRequestId) return;

    if (!resp.ok) {
      removeSpeakingIndicator(currentIndicator);
      currentIndicator = null;
      speakTextFallback(clean, bubbleEl);
      return;
    }

    // 尝试 MediaSource 流式播放
    const played = await _streamPlay(resp, reqId, t0);
    if (!played) {
      // MSE 不支持，降级为 blob 播放
      const blob = await resp.blob();
      if (reqId === ttsRequestId && blob.size > 0) {
        await _blobPlay(blob, reqId, t0);
      } else {
        speakTextFallback(clean, bubbleEl);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    console.warn("[TTS] Failed:", e);
    if (reqId === ttsRequestId) {
      removeSpeakingIndicator(currentIndicator);
      currentIndicator = null;
    }
    speakTextFallback(clean, bubbleEl);
  }
}

/** MediaSource 流式播放：边收边播 */
async function _streamPlay(resp, reqId, t0) {
  try {
    if (!window.MediaSource) return false;
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    const audio = new Audio();
    audio.src = url;
    currentAudio = audio;
    currentAudioUrl = url;

    return new Promise((resolve) => {
      let sb = null;
      const queue = [];
      let readerDone = false;

      ms.addEventListener("sourceopen", () => {
        try {
          sb = ms.addSourceBuffer("audio/mpeg");
          sb.addEventListener("updateend", pump);

          const reader = resp.body.getReader();
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) { readerDone = true; pump(); break; }
                if (reqId !== ttsRequestId) { reader.cancel(); break; }
                queue.push(value.buffer);
                pump();
              }
            } catch {}
          })();
          resolve(true);
        } catch { resolve(false); }
      });

      function pump() {
        if (!sb || sb.updating || queue.length === 0) {
          if (readerDone && queue.length === 0 && sb && !sb.updating) {
            try { ms.endOfStream(); } catch {}
          }
          return;
        }
        try { sb.appendBuffer(queue.shift()); } catch {}
      }

      audio.onplaying = () => {
        console.log("[TTS] Stream playback started in", Math.round(performance.now() - t0), "ms");
      };
      const cleanup = () => {
        if (reqId !== ttsRequestId) return;
        removeSpeakingIndicator(currentIndicator);
        currentIndicator = null;
        URL.revokeObjectURL(url);
        currentAudioUrl = null;
        currentAudio = null;
      };
      audio.onended = cleanup;
      audio.onerror = () => { cleanup(); resolve(false); };
      audio.play().catch(() => resolve(false));
    });
  } catch { return false; }
}

/** Blob 降级播放 */
async function _blobPlay(blob, reqId, t0) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  currentAudioUrl = url;
  audio.onplaying = () => console.log("[TTS] Blob play in", Math.round(performance.now() - t0), "ms");
  const cleanup = () => {
    if (reqId !== ttsRequestId) return;
    removeSpeakingIndicator(currentIndicator);
    currentIndicator = null;
    URL.revokeObjectURL(url);
    currentAudioUrl = null;
    currentAudio = null;
  };
  audio.onended = cleanup;
  audio.onerror = cleanup;
  await audio.play();
}

initVoicePacks();

// ==================== Voice Pack Selection ====================
function initVoicePackUI() {
  const grid = document.getElementById("voicePackGrid");
  const testBtn = document.getElementById("testVoiceBtn");
  if (!grid) return;

  function highlightActive() {
    grid.querySelectorAll(".voice-pack-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.voice === (selectedVoice?.id || "doubao"));
    });
  }
  highlightActive();

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".voice-pack-btn");
    if (!btn) return;
    const pack = VOICE_PACKS.find(v => v.id === btn.dataset.voice);
    if (!pack) return;
    selectedVoice = pack;
    localStorage.setItem("eyetalk_voice", pack.id);
    highlightActive();
  });

  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      const voiceId = selectedVoice?.id || "doubao";
      const originalText = testBtn.textContent;
      testBtn.disabled = true;
      testBtn.textContent = "合成中...";

      try {
        stopCurrentAudio();
        const resp = await fetch("/api/tts/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voice_id: voiceId }),
        });

        if (resp.ok) {
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          currentAudio = audio;
          currentAudioUrl = url;
          currentIndicator = addSpeakingIndicator(null);

          audio.onended = () => {
            URL.revokeObjectURL(url);
            currentAudio = null;
            currentAudioUrl = null;
            if (currentIndicator) {
              removeSpeakingIndicator(currentIndicator);
              currentIndicator = null;
            }
          };
          audio.onerror = audio.onended;
          await audio.play();
        } else {
          showToast("语音预览失败", "err");
        }
      } catch (e) {
        console.warn("[TTS] Preview failed:", e);
        showToast("语音预览失败", "err");
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = originalText;
      }
    });
  }
}

initVoicePackUI();

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
toggleKeyBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleKeyBtn.textContent = isPassword ? "🙈" : "👁️";
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
