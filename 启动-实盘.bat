@echo off
chcp 65001 >nul
title GridPilot Decibel - LIVE
cd /d "%~dp0"

if not exist ".env" (
  echo [错误] 未找到 .env，请先按 README 配置实盘总闸门与 Decibel 凭据。
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js 20 或更高版本。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [安装] 正在安装锁定版本的依赖...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo 实盘订单将发送到 Decibel。请确认网页端可人工接管。
set /p CONFIRM="输入 DECIBEL 继续: "
if /i not "%CONFIRM%"=="DECIBEL" exit /b 0

start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:15000/live"
node src/server.js
pause
