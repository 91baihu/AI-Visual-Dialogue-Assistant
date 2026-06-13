# EyeTalk 功能优化实施手册

> 本手册包含三个优化方向的具体实施步骤，每一步都可以直接复制到 Claude Code 中执行。
> 分支规范：每个优化方向创建独立 feature 分支，完成后提 PR 合并到 `main`。

---

## 目录

- [优化一：语音转文字 (STT) 信息化 + 识别加速](#优化一语音转文字-stt-信息化--识别加速)
- [优化二：语音包 (TTS) 流式播放优化](#优化二语音包-tts-流式播放优化)
- [优化三：小米风格 UI 重设计](#优化三小米风格-ui-重设计)
- [PR 提交规范](#pr-提交规范)

---

## 优化一：语音转文字 (STT) 信息化 + 识别加速

### 问题分析

| 现状 | 目标 |
|---|---|
| 识别中间态只有文字，无状态指示 | 显示识别状态（聆听中 / 识别中 / 已完成）、音量分贝、识别置信度 |
| 依赖 Web Speech API，浏览器兼容性差，识别慢 | 后端 DashScope Paraformer-v2 实时流式识别，延迟 <500ms |
| 无错误反馈 | 超时、失败、网络异常均有明确 UI 提示 |

### 步骤 1.1 — STT 状态面板 UI

```
请在 eye-talk/frontend/index.html 的语音输入区域（id="voiceBtn"附近）添加一个 STT 状态面板组件：
1. 包含以下元素：
   - 状态指示器（圆点 + 文字：监听中/识别中/完成/错误）
   - 实时音量分贝条（水平进度条样式，随麦克风音量变化）
   - 识别中间文字显示区（半透明背景，显示实时识别中的文字）
   - 识别置信度百分比（识别完成后显示）
2. 在 eye-talk/frontend/style.css 中为该面板添加样式，使用当前深色主题配色
3. 在 eye-talk/frontend/app.js 中实现：
   - 通过 AudioContext AnalyserNode 实时获取音量 RMS 值并更新分贝条
   - 监听 SpeechRecognition 的 onresult/onstart/onend/onerror 事件更新状态
   - 识别完成时显示置信度（如有），2秒后自动隐藏面板
```

### 步骤 1.2 — 后端流式 STT 接口

```
请修改 eye-talk/backend/stt_service.py，实现基于 DashScope Paraformer-v2 的流式语音识别：
1. 添加 async def stt_stream(audio_chunks) 异步生成器函数
2. 使用 dashscope.audio.asr 的实时转写能力（Transcription），支持流式音频输入
3. 实现 VAD（语音活动检测）：检测到静音超过 1.5 秒自动结束识别
4. 返回结构改为：{text: str, is_final: bool, confidence: float, duration_ms: int}
5. 在 eye-talk/backend/main.py 中添加 WebSocket 端点 /ws/stt：
   - 接收二进制音频帧（PCM 16kHz 16bit mono）
   - 实时返回 JSON 识别结果
   - 支持客户端发送 {type: "end"} 主动结束
6. 添加错误处理和日志记录
```

### 步骤 1.3 — 前端对接流式 STT

```
请修改 eye-talk/frontend/app.js 中的语音识别逻辑（约 506-571 行）：
1. 将现有的 Web Speech API 识别改为后端 WebSocket 流式识别：
   - 按钮按下时打开 WebSocket 连接到 /ws/stt
   - 通过 MediaRecorder 录制音频，采集 PCM 数据（AudioWorklet 或 ScriptProcessor）
   - 每 100ms 发送一帧音频数据到后端
2. 实时接收后端返回的识别结果：
   - is_final=false 时更新中间文字显示区
   - is_final=true 时将最终文字填入输入框
3. 更新 STT 状态面板：
   - WebSocket 连接中 → 显示"连接中..."
   - 发送音频帧 → 显示"监听中" + 更新分贝条
   - 收到结果 → 显示"识别中"
   - 识别完成 → 显示"完成" + 置信度
4. 添加降级策略：后端不可用时回退到 Web Speech API
5. 添加超时处理：10秒无结果自动提示
```

### 步骤 1.4 — 测试与验证

```
请在 eye-talk/backend/test_api.py 中添加 STT 流式识别的测试用例：
1. 测试 WebSocket /ws/stt 端点连接成功
2. 测试发送音频数据后能收到识别结果
3. 测试静音超时自动结束
4. 测试错误音频数据的容错处理
5. 运行测试并确保全部通过
```

---

## 优化二：语音包 (TTS) 流式播放优化

### 问题分析

| 现状 | 目标 |
|---|---|
| TTS 按句子并行合成，但需等全部完成才开始播放 | 首句合成完成即开始播放，后续句子无缝衔接 |
| 默认浏览器 SpeechSynthesis 音质差、无情感 | 统一使用 edge-tts，保留情感语音包选择 |
| 播放过程中无法打断 | 点击发送/录音时立即停止当前播放 |

### 步骤 2.1 — 后端逐句推送优化

```
请修改 eye-talk/backend/main.py 中的 TTS 合成与推送逻辑（约 366-429 行）：
1. 改为"逐句合成、逐句推送"模式：
   - AI 回复后，先用 sentence_splitter 拆分句子
   - 不用 asyncio.gather 等全部完成，而是按顺序合成每句
   - 每句合成完成后立即通过 WebSocket 推送 {type: "audio", index, total, text, data}
   - 最后发送 {type: "audio_end"} 标记结束
2. 保持并发优化：对前 2 句进行预合成（并行），确保第 1 句播放完时第 2 句已就绪
3. 添加 {type: "audio_cancel"} 支持：客户端可发送此消息取消后续合成
4. 在 tts_service.py 中确保 synthesize_speech_stream() 的流式输出与新逻辑兼容
```

### 步骤 2.2 — 前端即时播放优化

```
请修改 eye-talk/frontend/app.js 中的 TTS 播放逻辑（约 679-934 行）：
1. 优化 _enqueueAudio / _playNextInQueue：
   - 收到第一帧音频数据时立即开始播放（不等待后续帧）
   - 播放队列改为"预加载下一帧"模式：当前帧播放时预解码下一帧
   - 帧与帧之间实现无缝衔接（使用 Web Audio API 的 AudioBufferSourceNode scheduled 播放）
2. 添加播放进度指示：
   - 在 AI 消息气泡中显示当前播放的是第几句（如 "2/5"）
   - 当前句子文字高亮显示
3. 优化打断机制：
   - 用户点击发送/录音时，立即发送 {type: "audio_cancel"} 到后端
   - 停止所有队列中的音频播放
   - 清理 Audio 对象和 ObjectURL 避免内存泄漏
4. 移除 speakTextFallback（浏览器默认 TTS），统一使用 edge-tts
```

### 步骤 2.3 — 语音包选择优化

```
请修改语音包相关的前端和后端代码：
1. eye-talk/frontend/index.html 设置弹窗中的语音包选择区域：
   - 增加语音包预览功能：点击试听按钮播放一段固定测试文本
   - 添加语音包加载状态（试听时显示 loading）
   - 选中的语音包高亮边框 + 动画反馈
2. eye-talk/backend/main.py 添加 /api/tts/preview 接口：
   - 接收 voice_id 参数
   - 使用固定的测试文本（"你好，我是你的AI助手，很高兴认识你！"）合成音频
   - 返回 MP3 音频数据
3. eye-talk/frontend/app.js 中：
   - 试听按钮点击后调用 /api/tts/preview
   - 播放预览音频时显示波形动画
   - 选中语音包后立即生效，无需重启
```

### 步骤 2.4 — 测试与验证

```
请验证 TTS 流式播放优化效果：
1. 启动后端服务，发送一条长文本（>50字）测试是否首句即开始播放
2. 测试播放过程中点击录音按钮是否立即打断
3. 测试切换语音包后预览功能是否正常
4. 在 test_api.py 中添加 TTS 相关测试用例
5. 运行全部测试并确保通过
```

---

## 优化三：小米风格 UI 重设计

### 设计参考

小米 HyperOS 设计语言核心特征：
- **配色**：纯白/浅灰底 + 小米橙 (#FF6900) 点缀，深色模式为 #1A1A1A 底
- **圆角**：大圆角 (16-24px)，卡片化布局
- **字体**：MiSans 字体（回退：PingFang SC / Microsoft YaHei）
- **间距**：宽松的呼吸感，组件间距 16-24px
- **动效**：弹性动画，贝塞尔曲线 `cubic-bezier(0.34, 1.56, 0.64, 1)`
- **图标**：线性图标，2px 描边
- **阴影**：柔和阴影，`0 2px 12px rgba(0,0,0,0.08)`

### 小米风格配色表

| 角色 | 浅色模式 | 深色模式 |
|---|---|---|
| 背景 | `#FFFFFF` | `#1A1A1A` |
| 卡片 | `#F5F5F5` | `#2C2C2C` |
| 次级卡片 | `#EEEEEE` | `#3A3A3A` |
| 主强调色 | `#FF6900` | `#FF6900` |
| 主强调色浅 | `#FFF3E8` | `#3D2800` |
| 文字主色 | `#1A1A1A` | `#FFFFFF` |
| 文字次级 | `#666666` | `#AAAAAA` |
| 文字辅助 | `#999999` | `#666666` |
| 边框 | `#E5E5E5` | `#3A3A3A` |
| 成功 | `#00C853` | `#00C853` |
| 错误 | `#FF4444` | `#FF4444` |
| 警告 | `#FFAA00` | `#FFAA00` |

### 步骤 3.1 — CSS 变量体系重构

```
请修改 eye-talk/frontend/style.css，将现有样式重构为小米 HyperOS 风格：
1. 在文件顶部 :root 中定义完整的 CSS 变量体系：
   - --mi-bg, --mi-card, --mi-card-sub, --mi-accent (#FF6900), --mi-accent-light
   - --mi-text, --mi-text-secondary, --mi-text-muted
   - --mi-border, --mi-success, --mi-error, --mi-warning
   - --mi-radius (16px), --mi-radius-lg (24px), --mi-radius-sm (10px)
   - --mi-shadow (柔和阴影), --mi-shadow-lg
   - --mi-transition (弹性动画曲线)
   - --mi-font: "MiSans", "PingFang SC", "Microsoft YaHei", sans-serif
2. 将所有硬编码的颜色值替换为 CSS 变量引用
3. 统一圆角为 16-24px 范围
4. 统一间距为 8 的倍数（8px, 16px, 24px, 32px）
5. 按钮样式改为：白色/深色底 + 小米橙描边或填充，hover 时微弹动画
```

### 步骤 3.2 — 主界面组件重设计

```
请修改 eye-talk/frontend/index.html 和 style.css，重设计主界面组件：
1. 顶部导航栏：
   - 改为白色/深色毛玻璃背景，高度 56px
   - 左侧 Logo + 标题（标题使用小米橙渐变）
   - 右侧状态指示器改为胶囊样式（线性图标 + 文字）
   - 设置按钮改为齿轮线性图标
2. 视频面板：
   - 大圆角卡片样式（border-radius: 20px）
   - 移除彩色边框，改为柔和阴影
   - LIVE 标签改为小米橙胶囊徽章
   - 控制按钮改为圆形线性图标按钮
3. 聊天面板：
   - 消息气泡改为大圆角卡片（用户消息：小米橙渐变；AI消息：卡片背景色）
   - 头像改为 40px 圆形，使用线性图标
   - 输入区域改为圆角搜索栏样式，语音按钮改为圆形小米橙
   - 快捷操作改为圆角标签组，选中态为小米橙填充
4. 统计栏：
   - 改为极简风格，分隔线分隔，字体更小更轻
```

### 步骤 3.3 — 设置弹窗重设计

```
请修改设置弹窗的样式和布局：
1. 弹窗改为底部滑入式（移动端）/ 居中卡片式（桌面端）
2. 标题使用 MiSans 字体，24px 加粗
3. 表单元素改为小米风格：
   - 输入框：大圆角、浅灰背景、聚焦时小米橙边框
   - 下拉框：自定义样式，圆角卡片下拉
   - 语音包网格：卡片式布局，选中态为小米橙边框 + 微弹动画
4. 按钮样式：
   - 主按钮：小米橙填充，白色文字，hover 时加深
   - 次按钮：白色/深色底，小米橙文字和边框
   - 危险按钮：红色描边
5. 添加弹窗背景模糊效果（backdrop-filter: blur(10px)）
```

### 步骤 3.4 — Landing 页面同步更新

```
请修改 eye-talk/frontend/landing.html 和 landing.css，同步小米风格：
1. 将品牌渐变色从蓝紫青改为小米橙渐变：
   linear-gradient(135deg, #FF6900 0%, #FF8C33 50%, #FFA500 100%)
2. 卡片背景改为浅灰/深色卡片色，大圆角
3. 特性图标改为线性风格，小米橙点缀
4. CTA 按钮改为小米橙填充按钮
5. 移除过多的光晕效果，保持简洁
6. 字体统一为 MiSans / PingFang SC
```

### 步骤 3.5 — 响应式适配

```
请检查并优化响应式布局：
1. 移动端（<768px）：
   - 视频面板和聊天面板改为上下布局
   - 底部导航栏（如需要）
   - 消息气泡全宽
   - 设置弹窗全屏底部滑入
2. 平板端（768-1024px）：
   - 保持双栏布局，适当调整比例
3. 桌面端（>1024px）：
   - 最大宽度 1200px 居中
   - 充分利用空间
4. 所有断点处确保文字可读性（最小 14px）和触摸友好性（最小点击区域 44px）
```

### 步骤 3.6 — 测试与验证

```
请验证 UI 重构效果：
1. 检查所有页面元素的配色是否统一为小米风格
2. 验证深色/浅色模式切换（如已实现）
3. 在不同屏幕尺寸下测试响应式布局
4. 确保所有交互状态（hover/active/focus）的视觉反馈正常
5. 检查无障碍对比度是否达标（WCAG AA 级别）
```

---

## PR 提交规范

### 分支命名

| 类型 | 命名格式 | 示例 |
|---|---|---|
| 新功能 | `feature/<简短描述>` | `feature/stt-stream-recognition` |
| 优化 | `perf/<简短描述>` | `perf/tts-stream-playback` |
| UI 改版 | `ui/<简短描述>` | `ui/xiaomi-hyperos-theme` |
| 修复 | `fix/<简短描述>` | `fix/tts-audio-gap` |
| 文档 | `docs/<简短描述>` | `docs/api-reference` |

### Commit Message 规范

使用 Conventional Commits 格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type 类型：**

| Type | 说明 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修复 bug |
| `perf` | 性能优化 |
| `ui` | UI/样式变更 |
| `refactor` | 代码重构（不改变功能） |
| `docs` | 文档变更 |
| `test` | 测试相关 |
| `chore` | 构建/工具链变更 |

**示例：**

```
feat(stt): 添加后端流式语音识别 WebSocket 接口

- 新增 /ws/stt 端点支持实时音频流输入
- 集成 DashScope Paraformer-v2 流式转写
- 添加 VAD 静音检测自动结束

Closes #12
```

```
ui(theme): 全局配色重构为小米 HyperOS 风格

- 定义 CSS 变量体系替代硬编码颜色
- 统一圆角、间距、阴影规范
- 更新所有组件样式
```

### PR 流程

```bash
# 1. 创建功能分支
git checkout main
git pull origin main
git checkout -b feature/stt-stream-recognition

# 2. 开发完成后提交
git add .
git commit -m "feat(stt): 添加后端流式语音识别 WebSocket 接口"

# 3. 推送到远程
git push origin feature/stt-stream-recognition

# 4. 在 GitHub 上创建 PR
# 标题格式：feat(stt): 添加后端流式语音识别 WebSocket 接口
# 描述模板见下方
```

### PR 描述模板

```markdown
## 变更类型
- [ ] 新功能 (feat)
- [ ] 修复 (fix)
- [ ] 性能优化 (perf)
- [ ] UI 改版 (ui)
- [ ] 重构 (refactor)

## 变更说明
简要描述本次 PR 做了什么。

## 变更文件
- `file1.py` — 具体改动说明
- `file2.js` — 具体改动说明

## 测试
- [ ] 本地测试通过
- [ ] 新增单元测试
- [ ] 手动测试场景已覆盖

## 截图/录屏
（如有 UI 变更，请附截图或录屏）

## 关联 Issue
Closes #<issue_number>
```

---

## 实施顺序建议

```
Phase 1: 小米 UI 重设计（优先级最高，影响所有页面）
  ├── 3.1 CSS 变量体系重构
  ├── 3.2 主界面组件重设计
  ├── 3.3 设置弹窗重设计
  ├── 3.4 Landing 页面同步更新
  └── 3.5 响应式适配

Phase 2: TTS 流式播放优化（用户体验提升最大）
  ├── 2.1 后端逐句推送优化
  ├── 2.2 前端即时播放优化
  └── 2.3 语音包选择优化

Phase 3: STT 信息化 + 加速（技术复杂度最高）
  ├── 1.1 STT 状态面板 UI
  ├── 1.2 后端流式 STT 接口
  └── 1.3 前端对接流式 STT
```

每个 Phase 完成后提一个 PR 合并到 main，保持小步快跑、持续集成。

---

## 快速开始

复制以下命令到 Claude Code 开始第一个任务：

```
按照 OPTIMIZATION_PLAN.md 中步骤 3.1 的要求，将 style.css 重构为小米 HyperOS 风格的 CSS 变量体系。先读取当前 style.css 了解现有样式，然后进行重构。
```
