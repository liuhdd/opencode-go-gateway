#!/usr/bin/env bash
# 把 opencode-go-gateway 装成 macOS 登录自启服务（LaunchAgent）。
#
#   ./scripts/install-service.sh --dry-run     # 只打印 plist，不装
#   ./scripts/install-service.sh               # 安装并立即启动
#   ./scripts/install-service.sh --uninstall   # 卸载
#   ./scripts/install-service.sh --port 9000   # 指定端口
#   ./scripts/install-service.sh --force       # 端口被占时先结束占用进程
#
# 注意：这一步会写入 ~/Library/LaunchAgents/，属于对系统的修改，
# 请确认你确实需要开机自启再执行。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.opencode-go-gateway"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/opencode-go-gateway"

PORT=8787
MODE=auto
DRY_RUN=0
UNINSTALL=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --force) FORCE=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ "$UNINSTALL" = "1" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载 $LABEL"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "找不到 node，请先安装 Node.js 18.17+" >&2
  exit 1
fi

# 本机有 config.json 就一并交给网关；--port/--mode 等命令行参数优先级更高，
# 所以放在这里不会顶掉上面的显式设置。
CONFIG_XML=""
if [ -f "$ROOT/config.json" ]; then
  CONFIG_XML="    <string>--config</string>
    <string>$ROOT/config.json</string>"
fi

PLIST_CONTENT="$(cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/gateway.mjs</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--mode</string>
    <string>$MODE</string>
$CONFIG_XML
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOGDIR/gateway.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGDIR/gateway.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF
)"

if [ "$DRY_RUN" = "1" ]; then
  echo "$PLIST_CONTENT"
  exit 0
fi

# 端口被别的进程占着的话，LaunchAgent 会启动失败并无限重启 —— 先处理掉
EXISTING_PID=""
if command -v lsof >/dev/null 2>&1; then
  EXISTING_PID="$(lsof -nP -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
fi
if [ -n "$EXISTING_PID" ]; then
  EXISTING_CMD="$(ps -p "$EXISTING_PID" -o command= 2>/dev/null || echo '(未知进程)')"
  echo "端口 $PORT 已被占用："
  echo "  PID $EXISTING_PID  $EXISTING_CMD"
  if [ "$FORCE" = "1" ]; then
    echo "  --force 已指定，正在结束它..."
    kill -TERM "$EXISTING_PID" 2>/dev/null || true
    sleep 1
    if lsof -nP -ti :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  它没退出，改用 SIGKILL"; kill -9 "$EXISTING_PID" 2>/dev/null || true; sleep 1
    fi
  else
    echo
    echo "它多半是之前手动启动的网关。请二选一："
    echo "  1) 让本脚本接手：  $0 --port $PORT --force"
    echo "  2) 先手动停掉：    kill $EXISTING_PID"
    exit 1
  fi
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
printf '%s\n' "$PLIST_CONTENT" > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

sleep 1
echo "已安装并启动: $LABEL"
echo "plist: $PLIST"
echo "日志:  $LOGDIR/gateway.err.log"
echo "自检:  curl http://127.0.0.1:$PORT/_gateway/status"
echo
echo "把翻译软件的 API 地址填成: http://127.0.0.1:$PORT/v1"
