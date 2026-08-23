@echo off
chcp 65001 >nul
title GridPilot Decibel - Paper
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 20 或更高版本。
  start https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)

if not exist ".env" copy ".env.example" ".env" >nul

if not exist "node_modules" (
  echo [安装] 正在安装首次运行所需组件...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo [启动] GridPilot 模拟盘：http://127.0.0.1:15000/paper
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:15000/paper"
node src/server.js
pause
