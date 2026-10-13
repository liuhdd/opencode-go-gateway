#!/usr/bin/env bash
# 体检：定位翻译软件报 "Load failed" / 连不上的原因。
#   ./scripts/doctor.sh [端口，默认 8787]
set -uo pipefail

PORT="${1:-8787}"
PASS=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo "opencode-adapter 体检 (端口 $PORT)"
echo

# 1. Node
echo "[1/5] Node.js"
if command -v node >/dev/null 2>&1; then
  V="$(node -v)"
  MAJOR="${V#v}"; MAJOR="${MAJOR%%.*}"
  if [ "$MAJOR" -ge 18 ]; then ok "node $V"; else bad "node $V 版本过低（需要 18.17+）"; fi
else
  bad "找不到 node"
fi

# 2. 代理环境变量（最常见的隐形杀手）
echo "[2/5] 代理环境变量（会让本机请求被送到代理，从而连不上）"
PROXY_FOUND=0
for V in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; do
  VAL="${!V:-}"
  if [ -n "$VAL" ]; then
    warn "$V=$VAL"
    PROXY_FOUND=1
  fi
done
if [ -n "${NO_PROXY:-}${no_proxy:-}" ]; then
  ok "NO_PROXY=${NO_PROXY:-${no_proxy}}"
elif [ "$PROXY_FOUND" = "1" ]; then
  warn "设了代理但没设 NO_PROXY，建议 export NO_PROXY=127.0.0.1,localhost,::1"
else
  ok "未设置代理环境变量"
fi

# 3. 端口监听（IPv4 / IPv6 都要在）
echo "[3/5] 端口 $PORT 监听情况"
if command -v lsof >/dev/null 2>&1; then
  LISTEN="$(lsof -nP -i :"$PORT" -sTCP:LISTEN 2>/dev/null)"
  if [ -z "$LISTEN" ]; then
    bad "没有任何进程监听 $PORT —— 网关没启动（这就是 Load failed 最常见的原因）"
    echo "      启动它:  cd \"$(cd "$(dirname "$0")/.." && pwd)\" && ./start.sh"
  else
    if echo "$LISTEN" | grep -q IPv4; then ok "IPv4 监听中"; else bad "缺少 IPv4 监听"; fi
    if echo "$LISTEN" | grep -q IPv6; then ok "IPv6 监听中"; else warn "缺少 IPv6 监听（客户端填 localhost 时可能失败）"; fi
  fi
else
  warn "没有 lsof，跳过"
fi

# 4. 三种地址写法连通性
echo "[4/5] 连通性（翻译软件填哪种写法都得通）"
for U in "http://127.0.0.1:$PORT/_gateway/health" "http://[::1]:$PORT/_gateway/health" "http://localhost:$PORT/_gateway/health"; do
  CODE="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$U" 2>/dev/null || echo 000)"
  if [ "$CODE" = "200" ]; then ok "$U -> 200"; else bad "$U -> $CODE"; fi
done

# 5. 上游可达性
echo "[5/5] 上游 opencode.ai 可达性"
CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://opencode.ai/inference/go/v1/models 2>/dev/null || echo 000)"
if [ "$CODE" = "401" ] || [ "$CODE" = "200" ]; then
  ok "上游可达（HTTP ${CODE}，未带 key 时 401 属正常）"
elif [ "$CODE" = "000" ]; then
  bad "连不上上游 —— 检查网络/代理"
else
  warn "上游返回 HTTP ${CODE}（预期 401）"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m全部通过\033[0m（%d 项）。\n' "$PASS"
  echo
  echo "翻译软件里填："
  echo "  API 地址:  http://127.0.0.1:$PORT/v1"
  echo "  API Key :  你的 oc_sk_... 原样填"
else
  printf '\033[31m有 %d 项不通过\033[0m，按上面的提示处理。\n' "$FAIL"
fi
echo
echo "如果上面全绿、翻译软件仍报 Load failed："
echo "  1) 用 --log debug 前台启动网关，再触发一次翻译："
echo "       ./start.sh --log debug"
echo "  2) 看有没有 '新连接来自 ...' 这行日志："
echo "       没有 -> 请求根本没发出来，多半是软件要求 HTTPS，或它有自己的联网开关/代理设置"
echo "       有   -> 会紧接着打出该请求的状态码，把日志贴出来即可定位"
