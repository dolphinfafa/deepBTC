#!/bin/zsh
cd "$(dirname "$0")"

echo "推送 GridPilot-Decibel 到 GitHub..."
echo "仓库: $(git remote get-url origin 2>/dev/null || echo '未绑定')"
echo

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "尚未绑定远程仓库。"
  read "?请输入仓库地址（例如 https://github.com/用户名/仓库名.git）: " url
  git remote add origin "$url"
fi

git push -u origin main
status=$?

echo
if [ $status -eq 0 ]; then
  echo "✅ 推送成功。"
else
  echo "推送未完成。若提示登录，按提示完成 GitHub 授权后重新双击本脚本即可。"
fi
read "?按回车关闭窗口..."
