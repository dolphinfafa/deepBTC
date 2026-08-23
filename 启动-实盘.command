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
  echo "未找到 .env。请先复制 .env.example，并按 README 填写 Decibel 实盘凭据与风控上限。"
  read "?按回车退出..."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "正在安装锁定版本的依赖..."
  npm ci --no-audit --no-fund
fi

echo
echo "实盘订单将发送到 Decibel。请确认网页端可随时人工接管。"
read "?输入 DECIBEL 继续: " confirmation
if [[ "$confirmation" != "DECIBEL" ]]; then
  exit 0
fi

(sleep 3 && open "http://127.0.0.1:15000/live") &
npm start
