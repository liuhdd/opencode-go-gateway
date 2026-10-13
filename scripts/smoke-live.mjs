#!/usr/bin/env node
/**
 * 对着**真实** opencode.ai 的端到端冒烟验证。
 *
 * 它会同时跑两组对照，用来证明「400 就是缺 x-opencode-session 导致的」：
 *   A. 网关默认模式  -> 上游不应再回 MissingSessionID(400)
 *   B. 网关 passthrough -> 必须复现最初的 400，证明对照有效
 *
 * 用法:
 *   node scripts/smoke-live.mjs                          # 用假 key，只看 400 是否消失
 *   OPENCODE_API_KEY=sk-xxx node scripts/smoke-live.mjs  # 用真 key，验证能真正拿到回复
 */

import { resolveConfig, startServer, VERSION } from '../gateway.mjs';

const UPSTREAM = 'https://opencode.ai/inference/go';
const KEY = process.env.OPENCODE_API_KEY || process.env.OCG_API_KEY || 'sk-invalid-test-key';
const MODEL = process.env.OCG_SMOKE_MODEL || 'deepseek-v4-flash';
const usingRealKey = !KEY.startsWith('sk-invalid');

async function startGateway(extraArgs) {
  const cfg = resolveConfig(['--port', '0', '--upstream', UPSTREAM, '--log', 'silent', ...extraArgs], {});
  const server = await startServer(cfg);
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function call(base, { stream = false } = {}) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: '只回复两个字：你好' }],
      max_tokens: 16,
      stream,
    }),
  });
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - started, session: res.headers.get('x-gateway-session') };
}

function firstLine(t, n = 220) {
  return t.replace(/\s+/g, ' ').slice(0, n);
}

function isMissingSession(r) {
  return r.status === 400 && /x-opencode-session/.test(r.text);
}

const results = [];
let failed = false;

console.log(`opencode-go-gateway v${VERSION} 端到端冒烟`);
console.log(`上游: ${UPSTREAM}`);
console.log(`模型: ${MODEL}   key: ${usingRealKey ? '真实 key' : '假 key(sk-invalid-test-key)'}`);
console.log('');

// ---- A. 默认模式：应该不再报 MissingSessionID ----
{
  const gw = await startGateway([]);
  try {
    const r = await call(gw.base);
    const ok = !isMissingSession(r);
    results.push(['A 默认模式(自动注入会话头)', ok, `${r.status} ${r.ms}ms session=${r.session ?? '-'}`]);
    console.log(`[A] 默认模式       HTTP ${r.status}  ${r.ms}ms`);
    console.log(`     注入的会话: ${r.session}`);
    console.log(`     响应: ${firstLine(r.text)}`);
    if (isMissingSession(r)) {
      failed = true;
      console.log('     ❌ 仍然报 MissingSessionID —— 注入没生效');
    } else if (r.status === 401) {
      console.log('     ✅ 400 已消失（401 是假 key 导致的，换成真 key 即可正常翻译）');
    } else if (r.status === 200) {
      console.log('     ✅ 调用成功');
      if (usingRealKey) {
        try {
          const j = JSON.parse(r.text);
          console.log(`     模型回复: ${JSON.stringify(j.choices?.[0]?.message?.content ?? j).slice(0, 200)}`);
        } catch {
          /* 忽略 */
        }
      }
    } else {
      console.log(`     ⚠️  非预期状态码，请人工确认`);
    }
  } finally {
    await gw.close();
  }
}

// ---- B. 对照组：disabled 注入 => 必须复现原始报错 ----
{
  const gw = await startGateway(['--mode', 'passthrough']);
  try {
    const r = await call(gw.base);
    const reproduced = isMissingSession(r);
    results.push(['B 对照(passthrough 不注入)', reproduced, `${r.status} ${r.ms}ms`]);
    console.log('');
    console.log(`[B] passthrough    HTTP ${r.status}  ${r.ms}ms`);
    console.log(`     响应: ${firstLine(r.text)}`);
    if (reproduced) {
      console.log('     ✅ 复现了你最初的 400，说明 A/B 对照成立');
    } else {
      failed = true;
      console.log('     ❌ 没有复现 400，对照无效（可能上游策略已变）');
    }
  } finally {
    await gw.close();
  }
}

// ---- C. 流式：确认 SSE 不被缓冲 ----
{
  const gw = await startGateway([]);
  try {
    const started = Date.now();
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '数到三' }], max_tokens: 16, stream: true }),
    });
    let firstChunkAt = null;
    let body = '';
    if (res.body && res.status === 200) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstChunkAt === null) firstChunkAt = Date.now();
        body += dec.decode(value, { stream: true });
      }
    } else {
      body = await res.text();
    }
    const ok = res.status !== 400;
    results.push(['C 流式透传', ok, `HTTP ${res.status}`]);
    console.log('');
    console.log(`[C] 流式          HTTP ${res.status}  content-type=${res.headers.get('content-type')}`);
    console.log(`     首块耗时: ${firstChunkAt ? `${firstChunkAt - started}ms` : '无数据'}`);
    console.log(`     片段: ${firstLine(body)}`);
  } finally {
    await gw.close();
  }
}

console.log('\n================== 结论 ==================');
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
}
console.log('==========================================');
if (!usingRealKey) {
  console.log('\n提示: 想验证「真的能翻译」，请用真 key 再跑一次：');
  console.log('  OPENCODE_API_KEY=sk-你的key node scripts/smoke-live.mjs');
}
process.exit(failed ? 1 : 0);
