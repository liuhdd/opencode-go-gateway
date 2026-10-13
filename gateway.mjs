#!/usr/bin/env node
/**
 * opencode-go 本地转发网关 (opencode-adapter)
 *
 * 作用：给不支持自定义请求头的客户端（翻译软件、旧版 IDE 插件等）
 * 自动补上 OpenCode Go 要求的 `x-opencode-session` 头，并把请求原样转发到
 * https://opencode.ai/inference/go 。
 *
 * 零依赖，只用 Node 内置模块。默认只监听 127.0.0.1。
 *
 *   node gateway.mjs                    # 监听 127.0.0.1:8787
 *   node gateway.mjs --port 9000 --log debug
 *   node gateway.mjs --print-config
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  upstream: 'https://opencode.ai/inference/go',
  /** auto | model | content | fixed | passthrough */
  mode: 'auto',
  /** mode=fixed 时使用的固定会话 ID */
  session: '',
  /** 会话 ID 前缀 */
  sessionPrefix: 'ocg',
  /** 参与指纹计算的本地盐值，默认按 机器+用户 自动派生 */
  salt: '',
  logLevel: 'info', // silent | error | warn | info | debug
  timeoutMs: 120000,
  maxBodyBytes: 32 * 1024 * 1024,
  userAgent: `opencode-go-gateway/${VERSION}`,
  keepUserAgent: false,
  /** 若设置，则覆盖客户端传来的 Authorization */
  apiKey: '',
  /** { "客户端里的模型名": "opencode 真实模型 id" } */
  modelMap: {},
  /** 允许携带 Origin 的请求通过（默认仅在配置了 apiKey 时拦截浏览器来源） */
  allowBrowser: false,
  /** CORS 白名单：逗号分隔的来源，或 '*'。留空 = 只放行回环来源与 null */
  allowOrigin: '',
  /** 是否把请求体里的 user 字段也当成会话提示（默认关：很多客户端按请求打点，会毁掉缓存） */
  useUserHint: false,
  /** Node 层请求超时（防半开连接占坑） */
  requestTimeoutMs: 300000,
  /** 若设置，请求必须带 x-gateway-token: <值> */
  localToken: '',
  config: '',
};

const ENV_MAP = {
  OCG_HOST: 'host',
  OCG_PORT: 'port',
  OCG_UPSTREAM: 'upstream',
  OCG_MODE: 'mode',
  OCG_SESSION: 'session',
  OCG_SESSION_PREFIX: 'sessionPrefix',
  OCG_SALT: 'salt',
  OCG_LOG: 'logLevel',
  OCG_TIMEOUT_MS: 'timeoutMs',
  OCG_MAX_BODY_BYTES: 'maxBodyBytes',
  OCG_USER_AGENT: 'userAgent',
  OCG_API_KEY: 'apiKey',
  OCG_LOCAL_TOKEN: 'localToken',
  OCG_ALLOW_ORIGIN: 'allowOrigin',
  OCG_USE_USER_HINT: 'useUserHint',
  OCG_REQUEST_TIMEOUT_MS: 'requestTimeoutMs',
};

const NUMERIC_KEYS = new Set(['port', 'timeoutMs', 'maxBodyBytes', 'requestTimeoutMs']);
const BOOLEAN_KEYS = new Set(['keepUserAgent', 'allowBrowser', 'useUserHint']);
/** 命令行别名 -> 规范配置项名 */
const ARG_ALIASES = { log: 'logLevel' };

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function coerce(key, value) {
  if (NUMERIC_KEYS.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`配置项 ${key} 需要是数字，收到: ${value}`);
    return n;
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === 'boolean') return value;
    return !['0', 'false', 'no', 'off', ''].includes(String(value).toLowerCase());
  }
  return value;
}

