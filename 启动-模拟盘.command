#!/bin/zsh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 20 或更高版本。"
  open "https://nodejs.org/zh-cn/download"
  read "?安装完成后按回车退出..."
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

if [[ ! -d node_modules ]]; then
  echo "正在安装首次运行所需组件..."
  npm ci --no-audit --no-fund
fi

(sleep 3 && open "http://127.0.0.1:15000") &
npm start
