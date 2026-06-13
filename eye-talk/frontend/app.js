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

// ==================== State ====================
let ws = null;
let cameraStream = null;
let recognition = null;
let isRecording = false;
let voiceBuffer = "";        // 语音识别累积缓冲
let selectedVoice = null;    // 当前选中的 TTS 音色
let aiTimeoutTimer = null;
let reconnectTimer = null;
let shouldReconnect = true;
let autoMode = false;
let autoSampleTimer = null;
let prevFrameData = null;
let isAutoSending = false;
let lastAIReply = ""; // for screenshot feature

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
  if (!SR) {
    btnVoice.classList.add("unsupported");
    btnVoice.querySelector(".voice-label").textContent = "浏览器不支持";
    btnVoice.title = "请使用 Chrome / Edge 等 Chromium 内核浏览器，并通过 localhost 或 HTTPS 访问";
    btnVoice.addEventListener("click", () => addMessage("system", "🎤 当前浏览器不支持语音识别，请使用 Chrome 或 Edge 浏览器"));
    return;
  }

  recognition = new SR();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interim = "", finalText = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += t;
      else interim += t;
    }
    // 累积所有 final 结果到缓冲区，保证整段语音完整
    if (finalText) voiceBuffer += finalText;
    // 实时写入输入框：缓冲区 + 当前 interim
    textInput.value = voiceBuffer + interim;
    if (interim) {
      interimBar.classList.add("active");
      interimText.textContent = interim;
    } else {
      interimBar.classList.remove("active");
      interimText.textContent = "";
    }
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed") {
      addMessage("system", "🎤 麦克风权限被拒绝");
      btnVoice.classList.add("unsupported");
      btnVoice.querySelector(".voice-label").textContent = "权限被拒";
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      console.warn("语音识别错误:", event.error);
    }
    stopRecording();
  };

  // 持续模式：识别结束后自动重启（除非用户已松手）
  recognition.onend = () => {
    if (isRecording) {
      try { recognition.start(); } catch {}
    }
  };
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
        echoCancellation: true,       // 回声消除
        noiseSuppression: true,       // 噪声抑制
        autoGainControl: true,        // 自动增益
        sampleRate: 16000,            // 16kHz 采样率（语音识别最佳）
        channelCount: 1,              // 单声道
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

function startRecording() {
  if (!recognition || isRecording) return;
  isRecording = true;
  voiceBuffer = "";  // 清空缓冲区，开始新一轮录音
  btnVoice.classList.add("recording");
  btnVoice.querySelector(".voice-label").textContent = "松开结束";
  startAudioVisualization();  // 启动声波动画
  try { recognition.start(); } catch { stopRecording(); }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  btnVoice.classList.remove("recording");
  btnVoice.querySelector(".voice-label").textContent = "按住说话";
  interimBar.classList.remove("active");
  interimText.textContent = "";
  stopAudioVisualization();   // 停止声波动画，释放麦克风
  if (recognition) try { recognition.stop(); } catch {}
  // 语音识别结果已实时写入 textInput，用户可按发送键
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
let ttsAbortCtrl = null;        // AbortController（取消上一次请求）
let ttsRequestId = 0;           // 请求序号（防止过期请求覆盖）

function initVoicePacks() {
  const saved = localStorage.getItem("eyetalk_voice") || "doubao";
  selectedVoice = VOICE_PACKS.find(v => v.id === saved) || VOICE_PACKS[0];
}

/** 停止当前所有音频播放 + 清理资源 */
function stopCurrentAudio() {
  // 取消进行中的 fetch 请求
  if (ttsAbortCtrl) {
    ttsAbortCtrl.abort();
    ttsAbortCtrl = null;
  }
  // 停止当前音频
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  // 释放 blob URL
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  // 移除指示器
  if (currentIndicator) {
    removeSpeakingIndicator(currentIndicator);
    currentIndicator = null;
  }
}

/**
 * 通过后端 /api/tts/stream 流式获取语音并播放。
 * 使用 MediaSource 实现边接收边播放，首包延迟低。
 * 失败时自动降级为浏览器内置语音。
 */
async function speakText(text, bubbleEl) {
  const clean = text.replace(/<[^>]*>/g, "").trim();
  if (!clean) return;

  stopCurrentAudio();

  const voiceId = selectedVoice?.id || "doubao";
  const reqId = ++ttsRequestId;

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
      let detail = "TTS 请求失败";
      try { detail = (await resp.json()).detail || detail; } catch {}
      console.warn("[TTS] Backend error (" + resp.status + "):", detail);
      removeSpeakingIndicator(currentIndicator);
      currentIndicator = null;
      speakTextFallback(clean, bubbleEl);
      return;
    }

    // 尝试 MediaSource 流式播放（Chrome/Edge 支持 audio/mpeg）
    const played = await playStreamMSE(resp, reqId);
    if (played) return;

    // MSE 不支持时，降级：读完 blob 再播放
    const audioBlob = await resp.blob();
    if (reqId !== ttsRequestId) return;
    if (audioBlob.size === 0) {
      removeSpeakingIndicator(currentIndicator);
      currentIndicator = null;
      speakTextFallback(clean, bubbleEl);
      return;
    }
    await playBlobAudio(audioBlob, reqId);
  } catch (e) {
    if (e.name === "AbortError") return;
    console.warn("[TTS] Failed, falling back:", e);
    if (reqId === ttsRequestId) {
      removeSpeakingIndicator(currentIndicator);
      currentIndicator = null;
    }
    speakTextFallback(clean, bubbleEl);
  }
}

