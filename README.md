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

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 原生 HTML + CSS + JavaScript |
| 后端 | Python FastAPI + WebSocket |
| AI服务 | DeepSeek API (OpenAI 兼容格式) |

## 项目结构

```
AI-Visual-Dialogue-Assistant/
├── start.sh               # 一键启动脚本（Linux / Mac）
├── start.bat              # 一键启动脚本（Windows）
├── README.md
├── eye-talk/
│   ├── backend/
│   │   ├── main.py            # FastAPI 后端入口 + 静态文件挂载 + WebSocket
│   │   ├── ai_service.py      # ChatService + TokenUsage + Vision 降级
│   │   ├── test_api.py        # API 测试脚本
│   │   ├── requirements.txt   # Python 依赖
│   │   └── .env               # 环境变量（API Key）
│   └── frontend/
│       ├── index.html         # 页面骨架
│       ├── style.css          # 深色主题样式
│       └── app.js             # 前端逻辑
└── docs/
    ├── 02-用户故事-实现情况.md
    └── 05-成本控制-实测数据.md
```

## 快速启动

### 环境要求

- Python >= 3.9
- 现代浏览器（Chrome / Edge / Firefox）

### 第一步：配置 API Key

编辑 `eye-talk/backend/.env`，将 `your_key_here` 替换为你的 DeepSeek API Key：

```
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

> API Key 从 [platform.deepseek.com](https://platform.deepseek.com) 获取

### 第二步：一键启动

**Linux / Mac：**
```bash
chmod +x start.sh
./start.sh
```

**Windows：**
```cmd
start.bat
```

脚本会自动检查 Python 环境、安装依赖、启动后端并打开浏览器。

启动成功后浏览器自动访问 http://localhost:8000/

### 手动启动

如果一键脚本不可用，也可以手动操作：

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

然后访问 http://localhost:8000/ 即可使用。

> 如果端口 8000 被占用，程序会自动切换到 8001 并提示。

### 启动脚本功能

| 功能 | 说明 |
|------|------|
| Python 检测 | 自动查找 `python3` / `python` / `py` |
| 依赖检查 | 缺少 `fastapi` 等包时自动 `pip install` |
| 端口冲突 | 自动尝试下一个可用端口，并提示占用进程 PID |
| 浏览器 | 启动后自动打开 `http://localhost:8000/` |
| `--no-browser` | `./start.sh --no-browser` 跳过自动开浏览器 |

### 第三步：开始使用

1. 点击「▶ 开始摄像头」→ 允许摄像头权限
2. 输入文字或按住「🎤 按住说话」发送消息
3. AI 回复会自动语音朗读

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

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 重定向到前端页面 |
| `/app/*` | GET | 前端静态文件（HTML/CSS/JS） |
| `/api/health` | GET | 健康检查 |
| `/api/stats` | GET | Token 用量和费用统计 |
| `/ws` | WebSocket | 对话服务 |
| `/docs` | GET | FastAPI 交互式 API 文档 |

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

## 常见问题

### 端口被占用

```
端口 8000 已被占用 (PID: 12345)，自动切换到端口 8001
```

程序会自动切换端口。如需释放原端口：

```cmd
# Windows
taskkill /F /PID 12345

# Linux / Mac
kill 12345
```

### 前端页面打不开

1. 确认后端已启动（终端显示 `Uvicorn running on`）
2. 访问 http://localhost:8000/app/（注意尾部斜杠）
3. 检查防火墙是否放行 8000 端口

### Python 未找到

- 确保已安装 Python 3.9+ 并添加到 PATH
- Windows 用户也可使用 `py` 命令代替 `python`

### API Key 未配置

```
{"status":"ok","api_key_configured": false}
```

编辑 `eye-talk/backend/.env` 填入正确的 DeepSeek API Key。

## 运行测试

```bash
# API 测试（需要配置 API Key）
cd eye-talk/backend
python test_api.py
```

## 许可证

MIT License
