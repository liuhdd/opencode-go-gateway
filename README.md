# opencode-adapter

> 本地转发网关：给**不支持自定义请求头**的客户端（翻译软件、旧版 IDE 插件、各类 GUI）自动补上
> OpenCode Go 要求的 `x-opencode-session` 头。零依赖，只用 Node 内置模块，默认只监听 `127.0.0.1`。

## 项目介绍

OpenCode 官方文档 [Where can I use it?](https://opencode.ai/docs/go/) 要求客户端：

1. 发送典型的 coding agent 流量；
2. 用**自己的** User-Agent 标识自己（如 `my-coding-agent/1.0`），而不是裸 SDK / HTTP 库的名字；
3. **为每一段对话发送稳定的会话 ID**（`x-opencode-session`），便于上游优化路由与 prompt 缓存。

不满足第 3 条时，上游直接拒绝：

```
400 {"type":"MissingSessionID","message":"Request is missing x-opencode-session ..."}
```

不支持自定义请求头的客户端就卡在这里。本网关只做一件事：**补头，不改业务**——注入会话 ID 后原样透传
请求体、请求头与响应（含 SSE 流式）。

## 快速开始

需要 Node.js ≥ 18.17。

```bash
cd ~/opencode-adapter

npm test      # 可选：71 个用例，确认环境正常
./start.sh    # 启动网关 → http://127.0.0.1:8787（Ctrl-C 退出）
```

在客户端里这样填：

| 配置项 | 填写内容 |
| --- | --- |
| API 地址 / Base URL | `http://127.0.0.1:8787/v1` |
| API Key | 你自己的 OpenCode Go key（形如 `oc_sk_...`），照原样填，网关透传 |
| 模型 | OpenCode 真实模型 ID，例如 `deepseek-v4-flash`、`kimi-k3` |

> 地址写成 `http://127.0.0.1:8787`（不带 `/v1`）会被自动补全，多写的 `/v1/v1` 会被自动去重。

**验证：**

```bash
# 网关状态
curl -s http://127.0.0.1:8787/_gateway/status

# 用你的真 key 让网关去上游探一次（会真的发一次 /v1/models）
curl -s -H "Authorization: Bearer oc_sk_你的key" http://127.0.0.1:8787/_gateway/check

# 模拟客户端发一次请求
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer oc_sk_你的key' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

对真实上游做端到端冒烟（含流式，A/B 对照）：

```bash
OPENCODE_API_KEY=oc_sk_你的key npm run smoke
```

## 会话 ID 策略

客户端不会告知「正在翻哪个文档」，网关按以下优先级推导：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 客户端自带 `x-opencode-session`（或 `x-session-id` / `x-conversation-id` / `x-chat-id` / `x-thread-id`） | 原样透传，绝不篡改 |
| 2 | 请求体的 `session_id` / `conversation_id` / `thread_id` | 认得出就按它派生 |
| 3 | 兜底：按**模型名**派生 | `sha256(本机盐值 + 模型名)`，纯函数，重启后依然一致 |

第 3 条是关键：**同一个模型永远映射到同一个会话 ID**，上游路由与 prompt 缓存因此能稳定命中。
每次随机生成会话 ID 会让请求在多个后端之间跳转、缓存全部失效，还可能触发风控，网关**故意不提供**这种模式。

可选模式（`--mode`）：

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `auto`（默认） | 上表 1→2→3 | 通用 |
| `model` | 只用模型名派生，忽略客户端提示 | 同一模型的所有请求共享会话 |
| `content` | 把 system prompt 也算进指纹 | 多套提示词/语言对各自独立缓存 |
| `fixed` | 固定用 `--session` 指定的 ID | 单客户端、单场景 |
| `passthrough` | **完全不注入** | 排障，用于复现 `400 MissingSessionID` |

## 常用参数

```bash
node gateway.mjs --help
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | `8787` | 监听端口 |
| `--host` | `127.0.0.1` | 监听地址，**不建议改**，改了局域网其他人也能用你的 key |
| `--upstream` | `https://opencode.ai/inference/go` | 上游地址 |
| `--mode` / `--session` | `auto` / 空 | 见上表 |
| `--log` | `info` | `silent`\|`error`\|`warn`\|`info`\|`debug` |
| `--timeout-ms` | `120000` | 上游**空闲**超时（SSE 有数据就重置，不会误杀长流） |
| `--user-agent` | `opencode-go-gateway/1.0` | 发给上游的 UA，用自己的标识，别伪装成 OpenCode 官方 |
| `--keep-user-agent` | 关 | 保留客户端原始 UA |
| `--api-key` | 空 | 留空 = 透传客户端的 key（推荐）；填了 = 用这个 key 覆盖 |
| `--model-map` | 空 | 模型名映射，例如 `--model-map "gpt-4o=deepseek-v4-flash"` |
| `--local-token` | 空 | 要求请求带 `x-gateway-token`，防本机其它程序乱用 |
| `--allow-origin` | 空 | CORS 白名单，逗号分隔；`*` 全放行。默认只放行回环来源与 `null`(file://) |
| `--use-user-hint` | 关 | 把请求体里的 `user` 也当会话提示。默认关：很多客户端按请求打点，开了会让缓存全废 |
| `--request-timeout-ms` | `300000` | Node 层请求超时，防半开连接占坑 |
| `--config` | 空 | JSON 配置文件，见 `config.example.json` |

环境变量同名：`OCG_PORT`、`OCG_UPSTREAM`、`OCG_MODE`、`OCG_LOG`、`OCG_API_KEY` …

## 后台常驻（macOS）

```bash
# 先看看会生成什么，不改系统
./scripts/install-service.sh --dry-run

# 确认后安装（写入 ~/Library/LaunchAgents/，登录自启、崩溃自动重启）
./scripts/install-service.sh --port 8787

# 卸载
./scripts/install-service.sh --uninstall
```

临时后台运行：

```bash
nohup node gateway.mjs --log warn > /tmp/opencode-adapter.log 2>&1 &
```

## 故障排查

**第一步：跑体检**，检查 Node 版本、代理环境变量、IPv4/IPv6 监听、三种地址写法的连通性与上游可达性。

```bash
./scripts/doctor.sh
```

### 客户端报 `Load failed` / `Failed to fetch` / 连接失败

这类错误说明**请求根本没发出去**，不是网关返回的业务错误（网关错误形如
`{"error":{"type":"gateway_upstream_unreachable",...}}`，软件会把它当正常响应显示）。按顺序检查：

| 检查 | 说明 |
| --- | --- |
| **网关在跑吗** | 最常见原因。网关是前台程序，关掉终端就没了；要常驻请装 LaunchAgent |
| **代理软件** | 设了 `HTTP_PROXY`/`HTTPS_PROXY`（如 Clash 的 `127.0.0.1:7897`）时，客户端若走系统代理且未排除本机地址，请求会被送到代理而失败。给代理加 `127.0.0.1,localhost,::1` 绕过，或关掉「使用系统代理」 |
| **填了 `localhost`** | 网关同时监听 IPv4 与 IPv6，`127.0.0.1` / `localhost` / `[::1]` 都通；旧版网关请更新 |
| **软件强制 HTTPS** | 少数软件只接受 `https://`，需另在本机起一个自签 TLS 反代 |
| **端口写错/被占** | 地址应为 `http://127.0.0.1:8787/v1`，端口与网关日志一致；`lsof -i :8787` 看占用 |

**还是不通就用 debug 日志抓现行**（会打印每个请求的路径、模型、会话 ID 与请求头，key 已打码）：

```bash
./start.sh --log debug
```

触发一次翻译后看日志：

- **完全没有 `新连接来自 ...`** → 请求没到网关，是上表里的问题（软件、代理、端口）
- **有 `新连接来自 ...` 和请求行** → 请求到了，日志里的状态码会说明原因

### 其它现象

| 现象 | 原因 / 处理 |
| --- | --- |
| 仍是 `400 ... missing x-opencode-session` | 请求没走网关。检查地址是否为 `http://127.0.0.1:8787/v1`，以及软件是否偷偷改回官方域名 |
| `401 Invalid credential` | 头已补上，是 key 不对 / 没订阅 Go。检查 key 与 Console 订阅状态 |
| `ECONNREFUSED 127.0.0.1:8787` | 网关没启动或端口被占，`lsof -i :8787` |
| 客户端报「模型不存在」 | 用了非 OpenCode 的模型名。改用官方 ID，或加 `--model-map` 映射 |
| 拉不到模型列表 | 配置 `http://127.0.0.1:8787/v1`（部分软件要求 base 带 `/v1`），网关支持 `/v1/models` |
| 流式翻译卡住 | 网关逐块透传、不缓冲；多半是客户端自身 SSE 解析问题，可用 `--mode passthrough` 对比 |

网关日志形如：

```
[07:26:10.832] INFO  POST /v1/chat/completions -> 200 1120ms model=deepseek-v4-flash session=ocg-fc8ec842c91e838f...
```

## 安全与合规

- **只补头，不绕过限制**：不做鉴权绕过、不做配额绕过，key 和账号还是你自己的，用量照常计费。
- **合规提醒**：文档写明 Go 面向 OpenCode 与其它 coding agent，且 *Traffic is monitored for abuse*。
  把 Go 额度用于文档翻译不在其描述的典型用途内，存在被判为异常流量的风险；翻译是主要用途时，
  建议改用按量付费的官方 API（DeepSeek / Kimi / 智谱等）。
- **别伪装成 OpenCode 官方客户端**：默认用自己的 UA `opencode-go-gateway/1.0`，符合文档要求。
- **key 安全**：默认只监听 `127.0.0.1` 且透传客户端 key，不落盘任何密钥；用了 `--api-key` 时
  进程内存会持有 key，此时不要改 `--host`。

网关自身只接受回环连接（管理端点 `/_gateway/*` 同样受限）、校验 Host 挡 DNS rebinding、CORS 默认只放行
回环来源、日志对 `authorization` / `x-api-key` / `cookie` / `x-gateway-token` 打码，均有回归测试覆盖。

## 项目结构

```
gateway.mjs                 网关本体（零依赖，CLI + 可编程 API）
config.example.json         配置示例
start.sh                    前台启动
scripts/smoke-live.mjs      对真实上游的端到端冒烟（A/B 对照）
scripts/doctor.sh           体检：端口/代理/IPv4-IPv6/上游可达性
scripts/install-service.sh  macOS LaunchAgent 安装/卸载
test/gateway.test.mjs       71 个自动化测试
test/mock-upstream.mjs      测试用 mock 上游（记录收到的每个请求头）
```

`gateway.mjs` 同时是可导入模块：

```js
import { resolveConfig, startServer } from './gateway.mjs';
const cfg = resolveConfig(['--port', '0', '--log', 'silent'], {});
const server = await startServer(cfg);
console.log(`网关监听在 ${server.address().port}`);
```