export function parseArgv(argv) {
  const out = {};
  // 保留用户原始拼写，方便报错时原样回显
  Object.defineProperty(out, 'RAW', { value: {}, enumerable: false });
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const rawKey = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const key = ARG_ALIASES[rawKey] ?? camel(rawKey);
    out.RAW[key] = rawKey;
    if (eq !== -1) {
      out[key] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseModelMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  const map = {};
  for (const pair of String(raw).split(',')) {
    const t = pair.trim();
    if (!t) continue;
    const idx = t.indexOf('=');
    if (idx === -1) throw new Error(`--model-map 需要 "别名=真实模型id" 形式，收到: ${t}`);
    map[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return map;
}

export function resolveConfig(argv = [], env = process.env) {
  const args = parseArgv(argv);
  // 先让日志级别生效，后面的告警才会听话
  const earlyLevel = args.logLevel ?? env.OCG_LOG;
  if (earlyLevel && earlyLevel in LEVELS) currentLogLevel = LEVELS[earlyLevel];
  let cfg = { ...DEFAULTS };

  // 1) 配置文件（最低优先级，可被 env / CLI 覆盖）
  const configPath = args.config || env.OCG_CONFIG || '';
  if (configPath) {
    const abs = path.resolve(configPath);
    if (!fs.existsSync(abs)) throw new Error(`配置文件不存在: ${abs}`);
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('//') || k.startsWith('_') || k.startsWith('#')) continue; // 允许写注释
      const key = camel(k);
      if (!(key in DEFAULTS)) {
        warn(`配置文件里有未知配置项，已忽略: ${k}`);
        continue;
      }
      cfg[key] = coerce(key, v);
    }
    cfg.config = abs;
  }

  // 2) 环境变量
  for (const [envKey, key] of Object.entries(ENV_MAP)) {
    const raw = env[envKey];
    if (raw !== undefined && raw !== '') cfg[key] = coerce(key, raw);
  }

  // 3) 命令行
  for (const [key, value] of Object.entries(args)) {
    if (key === 'help' || key === 'printConfig' || key === 'version') continue;
    if (!(key in DEFAULTS)) {
      warn(`未知命令行参数，已忽略: --${args.RAW?.[key] ?? key}`);
      continue;
    }
    cfg[key] = key === 'modelMap' ? parseModelMap(value) : coerce(key, value);
  }

  if (typeof cfg.modelMap === 'string') cfg.modelMap = parseModelMap(cfg.modelMap);
  if (!cfg.userAgent || cfg.keepUserAgent) cfg.userAgent = cfg.userAgent || DEFAULTS.userAgent;

  if (!['silent', 'error', 'warn', 'info', 'debug'].includes(cfg.logLevel)) {
    throw new Error(`--log 只能是 silent|error|warn|info|debug，收到: ${cfg.logLevel}`);
  }
  if (!['auto', 'model', 'content', 'fixed', 'passthrough'].includes(cfg.mode)) {
    throw new Error(`--mode 只能是 auto|model|content|fixed|passthrough，收到: ${cfg.mode}`);
  }
  if (cfg.mode === 'fixed' && !cfg.session) {
    throw new Error('--mode fixed 必须同时提供 --session <会话ID>');
  }

  // 上游地址合法性
  const upstream = new URL(cfg.upstream);
  if (!['http:', 'https:'].includes(upstream.protocol)) {
    throw new Error(`上游地址必须是 http/https: ${cfg.upstream}`);
  }
  if (!cfg.salt) {
    cfg.salt = crypto
      .createHash('sha256')
      .update(`${os.hostname()}|${safeUsername()}|${cfg.sessionPrefix}`)
      .digest('hex')
      .slice(0, 16);
  }
  // 会写进 HTTP 头的配置值必须是 latin1 安全的，否则每个请求都会 500
  for (const key of ['session', 'sessionPrefix', 'userAgent', 'apiKey', 'localToken']) {
    const v = cfg[key];
    if (v && !/^[\x20-\x7e\x80-\xff\t]*$/.test(v)) {
      throw new Error(`配置项 ${key} 含有不能放进 HTTP 头的字符（只能是 latin1）：${JSON.stringify(v)}`);
    }
  }
  if (typeof cfg.allowOrigin === 'string' && cfg.allowOrigin.trim()) {
    cfg.allowOrigin = cfg.allowOrigin.split(',').map((x) => x.trim()).filter(Boolean);
  }
  currentLogLevel = LEVELS[cfg.logLevel] ?? LEVELS.info;
  return cfg;
}

function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
let currentLogLevel = LEVELS.info;

function warn(msg) {
  if (currentLogLevel >= LEVELS.warn) process.stderr.write(`[warn] ${msg}\n`);
}
function log(level, msg) {
  if (currentLogLevel < LEVELS[level]) return;
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}\n`);
}
function mask(value) {
  if (!value) return '(空)';
  const s = String(value);
  if (s.length <= 12) return `${s.slice(0, 4)}***`;
  return `${s.slice(0, 8)}...${s.slice(-4)} (len=${s.length})`;
}

/* ------------------------------------------------------------------ *
 * 会话 ID 推导
 * ------------------------------------------------------------------ */

const SESSION_HEADER_CANDIDATES = [
  'x-opencode-session',
  'x-session-id',
  'x-conversation-id',
  'x-chat-id',
  'x-thread-id',
  'x-request-session',
];

const BODY_SESSION_KEYS = [
  'session_id',
  'sessionId',
  'conversation_id',
  'conversationId',
  'thread_id',
  'threadId',
  'chat_id',
  'chatId',
];

function sanitizeSession(v) {
  const s = String(v).replace(/[\r\n\t]/g, '').trim();
  return s ? s.slice(0, 190) : '';
}

/** 只认真正的客户端会话提示，不做任何猜测 */
export function headerSessionHint(headers = {}) {
  for (const name of SESSION_HEADER_CANDIDATES) {
    const v = headers[name];
    if (typeof v === 'string') {
      const s = sanitizeSession(v);
      if (s) return s;
    }
  }
  return '';
}

export function bodySessionHint(body, cfg = {}) {
  if (!body || typeof body !== 'object') return '';
  const pools = [body, body.metadata, body.meta];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    for (const key of BODY_SESSION_KEYS) {
      const v = pool[key];
      if (typeof v === 'string' && v.trim()) return sanitizeSession(`body:${v}`);
    }
  }
  // user 字段默认**不**当会话提示：OpenAI 的 user 常被客户端按请求打点，
  // 逐次变化会让会话 ID 每次都不同，上游 prompt cache 直接全废。
  if (cfg.useUserHint && typeof body.user === 'string' && body.user.trim()) {
    return sanitizeSession(`user:${body.user}`);
  }
  return '';
}

function collectSystemText(body) {
  if (!body || typeof body !== 'object') return '';
  const bits = [];
  const pushContent = (c) => {
    if (typeof c === 'string') bits.push(c);
    else if (Array.isArray(c)) {
      for (const part of c) bits.push(typeof part === 'string' ? part : (part?.text ?? ''));
    }
  };
  pushContent(body.system);
  pushContent(body.instructions);
  const msgs = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'system' && m.role !== 'developer') continue;
    pushContent(m.content);
  }
  return bits.join('\n').trim();
}

export function fingerprintSession(cfg, parts) {
  const h = crypto.createHash('sha256');
  h.update(cfg.salt);
  h.update('\u0000');
  for (const p of parts) {
    h.update(String(p ?? ''));
    h.update('\u0000');
  }
  return `${cfg.sessionPrefix}-${h.digest('hex').slice(0, 32)}`;
}

/**
 * 返回本次请求要用的会话 ID；passthrough 模式返回 ''（不注入）。
 * 设计目标：同一个客户端配置下，会话 ID 必须**稳定**，否则上游的路由与
 * prompt cache 反而更差。
 */
export function resolveSession(cfg, headers, body) {
  if (cfg.mode === 'passthrough') return '';
  if (cfg.mode === 'fixed') return sanitizeSession(cfg.session);
  if (cfg.mode === 'model') {
    return fingerprintSession(cfg, ['model', body?.model ?? '']);
  }
  if (cfg.mode === 'content') {
    const sys = collectSystemText(body);
    const sysFp = sys ? crypto.createHash('sha256').update(sys).digest('hex').slice(0, 16) : '';
    return fingerprintSession(cfg, ['content', body?.model ?? '', sysFp]);
  }
  // auto：客户端显式给了就用它的（同一会话跨请求保持稳定）；
  // 否则退回到 client 自己提供的 user / session_id 提示；
  // 再否则用「模型」派生一个稳定值，保证 prompt cache 有效。
  const fromHeader = headerSessionHint(headers);
  if (fromHeader) return fromHeader;
  const fromBody = bodySessionHint(body, cfg);
  if (fromBody) return fingerprintSession(cfg, ['auto', fromBody]);
  return fingerprintSession(cfg, ['auto', body?.model ?? '']);
}

/* ------------------------------------------------------------------ *
 * 路径 / 请求头处理
 * ------------------------------------------------------------------ */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
  'host',
  'content-length',
  'expect',
  'x-gateway-token', // 网关自己的本地令牌，绝不能泄漏给上游
]);

/**
 * 响应方向的逐跳头。与请求方向不同：**content-length 必须保留**
 * ——响应体是原样 pipe 过去的，长度没变；把它当逐跳头剥掉会让所有响应
 * 退化成 chunked，HEAD 请求更是完全拿不到 content-length。
 */
const RESPONSE_HOP_BY_HOP = new Set(
  [...HOP_BY_HOP].filter((h) => h !== 'content-length' && h !== 'expect' && h !== 'host' && h !== 'x-gateway-token'),
);

/** debug 日志里要脱敏的请求头 */const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'openai-api-key',
  'anthropic-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-gateway-token',
]);

export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? mask(Array.isArray(v) ? v.join(', ') : v) : v;
  }
  return out;
}

/**
 * 按 RFC 7230，Connection 头里列出的自定义头同样是逐跳头，必须剥掉。
 * 返回本次需要额外过滤的头名集合。
 */
function hopByHopFromConnection(connectionValue) {
  const extra = new Set();
  if (!connectionValue) return extra;
  const raw = Array.isArray(connectionValue) ? connectionValue.join(',') : String(connectionValue);
  for (const token of raw.split(',')) {
    const t = token.trim().toLowerCase();
    if (t) extra.add(t);
  }
  return extra;
}

/**
 * 把客户端可能写歪的路径归一成上游真正认的 /v1/... 形式：
 *   /chat/completions        -> /v1/chat/completions
 *   /v1/v1/chat/completions  -> /v1/chat/completions
 *   /v1/models               -> /v1/models
 */
export function normalizePath(rawPath) {
  const [pathname, search = ''] = String(rawPath || '/').split('?');
  const segs = pathname.split('/').filter(Boolean);
  const out = [];
  for (const s of segs) {
    // 丢弃 . 与 ..，否则 /../zen 之类会以 /v1/../zen 的形式打到上游
    if (s === '.' || s === '..') continue;
    if (out[out.length - 1] === s) continue; // 折叠重复段，例如 v1/v1
    out.push(s);
  }
  if (out[0] !== 'v1') out.unshift('v1');
  const normalized = `/${out.join('/')}`;
  return search ? `${normalized}?${search}` : normalized;
}

/** 拼出真正的上游 URL；若 --upstream 本身已带 /v1，避免出现 /v1/v1 */
export function buildUpstreamTarget(cfg, rawPath) {
  const base = new URL(cfg.upstream);
  const basePath = base.pathname.replace(/\/+$/, '');
  let rel = normalizePath(rawPath);
  if (/\/v1$/.test(basePath) && rel.startsWith('/v1')) rel = rel.slice(3) || '/';
  const [relPath, search] = rel.split('?');
  return {
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port || (base.protocol === 'https:' ? 443 : 80),
    path: `${basePath}${relPath}${search ? `?${search}` : ''}`,
    href: `${base.origin}${basePath}${rel}`,
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const err = new Error(`请求体超过上限 ${limit} 字节`);
        err.code = 'E_TOO_LARGE';
        done(reject, err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks)));
    req.on('error', (err) => done(reject, err));
    req.on('aborted', () => done(reject, new Error('客户端提前断开')));
  });
}

function parseJsonBody(buf, headers) {
  if (!buf || buf.length === 0) return null;
  const ct = String(headers['content-type'] || '');
  if (!ct.includes('json') && buf[0] !== 0x7b && buf[0] !== 0x5b) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

function applyModelMap(body, modelMap) {
  if (!body || typeof body !== 'object' || !modelMap) return { body, changed: false };
  const keys = Object.keys(modelMap);
  if (keys.length === 0) return { body, changed: false };
  let changed = false;
  const next = { ...body };
  if (typeof next.model === 'string' && modelMap[next.model]) {
    next.model = modelMap[next.model];
    changed = true;
  }
  for (const field of ['models', 'modelIds']) {
    if (Array.isArray(next[field])) {
      const mapped = next[field].map((m) => (modelMap[m] ? modelMap[m] : m));
      if (mapped.some((m, i) => m !== next[field][i])) {
        next[field] = mapped;
        changed = true;
      }
    }
  }
  return { body: next, changed };
}

/* ------------------------------------------------------------------ *
 * 网关主体
 * ------------------------------------------------------------------ */

export function createGateway(config) {
  const cfg = config;
  currentLogLevel = LEVELS[cfg.logLevel] ?? LEVELS.info;

  const stats = {
    startedAt: new Date().toISOString(),
    total: 0,
    ok: 0,
    clientError: 0,
    upstreamError: 0,
    byPath: new Map(),
    sessions: new Map(),
  };

  function noteSession(id, model) {
    if (!id) return;
    const prev = stats.sessions.get(id) ?? { count: 0 };
    stats.sessions.set(id, { count: prev.count + 1, model: model ?? prev.model, lastSeen: new Date().toISOString() });
    if (stats.sessions.size > 500) {
      const first = stats.sessions.keys().next().value;
      stats.sessions.delete(first);
    }
  }

  const handler = (req, res) => {
    handle(req, res).catch((err) => {
      log('error', `未捕获异常: ${err?.stack || err}`);
      if (!res.headersSent) sendJson(res, 500, { error: { type: 'gateway_internal_error', message: String(err?.message || err) } });
      else res.destroy();
    });
  };


  async function handle(req, res) {
    const started = Date.now();
    const rawUrl = req.url || '/';

    // ---- 第 0 关：只在回环上，且（可选）带对本地令牌 ----
    // 注意：必须放在管理端点分发**之前**，否则 /_gateway/status 与
    // /_gateway/check 会绕过本机校验（--host 0.0.0.0 时等于对局域网开放，
    // 且 check 会拿网关内置 key 去打上游）。
    const remote = req.socket.remoteAddress;
    if (!isLoopback(remote)) {
      log('warn', `拒绝非本机来源: ${remote}`);
      return sendJson(res, 403, {
        error: { type: 'gateway_local_only', message: '本网关只接受来自本机 (127.0.0.1) 的请求' },
      });
    }
    if (!isAllowedHost(req.headers.host, cfg)) {
      log('warn', `拒绝可疑 Host: ${req.headers.host}`);
      return sendJson(res, 403, {
        error: {
          type: 'gateway_bad_host',
          message: `Host 头 "${req.headers.host}" 不被接受（防 DNS rebinding）。只允许 127.0.0.1 / localhost / [::1]`,
        },
      });
    }
    if (cfg.localToken && req.headers['x-gateway-token'] !== cfg.localToken) {
      return sendJson(res, 401, {
        error: { type: 'gateway_unauthorized', message: '缺少或错误的 x-gateway-token' },
      });
    }

    // 管理端点（不转发）
    if (rawUrl === '/_gateway/health' || rawUrl.startsWith('/_gateway/')) {
      return handleAdmin(req, res, rawUrl);
    }

    // ---- CORS：WebView / Electron / 浏览器内核的翻译软件会先发预检 ----
    // 预检请求绝不能转发到上游（上游不认，会 405，浏览器随即报 "Load failed"）
    const origin = req.headers.origin;
    const acrm = req.headers['access-control-request-method'];
    const originAllowed = isOriginAllowed(origin, cfg);
    if (origin && originAllowed) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-expose-headers', 'x-gateway-session, x-gateway-upstream-status, x-request-id');
    }
    if ((req.method || '') === 'OPTIONS' && acrm) {
      if (cfg.apiKey && !cfg.allowBrowser) {
        log('warn', `拦截浏览器预检（网关内置了 apiKey）: origin=${origin}`);
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { type: 'gateway_browser_blocked', message: '已拦截浏览器来源。确实需要请加 --allow-browser' } }));
        return;
      }
      if (origin && !originAllowed) {
        // 不白名单化就等于让任意网站把本机网关当免费的 CORS 中转
        log('warn', `拒绝未授权的跨域预检: origin=${origin}`);
        return sendJson(res, 403, {
          error: {
            type: 'gateway_origin_denied',
            message: `来源 ${origin} 不在 CORS 白名单内。确需放行请加 --allow-origin ${origin}`,
          },
        });
      }
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
        'access-control-max-age': '86400',
        'content-length': '0',
      });
      res.end();
      log('debug', `已应答 CORS 预检 (${rawUrl})`);
      return;
    }
    if (origin && !originAllowed) {
      log('warn', `拒绝未授权的跨域请求: origin=${origin}`);
      return sendJson(res, 403, {
        error: {
          type: 'gateway_origin_denied',
          message: `来源 ${origin} 不在 CORS 白名单内。确需放行请加 --allow-origin ${origin}`,
        },
      });
    }

    if (cfg.apiKey && !cfg.allowBrowser && origin) {
      return sendJson(res, 403, {
        error: {
          type: 'gateway_browser_blocked',
          message: '检测到浏览器 Origin 且网关内置了 apiKey，已拦截。确实需要请加 --allow-browser',
        },
      });
    }

    let bodyBuf = Buffer.alloc(0);
    try {
      bodyBuf = await readBody(req, cfg.maxBodyBytes);
    } catch (err) {
      if (err.code === 'E_TOO_LARGE') {
        return sendJson(res, 413, { error: { type: 'gateway_payload_too_large', message: err.message } });
      }
      log('warn', `读取请求体失败: ${err.message}`);
      return;
    }

    let body = parseJsonBody(bodyBuf, req.headers);
    const { body: mappedBody, changed } = applyModelMap(body, cfg.modelMap);
    if (changed) {
      body = mappedBody;
      bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
      log('debug', `模型别名生效: -> ${body.model}`);
    }

    const sessionId = resolveSession(cfg, req.headers, body);
    const model = typeof body?.model === 'string' ? body.model : '-';

    const target = buildUpstreamTarget(cfg, rawUrl);
    const extraHop = hopByHopFromConnection(req.headers.connection);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k) || extraHop.has(k)) continue;
      if (v === undefined) continue;
      headers[k] = v;
    }
    if (!cfg.keepUserAgent) headers['user-agent'] = cfg.userAgent;
    if (sessionId) headers['x-opencode-session'] = sessionId;
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

    const method = req.method || 'GET';
    const hasBody = !['GET', 'HEAD'].includes(method) && bodyBuf.length > 0;
    if (hasBody) headers['content-length'] = String(bodyBuf.length);
    else delete headers['content-type'];

    if (cfg.logLevel === 'debug') {
      log('debug', `-> ${method} ${target.path} model=${model} session=${sessionId || '(未注入)'}`);
      log('debug', `   headers=${JSON.stringify(redactHeaders(headers))}`);
    }

    stats.total += 1;
    // 上限保护：path 是客户端可控的，长期运行不能让 Map 无限增长
    const pathKey = rawUrl.split('?')[0];
    if (stats.byPath.has(pathKey) || stats.byPath.size < 200) {
      stats.byPath.set(pathKey, (stats.byPath.get(pathKey) ?? 0) + 1);
    } else {
      stats.byPath.set('(其它)', (stats.byPath.get('(其它)') ?? 0) + 1);
    }
    noteSession(sessionId, model);

    const transport = target.protocol === 'https:' ? https : http;
    const upReq = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method,
        headers,
      },
      (upRes) => {
        // 上游可能返回畸形状态码（如 099）。直接交给 res.writeHead 会抛
        // ERR_HTTP_INVALID_STATUS_CODE，而这里在异步回调里，handle().catch() 接不到
        // —— 结果是整个进程猝死，连累所有在途请求。必须整体兜住。
        try {
          const rawStatus = Number(upRes.statusCode);
          const status = Number.isInteger(rawStatus) && rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 502;
          if (status !== rawStatus) {
            log('warn', `上游返回非法状态码 ${upRes.statusCode}，已改写为 502`);
            upRes.destroy();
            if (!res.headersSent) {
              return sendJson(res, 502, {
                error: { type: 'gateway_bad_upstream_status', message: `上游返回非法状态码: ${upRes.statusCode}` },
              });
            }
            return res.destroy();
          }

          const outHeaders = {};
          const upExtraHop = hopByHopFromConnection(upRes.headers.connection);
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (RESPONSE_HOP_BY_HOP.has(k) || upExtraHop.has(k)) continue;
            outHeaders[k] = v;
          }
          outHeaders['x-gateway-session'] = sessionId || '(passthrough)';
          outHeaders['x-gateway-upstream-status'] = String(status);

          if (status >= 500) stats.upstreamError += 1;
          else if (status >= 400) stats.clientError += 1;
          else stats.ok += 1;

          // HEAD 响应没有 body，但 content-length 是有意义的元信息，不能丢
          res.writeHead(status, outHeaders);
          if (res.socket) res.socket.setNoDelay(true);
          if (method === 'HEAD') {
            res.end();
            upRes.destroy();
          } else {
            upRes.pipe(res);
          }
          upRes.on('error', (err) => {
            log('warn', `上游响应中断: ${err.message}`);
            res.destroy();
          });
          res.on('close', () => upRes.destroy());
          log('info', `${method} ${rawUrl} -> ${status} ${Date.now() - started}ms model=${model} session=${sessionId || '(未注入)'}`);
        } catch (err) {
          log('error', `处理上游响应时出错: ${err?.stack || err}`);
          stats.upstreamError += 1;
          if (!res.headersSent) {
            sendJson(res, 502, { error: { type: 'gateway_upstream_response_error', message: String(err?.message || err) } });
          } else {
            res.destroy();
          }
          upRes.destroy();
        }
      },
    );

    // 上游回 101 时 Node 会 detach socket 且把超时清零，响应回调永不触发，
    // 客户端会永久挂起。这里兜底销毁。
    upReq.on('upgrade', (upRes, socket) => {
      log('warn', `上游返回 101 Switching Protocols，已中止`);
      socket.destroy();
      upRes.destroy?.();
      if (!res.headersSent) {
        sendJson(res, 502, { error: { type: 'gateway_upstream_upgrade', message: '上游返回了不支持的 101 协议升级响应' } });
      } else {
        res.destroy();
      }
    });

    // 空闲超时（SSE 每有数据就会重置，不会误杀长流）
    upReq.setTimeout(cfg.timeoutMs, () => {
      upReq.destroy(new Error(`上游 ${cfg.timeoutMs}ms 无响应`));
    });

    upReq.on('error', (err) => {
      // 客户端主动断开是常态（用户切走、翻译软件取消），不该计成上游故障
      if (err.code === 'E_CLIENT_ABORT' || res.writableEnded) {
        log('debug', `上游请求提前结束: ${err.message}`);
        return;
      }
      stats.upstreamError += 1;
      log('error', `上游请求失败: ${err.message}`);
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: {
            type: 'gateway_upstream_unreachable',
            message: `无法访问上游 ${target.href}: ${err.message}`,
          },
        });
      } else {
        res.destroy();
      }
    });

    // 客户端断开时 response 流上可能出现写错误；不接管会变成 uncaughtException
    res.on('error', (err) => {
      log('debug', `响应写出中断（客户端多半已断开）: ${err.message}`);
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        const err = new Error('客户端断开');
        err.code = 'E_CLIENT_ABORT';
        upReq.destroy(err);
      }
    });

    if (hasBody) upReq.end(bodyBuf);
    else upReq.end();
  }

  async function handleAdmin(req, res, rawUrl) {
    const [pathname] = rawUrl.split('?');
    if (pathname === '/_gateway/health') {
      return sendJson(res, 200, { ok: true, version: VERSION, uptimeSec: process.uptime() });
    }
    if (pathname === '/_gateway/status') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        node: process.version,
        startedAt: stats.startedAt,
        listen: `${cfg.host}:${cfg.port}`,
        upstream: cfg.upstream,
        mode: cfg.mode,
        fixedSession: cfg.mode === 'fixed' ? cfg.session : undefined,
        userAgent: cfg.userAgent,
        apiKeyOverride: cfg.apiKey ? '已配置(覆盖客户端 Authorization)' : '未配置(透传客户端 Authorization)',
        modelMap: cfg.modelMap,
        timeoutMs: cfg.timeoutMs,
        counters: {
          total: stats.total,
          ok: stats.ok,
          clientError4xx: stats.clientError,
          upstreamError5xx: stats.upstreamError,
          byPath: Object.fromEntries(stats.byPath),
          distinctSessions: stats.sessions.size,
        },
        recentSessions: [...stats.sessions.entries()]
          .sort((a, b) => (b[1].lastSeen || '').localeCompare(a[1].lastSeen || ''))
          .slice(0, 10)
          .map(([id, v]) => ({ session: id, count: v.count, model: v.model, lastSeen: v.lastSeen })),
      });
    }
    if (pathname === '/_gateway/check') {
      // 用调用方给的 Authorization 去上游试探一次，确认会话头真的被接受了
      const target = buildUpstreamTarget(cfg, '/v1/models');
      const headers = {
        'user-agent': cfg.userAgent,
        'x-opencode-session': resolveSession(cfg, req.headers, null) || fingerprintSession(cfg, ['check']),
      };
      const auth = cfg.apiKey ? `Bearer ${cfg.apiKey}` : req.headers.authorization;
      if (auth) headers.authorization = auth;
      const transport = target.protocol === 'https:' ? https : http;
      const probe = transport.request(
        { protocol: target.protocol, hostname: target.hostname, port: target.port, path: target.path, method: 'GET', headers },
        (upRes) => {
          let data = '';
          upRes.setEncoding('utf8');
          upRes.on('data', (c) => {
            if (data.length < 4000) data += c;
          });
          upRes.on('end', () => {
            sendJson(res, 200, {
              ok: (upRes.statusCode ?? 500) < 400,
              upstreamStatus: upRes.statusCode,
              sentSessionHeader: headers['x-opencode-session'],
              sentAuthorization: mask(auth),
              upstreamBodySample: data.slice(0, 800),
            });
          });
        },
      );
      probe.setTimeout(30000, () => probe.destroy(new Error('探测超时')));
      probe.on('error', (err) => sendJson(res, 502, { ok: false, error: err.message }));
      probe.end();
      return;
    }
    return sendJson(res, 404, {
      error: { type: 'gateway_not_found', message: `未知管理端点 ${pathname}，可用: /_gateway/health /_gateway/status /_gateway/check` },
    });
  }

  return { handler, cfg, stats };
}

function isLoopback(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * 只接受本机 Host，挡 DNS rebinding：
 * 恶意网页可以把域名解析到 127.0.0.1，此时浏览器不发 Origin（同源），
 * 现有 Origin 拦截覆盖不到。校验 Host 才能挡住。
 */
export function isAllowedHost(hostHeader, cfg = {}) {
  if (cfg.host && cfg.host !== '127.0.0.1' && cfg.host !== '::1' && cfg.host !== 'localhost') {
    return true; // 用户主动监听网卡/0.0.0.0 时不做 Host 限制（此时本机校验仍是主要防线）
  }
  if (!hostHeader) return true; // HTTP/1.0 无 Host，交给本机校验兜底
  const h = String(hostHeader).trim().toLowerCase();
  const hostname = h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '0000:0000:0000:0000:0000:0000:0000:0001';
}

const LOOPBACK_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * CORS 白名单。默认放行：
 *   - 回环来源（WebView / 本地 dev server）
 *   - 字面量 "null"（file:// 打开的 WebView，Origin 头就是 null）
 * 其余来源一律不放行，否则任意网站都能把本机网关当免 CORS 的中转。
 * 需要放行别的来源：--allow-origin https://my.app（可逗号分隔，或用 * 全放行）
 */
export function isOriginAllowed(origin, cfg = {}) {
  if (!origin) return false;
  const allow = cfg.allowOrigin;
  if (allow === '*') return true;
  if (Array.isArray(allow) && allow.length > 0) {
    return allow.includes(origin) || allow.includes('*');
  }
  if (origin === 'null') return true;
  try {
    const u = new URL(origin);
    return LOOPBACK_ORIGIN_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buf.length),
    'cache-control': 'no-store',
  });
  res.end(buf);
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/**
 * 决定监听哪些回环地址。
 * macOS 上 `localhost` 同时解析到 ::1 和 127.0.0.1，而不少 HTTP 客户端
 * （尤其 WebKit / URLSession）会优先走 IPv6。只监听 127.0.0.1 的话，
 * 客户端填 http://localhost:8787 就会直接连接失败 —— 表现为 "Load failed"。
 */
export function listenHosts(host) {
  const h = String(host || '').trim();
  if (h === 'localhost') return ['127.0.0.1', '::1'];
  if (h === '127.0.0.1') return ['127.0.0.1', '::1'];
  if (h === '::1') return ['::1', '127.0.0.1'];
  return [h]; // 0.0.0.0 / :: / 具体网卡地址，原样绑定
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 启动网关。返回的对象与 http.Server 兼容（有 address() / close()），
 * 但 close() 会一并关掉所有监听（IPv4 + IPv6）。
 */
export async function startServer(cfg) {
  const gw = createGateway(cfg);
  const hosts = listenHosts(cfg.host);
  const servers = [];

  for (let i = 0; i < hosts.length; i += 1) {
    const host = hosts[i];
    const s = http.createServer(gw.handler);
    // 防半开连接长期占坑（Node 默认 requestTimeout 300s，这里可配置）
    s.requestTimeout = cfg.requestTimeoutMs;
    s.headersTimeout = Math.min(60000, cfg.requestTimeoutMs);
    // 连接级日志：用来判断「客户端到底有没有连上来」——排 "Load failed" 时最有用
    s.on('connection', (socket) => {
      log('debug', `新连接来自 ${socket.remoteAddress}:${socket.remotePort} -> ${host}`);
      socket.on('error', (err) => log('debug', `连接出错 ${socket.remoteAddress}: ${err.message}`));
    });
    s.on('clientError', (err, socket) => {
      const code = err.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
      log('warn', `客户端协议错误(${code}): ${err.message}`);
      if (socket.writable) socket.end(`HTTP/1.1 ${code} ${code === 431 ? 'Request Header Fields Too Large' : 'Bad Request'}\r\nConnection: close\r\n\r\n`);
    });
    // 端口 0 时先用第一个监听定下真实端口，其余监听复用同一端口
    const wantPort = i === 0 ? cfg.port : servers[0].address().port;
    try {
      await listenOn(s, wantPort, host);
      servers.push(s);
    } catch (err) {
      if (i === 0) throw err; // 主监听失败必须报出来（例如端口被占）
      log('warn', `附加监听 ${host}:${wantPort} 失败（${err.code || err.message}），已跳过；不影响 IPv4 使用`);
      s.close();
    }
  }

  const primary = servers[0];
  const closeAll = (cb) => {
    let remaining = servers.length;
    if (remaining === 0) {
      cb?.();
      return undefined;
    }
    for (const s of servers) {
      // 注意：primary.close 已被本函数覆盖，这里必须用原型上的原始 close，否则无限递归
      http.Server.prototype.close.call(s, () => {
        remaining -= 1;
        if (remaining === 0) cb?.();
      });
      // keep-alive 的空闲连接不会自己断开，会让 close 一直等下去
      s.closeIdleConnections?.();
    }
    return undefined;
  };
  primary.close = closeAll;
  return primary;
}

const USAGE = `
opencode-adapter ${VERSION} — 给不支持自定义请求头的客户端补 x-opencode-session

用法:
  node gateway.mjs [选项]

选项:
  --port <n>              监听端口 (默认 8787)
  --host <ip>             监听地址 (默认 127.0.0.1，强烈建议不要改)
  --upstream <url>        上游地址 (默认 https://opencode.ai/inference/go)
  --mode <mode>           会话 ID 策略: auto|model|content|fixed|passthrough (默认 auto)
  --session <id>          mode=fixed 时使用的固定会话 ID
  --session-prefix <p>    会话 ID 前缀 (默认 ocg)
  --salt <s>              指纹盐值 (默认按 机器+用户 自动派生)
  --log <level>           silent|error|warn|info|debug (默认 info)
  --timeout-ms <n>        上游空闲超时毫秒 (默认 120000)
  --max-body-bytes <n>    请求体上限 (默认 33554432)
  --user-agent <ua>       发给上游的 User-Agent
  --keep-user-agent       保留客户端原始 User-Agent
  --api-key <key>         用固定 key 覆盖客户端 Authorization (默认透传)
  --model-map <a=b,c=d>   模型名映射，例如 --model-map "gpt-4o=deepseek-v4-flash"
  --local-token <t>       要求请求携带 x-gateway-token: <t>
  --allow-browser         允许带 Origin 的浏览器请求通过
  --config <file>         JSON 配置文件
  --print-config          打印最终配置后退出
  --help                  显示帮助

自检:
  curl http://127.0.0.1:8787/_gateway/status
  curl -H "Authorization: Bearer <你的key>" http://127.0.0.1:8787/_gateway/check
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  let cfg;
  try {
    cfg = resolveConfig(argv);
  } catch (err) {
    process.stderr.write(`配置错误: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  currentLogLevel = LEVELS[cfg.logLevel] ?? LEVELS.info;

  if (argv.includes('--print-config')) {
    process.stdout.write(`${JSON.stringify({ ...cfg, apiKey: cfg.apiKey ? mask(cfg.apiKey) : '', localToken: cfg.localToken ? mask(cfg.localToken) : '' }, null, 2)}\n`);
    return;
  }

  const server = await startServer(cfg).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`端口 ${cfg.port} 已被占用。换一个端口，或先停掉旧进程。\n`);
    } else {
      process.stderr.write(`启动失败: ${err.message}\n`);
    }
    process.exit(1);
  });

  log('info', `opencode-adapter v${VERSION} 已启动: http://${cfg.host}:${cfg.port}`);
  log('info', `上游: ${cfg.upstream}  会话模式: ${cfg.mode}`);
  log('info', `把翻译软件的 API 地址填成: http://${cfg.host}:${cfg.port}/v1`);
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
    log('warn', `注意: 当前监听 ${cfg.host}，局域网内其他机器也能访问，且会带着你的 key 打上游。`);
  }

  const shutdown = (sig) => {
    log('info', `收到 ${sig}，正在关闭...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isDirectRun =
  process.argv[1] &&
  (() => {
    try {
      // 必须比 realpath：npm bin / npx / 全局安装走的都是软链接，
      // 直接比字符串会让 main() 永不执行（静默退出、exit 0）
      return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
  })();
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack || err}\n`);
    process.exit(1);
  });
}
