#!/usr/bin/env bash
# 前台启动 opencode-adapter。Ctrl-C 退出。
#   ./start.sh                 # 127.0.0.1:8787
#   ./start.sh --port 9000
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js 18.17+（推荐用 https://nodejs.org 或 brew install node）" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 版本过低：$(node -v)，需要 18.17 以上" >&2
  exit 1
fi

exec node gateway.mjs "$@"