/** MediaSource 流式播放：边接收边播放，首包即响 */
async function playStreamMSE(resp, reqId) {
  try {
    if (!window.MediaSource) return false;
    const ms = new MediaSource();
    const audioUrl = URL.createObjectURL(ms);
    const audio = new Audio(audioUrl);
    currentAudio = audio;
    currentAudioUrl = audioUrl;

    return new Promise((resolve) => {
      let sourceBuffer = null;
      let chunks = [];
      let reader = null;
      let readDone = false;

      ms.addEventListener("sourceopen", async () => {
        try {
          sourceBuffer = ms.addSourceBuffer("audio/mpeg");
          sourceBuffer.addEventListener("updateend", () => {
            // 如果还有积压数据，继续追加
            if (chunks.length > 0) {
              try { sourceBuffer.appendBuffer(chunks.shift()); }
              catch {}
            } else if (readDone) {
              try { ms.endOfStream(); }
              catch {}
            }
          });

          // 开始读取流
          reader = resp.body.getReader();
          resolve(true);

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              readDone = true;
              // 如果 buffer 空闲，结束流
              if (chunks.length === 0 && sourceBuffer && !sourceBuffer.updating) {
                try { ms.endOfStream(); } catch {}
              }
              break;
            }
            if (reqId !== ttsRequestId) { reader.cancel(); break; }

            if (sourceBuffer && !sourceBuffer.updating && chunks.length === 0) {
              try { sourceBuffer.appendBuffer(value.buffer); } catch { chunks.push(value.buffer); }
            } else {
              chunks.push(value.buffer);
            }
          }
        } catch (e) {
          console.warn("[TTS] MSE stream error:", e);
          resolve(false);
        }
      });

      audio.onended = () => {
        if (reqId !== ttsRequestId) return;
        removeSpeakingIndicator(currentIndicator);
        currentIndicator = null;
        URL.revokeObjectURL(audioUrl);
        currentAudioUrl = null;
        currentAudio = null;
      };
      audio.onerror = () => {
        if (reqId !== ttsRequestId) return;
        removeSpeakingIndicator(currentIndicator);
        currentIndicator = null;
        URL.revokeObjectURL(audioUrl);
        currentAudioUrl = null;
        currentAudio = null;
        resolve(false);
      };

      audio.play().catch(() => resolve(false));
    });
  } catch {
    return false;
  }
}

/** 播放完整 blob（降级方案） */
async function playBlobAudio(blob, reqId) {
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  currentAudio = audio;
  currentAudioUrl = audioUrl;

  audio.onended = () => {
    if (reqId !== ttsRequestId) return;
    removeSpeakingIndicator(currentIndicator);
    currentIndicator = null;
    URL.revokeObjectURL(audioUrl);
    currentAudioUrl = null;
    currentAudio = null;
  };
  audio.onerror = () => {
    if (reqId !== ttsRequestId) return;
    removeSpeakingIndicator(currentIndicator);
    currentIndicator = null;
    URL.revokeObjectURL(audioUrl);
    currentAudioUrl = null;
    currentAudio = null;
  };
  await audio.play();
}

/** 浏览器内置语音降级方案 */
function speakTextFallback(text, bubbleEl) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "zh-CN";
  utter.rate = 1.0;
  const voices = speechSynthesis.getVoices();
  const match = voices.find(v => v.lang.startsWith("zh"));
  if (match) utter.voice = match;
  let ind = null;
  utter.onstart = () => { ind = addSpeakingIndicator(bubbleEl); };
  utter.onend = () => removeSpeakingIndicator(ind);
  utter.onerror = () => removeSpeakingIndicator(ind);
  speechSynthesis.speak(utter);
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
    testBtn.addEventListener("click", () => {
      speakText("你好，我是你的AI视觉助手，让我们开始对话吧。", null);
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
