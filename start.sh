#!/bin/bash

# EyeTalk AI视觉对话助手 - 启动脚本

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/eye-talk/backend"
PORT=8000

# 解析参数
OPEN_BROWSER=true
for arg in "$@"; do
    case "$arg" in
        --no-browser) OPEN_BROWSER=false ;;
    esac
done

echo ""
echo "=================================================="
echo "  👁️  EyeTalk AI视觉对话助手 - 启动中..."
echo "=================================================="
echo ""

# ---- 1. 检查 Python ----
PYTHON_CMD=""
if command -v python3 &>/dev/null && python3 --version &>/dev/null; then
    PYTHON_CMD="python3"
elif command -v python &>/dev/null && python --version &>/dev/null; then
    PYTHON_CMD="python"
else
    echo "错误: 未找到 Python，请先安装 Python 3"
    exit 1
fi

PY_VERSION=$($PYTHON_CMD --version 2>&1)
echo "✓ Python: $PY_VERSION ($PYTHON_CMD)"

# ---- 2. 检查并安装依赖 ----
cd "$BACKEND_DIR" || { echo "错误: 找不到后端目录 $BACKEND_DIR"; exit 1; }

if ! $PYTHON_CMD -c "import fastapi" &>/dev/null; then
    echo "⚠ 缺少依赖包，正在安装..."
    $PYTHON_CMD -m pip install -r requirements.txt
    if [ $? -ne 0 ]; then
        echo "错误: 依赖安装失败，请手动执行: pip install -r requirements.txt"
        exit 1
    fi
    echo "✓ 依赖安装完成"
else
    echo "✓ 依赖包已就绪"
fi

# ---- 3. 检查端口占用 ----
if command -v lsof &>/dev/null; then
    PORT_PID=$(lsof -ti :$PORT 2>/dev/null)
elif command -v netstat &>/dev/null; then
    PORT_PID=$(netstat -tlnp 2>/dev/null | grep ":$PORT " | awk '{print $NF}' | cut -d'/' -f1)
fi

if [ -n "$PORT_PID" ]; then
    echo ""
    echo "⚠ 端口 $PORT 已被进程 $PORT_PID 占用"
    echo "  请先停止该进程，或手动指定其他端口"
    echo "  终止命令: kill $PORT_PID"
    echo ""
    exit 1
fi

echo ""

# ---- 启动服务 ----

# 清理函数：终止后端进程
cleanup() {
    echo ""
    echo "正在停止后端服务..."
    kill "$BACKEND_PID" 2>/dev/null
    wait "$BACKEND_PID" 2>/dev/null
    echo "已停止。"
    exit 0
}

# 捕获 Ctrl+C 和终止信号
trap cleanup SIGINT SIGTERM

# 后台启动后端
$PYTHON_CMD main.py &
BACKEND_PID=$!

# 等待服务启动
echo "等待服务启动..."
sleep 3

# 自动打开浏览器
if [ "$OPEN_BROWSER" = true ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open "http://localhost:$PORT/"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        xdg-open "http://localhost:$PORT/" 2>/dev/null
    fi
fi

echo ""
echo "=================================================="
echo "  前端页面 → http://localhost:$PORT/"
echo "  API文档  → http://localhost:$PORT/docs"
if [ "$OPEN_BROWSER" = false ]; then
    echo "  (已跳过自动打开浏览器)"
fi
echo "  按 Ctrl+C 停止服务"
echo "=================================================="
echo ""

# 前台等待后端进程
wait "$BACKEND_PID"
