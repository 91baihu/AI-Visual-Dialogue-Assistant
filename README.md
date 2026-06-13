# EyeTalk — AI 视觉对话助手

> 七牛云 XEngineer 暑期实训营 · 第四批次 · 题目一

## 项目简介

EyeTalk 是一款基于多模态AI的实时视觉对话助手。用户打开摄像头后，AI 能够实时"看到"摄像头画面，并给予自然流畅的回应。支持文字对话、语音输入、快捷指令、自动观察等功能。

## 核心特性

- 🎥 **实时视觉理解** — AI 能识别摄像头中的物体、场景、文字
- 🎙️ **语音交互** — 按住说话，识别结果自动发送
- 💬 **多轮对话** — AI 记住上下文，支持连续对话
- 🔍 **智能帧采样** — MSE 差异检测，静止画面不重复调用 API
- 🔍 **自动观察模式** — 每 2 秒检测画面变化，自动通知 AI
- ⚡ **快捷指令** — OCR识别、翻译、识别物体、描述场景、截图保存
- 💰 **费用统计** — 实时追踪 Token 用量和预估费用
- 🎨 **深色主题** — 现代感 UI，圆角卡片 + 光晕效果
- 🔄 **多模型切换** — 支持 5 家 AI 提供商，前端一键切换

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 原生 HTML + CSS + JavaScript |
| 后端 | Python FastAPI + WebSocket |
| AI服务 | 多提供商 OpenAI 兼容格式（DeepSeek / 通义千问 / 智谱 / Kimi / OpenAI） |

## 多模型支持

EyeTalk 支持以下 AI 提供商，可通过前端设置面板一键切换：

| 提供商 | 聊天模型 | 视觉模型 | 特点 |
|--------|----------|----------|------|
| DeepSeek | deepseek-chat | deepseek-v4-pro | 国产高性价比，响应速度快 |
| 通义千问 | qwen-turbo | qwen-vl-max | 阿里云出品，多模态能力强 |
| 智谱 GLM | glm-4-flash | glm-4v | 清华系模型，中文理解优秀 |
| Kimi | moonshot-v1-8k | moonshot-v1-8k-vision | 长文本处理见长，支持多模态 |
| OpenAI | gpt-4o-mini | gpt-4o | 全球领先的多模态模型 |

### 切换方式

点击页面右上角 **⚙️ 设置** 按钮，选择提供商并输入 API Key，保存即可。切换后所有对话自动使用新提供商，无需重启。

## Demo 演示

<!-- TODO: 录制演示视频并替换链接 -->

