@echo off
chcp 65001 >nul
title EyeTalk AI视觉对话助手

echo.
echo ==================================================
echo   👁️  EyeTalk AI视觉对话助手 - 启动中...
echo ==================================================
echo.

REM 切换到脚本所在目录
cd /d "%~dp0"
cd eye-talk\backend

REM 检查 Python（尝试 python → py）
set PYTHON_CMD=
python --version >nul 2>&1
if %errorlevel% equ 0 (
    set PYTHON_CMD=python
    goto :python_found
)

py --version >nul 2>&1
if %errorlevel% equ 0 (
    set PYTHON_CMD=py
    goto :python_found
)

echo.
echo 错误: 未找到 Python，请先安装 Python 3
echo 下载地址: https://www.python.org/downloads/
echo 安装时请勾选 "Add Python to PATH"
pause
exit /b 1

:python_found
echo ✓ Python: %PYTHON_CMD%

REM 检查依赖
%PYTHON_CMD% -c "import fastapi" >nul 2>&1
if %errorlevel% neq 0 (
    echo 缺少依赖包，正在安装...
    pip install -r requirements.txt
    echo.
)

REM 后台启动后端
start /B %PYTHON_CMD% main.py

REM 等待服务启动
echo 等待服务启动...
timeout /t 3 /nobreak >nul

REM 打开浏览器
start http://localhost:8000/

echo.
echo ==================================================
echo   前端页面 → http://localhost:8000/
echo   API文档  → http://localhost:8000/docs
echo   关闭此窗口停止服务
echo ==================================================
echo.

REM 保持窗口
pause