[📹 Demo 视频（待补充）](https://github.com/91baihu/AI-Visual-Dialogue-Assistant/issues/1)

## 项目结构

```
eye-talk/
├── backend/
│   ├── main.py            # FastAPI 后端入口 + WebSocket + /api/config
│   ├── ai_service.py      # ChatService + PROVIDER_CONFIG + TokenUsage + Vision 降级
│   ├── test_api.py        # API 测试脚本
│   ├── requirements.txt   # Python 依赖
│   └── .env               # 环境变量（API Key）
└── frontend/
    ├── index.html         # 页面骨架 + 设置弹窗
    ├── style.css          # 深色主题样式
    └── app.js             # 前端逻辑 + 设置面板交互

docs/
├── 02-用户故事-实现情况.md
└── 05-成本控制-实测数据.md
```

## 快速启动

### 环境要求

- Python >= 3.9
- 现代浏览器（Chrome / Edge / Firefox）

### 方式一：一键启动

```bash
# Linux / macOS
./start.sh

# Windows
start.bat
```

### 方式二：手动启动

```bash
cd eye-talk/backend
pip install -r requirements.txt
python main.py
```

看到以下输出表示启动成功：

```
==================================================
  EyeTalk AI视觉对话助手
==================================================
  后端API地址  → http://localhost:8000
  前端页面地址 → http://localhost:8000/
  API文档地址  → http://localhost:8000/docs
==================================================
```

前端由后端统一托管，直接访问 **http://localhost:8000** 即可使用，无需单独启动前端服务。

### 开始使用

1. 打开 http://localhost:8000 → 点击 **⚙️ 设置** 配置 API Key
2. 点击「▶ 开始摄像头」→ 允许摄像头权限
3. 输入文字或按住「🎤 按住说话」发送消息
4. AI 回复会自动语音朗读

## 配置说明

### 方式一：前端设置面板（推荐）

1. 点击页面右上角 **⚙️ 设置** 按钮
2. 在下拉菜单中选择 AI 提供商
3. 输入对应的 API Key
4. 点击 **保存**，系统自动验证密钥并切换

设置面板会显示每个提供商的 API Key 申请链接，以及当前连接状态。

### 方式二：手动编辑 .env（高级用户）

编辑 `eye-talk/backend/.env`：

```env
# 选择提供商：deepseek / qwen / zhipu / kimi / openai
AI_PROVIDER=deepseek

# 对应提供商的 API Key（填哪个就用哪个）
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
ZHIPU_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
KIMI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

> 修改 .env 后需要重启后端才能生效。推荐使用前端设置面板，无需重启。

## 功能操作指南

| 功能 | 操作 |
|------|------|
| 文字对话 | 输入框输入文字 → 点「发送」或按回车 |
| 语音输入 | 按住「🎤 按住说话」→ 说话 → 松开自动发送 |
| 拍照分析 | 开启摄像头 → 发送消息 → 自动附带截图 |
| 自动观察 | 打开「🔍 自动观察模式」开关 → AI 持续关注画面变化 |
| OCR识别 | 点「📷 OCR识别」→ 自动截图+识别文字 |
| 翻译 | 点「🌐 翻译」→ 识别外文并翻译成中文 |
| 识别物体 | 点「🔍 识别物体」→ 识别画面中的物体 |
| 描述场景 | 点「📝 描述场景」→ 详细描述当前场景 |
| 截图保存 | 点「💾 截图」→ 保存当前帧+AI回复为 PNG |
| 费用统计 | 底部状态栏实时显示 API 调用次数、Token、费用 |
| 断线重连 | 连接断开后自动重连，或点「🔄 重连」手动重连 |
| 切换模型 | 点「⚙️ 设置」→ 选提供商 → 输入 Key → 保存 |

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 重定向到前端页面 |
| `/ws` | WebSocket | 对话服务 |
| `/api/health` | GET | 健康检查，返回当前提供商和密钥状态 |
| `/api/config` | GET | 获取当前配置（提供商、模型、密钥状态、连接状态） |
| `/api/config` | POST | 更新配置（切换提供商 / 设置 API Key） |
| `/api/stats` | GET | Token 用量和费用统计 |

### GET /api/config 响应

```json
{
  "provider": "deepseek",
  "provider_name": "DeepSeek",
  "chat_model": "deepseek-chat",
  "vision_model": "deepseek-v4-pro",
  "supports_vision": true,
  "configured": {
    "deepseek": true,
    "qwen": false,
    "zhipu": false,
    "kimi": false,
    "openai": false
  },
  "connection_ok": true,
  "connection_reason": ""
}
```

### POST /api/config 请求

```json
{
  "provider": "qwen",
  "api_key": "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
}
```

### WebSocket 消息格式

**发送：**
```json
{"type": "chat", "text": "用户说的话", "image": "data:image/jpeg;base64,..."}
{"type": "clear"}
```

**接收：**
```json
{"type": "reply", "text": "AI回复", "usage": {"total_calls": 1, "total_tokens": 74, "estimated_cost": 0.0001}}
```

## 运行测试

```bash
cd eye-talk/backend
python test_api.py
```

测试覆盖：提供商配置完整性、API Key 校验、提供商切换、无效输入拒绝、WebSocket 消息处理等。

## 许可证

MIT License
