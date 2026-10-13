/**
 * opencode-go-gateway 自动化测试
 *   node --test test/
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig, startServer, normalizePath, buildUpstreamTarget, fingerprintSession, listenHosts, isOriginAllowed } from '../gateway.mjs';
import { createMockServer } from './mock-upstream.mjs';

let mock;
let mockUrl;

before(async () => {
  mock = createMockServer();
  const port = await mock.listen();
  mockUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await mock.close();
});

/** 起一个临时网关（随机端口），测试结束后自动关闭 */
async function withGateway(args, fn) {
  const cfg = resolveConfig(['--port', '0', '--upstream', mockUrl, '--log', 'silent', ...args], {});
  const server = await startServer(cfg);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({ base, cfg, port });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function apiCall(base, path = '/v1/chat/completions', { headers = {}, body = {} } = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-client-key', ...headers },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
}

/* ---------------------------------------------------------------- */

describe('会话 ID 注入', () => {
  test('客户端没带 x-opencode-session 时自动补上', async () => {
    mock.requests.length = 0;
    await withGateway([], async ({ base }) => {
      const res = await apiCall(base);
      assert.equal(res.status, 200);
      const data = await res.json();
      const sent = data.receivedHeaders['x-opencode-session'];
      assert.ok(sent, '上游必须收到 x-opencode-session');
      assert.match(sent, /^ocg-[0-9a-f]{32}$/);
      assert.equal(res.headers.get('x-gateway-session'), sent);
    });
  });

  test('客户端自己带了会话头 => 原样透传', async () => {
    await withGateway([], async ({ base }) => {
      const res = await apiCall(base, '/v1/chat/completions', { headers: { 'x-opencode-session': 'my-own-session-42' } });
      const data = await res.json();
      assert.equal(data.receivedHeaders['x-opencode-session'], 'my-own-session-42');
    });
  });

  test('识别其它常见会话头（x-session-id / x-conversation-id）', async () => {
    for (const [header, value] of [
      ['x-session-id', 'sess-abc'],
      ['x-conversation-id', 'conv-xyz'],
    ]) {
      await withGateway([], async ({ base }) => {
        const res = await apiCall(base, '/v1/chat/completions', { headers: { [header]: value } });
        const data = await res.json();
        assert.equal(data.receivedHeaders['x-opencode-session'], value);
      });
    }
  });

  test('auto 模式下同一模型多次请求 => 会话稳定（prompt cache 友好）', async () => {
    await withGateway([], async ({ base }) => {
      const a = await (await apiCall(base)).json();
      const b = await (await apiCall(base)).json();
      assert.equal(a.receivedHeaders['x-opencode-session'], b.receivedHeaders['x-opencode-session']);
    });
  });

  test('auto 模式下不同模型 => 不同会话', async () => {
    await withGateway([], async ({ base }) => {
      const a = await (await apiCall(base, '/v1/chat/completions', { body: { model: 'kimi-k3' } })).json();
      const b = await (await apiCall(base, '/v1/chat/completions', { body: { model: 'glm-5.2' } })).json();
      assert.notEqual(a.receivedHeaders['x-opencode-session'], b.receivedHeaders['x-opencode-session']);
    });
  });

  test('auto 模式下请求体里的 user 字段会成为会话提示（稳定可复现）', async () => {
    await withGateway([], async ({ base }) => {
      const a = await (await apiCall(base, '/v1/chat/completions', { body: { user: 'doc-2026-10' } })).json();
      const b = await (await apiCall(base, '/v1/chat/completions', { body: { user: 'doc-2026-10' } })).json();
      assert.equal(a.receivedHeaders['x-opencode-session'], b.receivedHeaders['x-opencode-session']);
    });
  });

  test('mode=model 忽略客户端会话头，只按模型派生', async () => {
    await withGateway(['--mode', 'model'], async ({ base }) => {
      const data = await (await apiCall(base, '/v1/chat/completions', { headers: { 'x-opencode-session': 'nope' } })).json();
      assert.notEqual(data.receivedHeaders['x-opencode-session'], 'nope');
      assert.match(data.receivedHeaders['x-opencode-session'], /^ocg-/);
    });
  });

  test('mode=fixed 使用固定会话 ID（跨模型一致）', async () => {
    await withGateway(['--mode', 'fixed', '--session', 'my-fixed-session'], async ({ base }) => {
      const a = await (await apiCall(base, '/v1/chat/completions', { body: { model: 'kimi-k3' } })).json();
      const b = await (await apiCall(base, '/v1/chat/completions', { body: { model: 'glm-5.2' } })).json();
      assert.equal(a.receivedHeaders['x-opencode-session'], 'my-fixed-session');
      assert.equal(b.receivedHeaders['x-opencode-session'], 'my-fixed-session');
    });
  });

  test('mode=passthrough 完全不注入（用于复现原始 400）', async () => {
    await withGateway(['--mode', 'passthrough'], async ({ base }) => {
      const data = await (await apiCall(base)).json();
      assert.equal(data.receivedHeaders['x-opencode-session'], undefined);
      assert.equal(data.receivedHeaders['x-session-id'], undefined);
    });
  });

  test('会话 ID 默认按机器派生（不同 salt => 不同结果）', () => {
    const base = { salt: 'salt-a', sessionPrefix: 'ocg' };
    const other = { salt: 'salt-b', sessionPrefix: 'ocg' };
    assert.notEqual(fingerprintSession(base, ['auto', 'm']), fingerprintSession(other, ['auto', 'm']));
    assert.equal(fingerprintSession(base, ['auto', 'm']), fingerprintSession(base, ['auto', 'm']));
  });
});

describe('请求转发', () => {
  test('Authorization 与业务头原样透传', async () => {
    await withGateway([], async ({ base }) => {
      const data = await (
        await apiCall(base, '/v1/chat/completions', { headers: { 'x-custom-header': 'keep-me', 'accept-language': 'zh-CN' } })
      ).json();
      assert.equal(data.receivedHeaders.authorization, 'Bearer sk-client-key');
      assert.equal(data.receivedHeaders['x-custom-header'], 'keep-me');
      assert.equal(data.receivedHeaders['accept-language'], 'zh-CN');
      assert.equal(data.receivedHeaders['content-type'], 'application/json');
    });
  });

  test('逐跳头不会发给上游', async () => {
    mock.requests.length = 0;
    await withGateway([], async ({ base }) => {
      // undici 不允许手写 connection 头，这里用裸 http 发
      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          `${base}/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              connection: 'keep-alive, x-secret-hop',
              'x-secret-hop': 'should-not-reach-upstream',
              'proxy-authorization': 'Basic zzz',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'deepseek-v4-flash' }));
      });
      assert.equal(status, 200);
      const sent = mock.lastRequest().headers;
      assert.equal(sent['proxy-authorization'], undefined);
      assert.equal(sent['x-secret-hop'], undefined);
      // Connection 由网关自己的 HTTP 客户端重写（keep-alive），
      // 关键是客户端那份值 "keep-alive, x-secret-hop" 没有被转发
      assert.ok(!String(sent.connection ?? '').includes('x-secret-hop'), `connection 头被透传了: ${sent.connection}`);
      assert.ok(sent['x-opencode-session'], '会话头仍然必须注入');
    });
  });

  test('默认替换掉通用 User-Agent，避免被当成裸 SDK', async () => {    await withGateway([], async ({ base }) => {
      const data = await (await apiCall(base, '/v1/chat/completions', { headers: { 'user-agent': 'okhttp/4.9.0' } })).json();
      assert.match(data.receivedHeaders['user-agent'], /opencode-go-gateway/);
    });
  });

  test('--keep-user-agent 保留客户端原始 UA', async () => {
    await withGateway(['--keep-user-agent'], async ({ base }) => {
      const data = await (await apiCall(base, '/v1/chat/completions', { headers: { 'user-agent': 'MyTranslator/2.1' } })).json();
      assert.equal(data.receivedHeaders['user-agent'], 'MyTranslator/2.1');
    });
  });

  test('自定义 --user-agent 生效', async () => {
    await withGateway(['--user-agent', 'my-coding-agent/1.0'], async ({ base }) => {
      const data = await (await apiCall(base)).json();
      assert.equal(data.receivedHeaders['user-agent'], 'my-coding-agent/1.0');
    });
  });

  test('--api-key 覆盖客户端 Authorization', async () => {
    await withGateway(['--api-key', 'sk-from-gateway'], async ({ base }) => {
      const data = await (await apiCall(base)).json();
      assert.equal(data.receivedHeaders.authorization, 'Bearer sk-from-gateway');
    });
  });

  test('请求体原样送达（含中文与嵌套结构）', async () => {
    const body = {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: '你是翻译助手' },
        { role: 'user', content: '把这段话翻译成英文：你好，世界。' },
      ],
      temperature: 0.3,
      nested: { a: [1, 2, { b: true }] },
    };
    await withGateway([], async ({ base }) => {
      const data = await (await apiCall(base, '/v1/chat/completions', { body })).json();
      assert.deepEqual(data.receivedBody.messages, body.messages);
      assert.equal(data.receivedBody.nested.a[2].b, true);
    });
  });

  test('2MB 大请求体字节级完整', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: big }] };
    const expect = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await withGateway([], async ({ base }) => {
      const res = await apiCall(base, '/v1/chat/completions', { body });
      const data = await res.json();
      const got = crypto.createHash('sha256').update(JSON.stringify(data.receivedBody)).digest('hex');
      assert.equal(got, expect);
      assert.equal(data.receivedHeaders['content-length'], String(Buffer.byteLength(JSON.stringify(body))));
    });
  });

  test('超出 --max-body-bytes 返回 413', async () => {
    await withGateway(['--max-body-bytes', '1024'], async ({ base }) => {
      const res = await apiCall(base, '/v1/chat/completions', { body: { model: 'x', messages: [{ role: 'user', content: 'y'.repeat(5000) }] } });
      assert.equal(res.status, 413);
      const data = await res.json();
      assert.equal(data.error.type, 'gateway_payload_too_large');
    });
  });

  test('GET /v1/models 正常转发（无请求体）', async () => {
    await withGateway([], async ({ base }) => {
      const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-client-key' } });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.receivedHeaders['x-opencode-session'] !== undefined, true);
      assert.equal(data.receivedHeaders['content-length'], undefined);
    });
  });

  test('query string 保留', async () => {
    await withGateway([], async ({ base }) => {
      const res = await fetch(`${base}/v1/models?foo=bar&baz=1`, { headers: { authorization: 'Bearer k' } });
      const data = await res.json();
      assert.equal(data.receivedPath, '/v1/models?foo=bar&baz=1');
    });
  });

  test('并发 40 x 3 批全部成功且每个请求都带会话头，计数准确', async () => {
    mock.requests.length = 0;
    await withGateway([], async ({ base }) => {
      const BATCH = 40;
      const ROUNDS = 3;
      for (let round = 0; round < ROUNDS; round += 1) {
        const results = await Promise.all(
          Array.from({ length: BATCH }, async (_, i) => {
            const body = { model: i % 2 ? 'deepseek-v4-flash' : 'kimi-k3', messages: [{ role: 'user', content: 'x'.repeat(1000) }] };
            const res = await apiCall(base, '/v1/chat/completions', { body });
            const data = await res.json();
            return data.receivedHeaders['x-opencode-session'];
          }),
        );
        assert.equal(results.filter((s) => typeof s === 'string' && s.startsWith('ocg-')).length, BATCH);
        // 同一模型的所有请求必须落到同一个会话（否则上游 prompt cache 全废）
        assert.equal(new Set(results).size, 2);
      }
      const status = await (await fetch(`${base}/_gateway/status`)).json();
      assert.equal(status.counters.total, BATCH * ROUNDS);
      assert.equal(status.counters.ok, BATCH * ROUNDS);
      assert.equal(status.counters.upstreamError5xx, 0);
      assert.equal(status.counters.distinctSessions, 2);
      assert.equal(mock.requests.filter((r) => !r.headers['x-opencode-session']).length, 0);
    });
  });
});

describe('路径归一', () => {
  test('normalizePath 各种写法', () => {
    assert.equal(normalizePath('/v1/chat/completions'), '/v1/chat/completions');
    assert.equal(normalizePath('/chat/completions'), '/v1/chat/completions');
    assert.equal(normalizePath('/v1/v1/chat/completions'), '/v1/chat/completions');
    assert.equal(normalizePath('/v1/messages'), '/v1/messages');
    assert.equal(normalizePath('/'), '/v1');
    assert.equal(normalizePath('/v1/models?a=1'), '/v1/models?a=1');
  });

  test('upstream 已带 /v1 时不会拼成 /v1/v1', async () => {
    const cfg = { upstream: `${mockUrl}/inference/go/v1` };
    const t = buildUpstreamTarget(cfg, '/v1/chat/completions');
    assert.equal(t.path, '/inference/go/v1/chat/completions');
    const t2 = buildUpstreamTarget(cfg, '/chat/completions');
    assert.equal(t2.path, '/inference/go/v1/chat/completions');
  });

  test('客户端漏写 /v1 时网关自动补上', async () => {
    await withGateway([], async ({ base }) => {
      const res = await apiCall(base, '/chat/completions');
      const data = await res.json();
      assert.equal(data.receivedPath, '/v1/chat/completions');
    });
  });

  test('客户端写了 /v1/v1 时去重', async () => {
    await withGateway([], async ({ base }) => {
      const res = await apiCall(base, '/v1/v1/chat/completions');
      const data = await res.json();
      assert.equal(data.receivedPath, '/v1/chat/completions');
    });
  });
});

describe('模型映射', () => {
  test('--model-map 改写 model 且修正 content-length', async () => {
    await withGateway(['--model-map', 'gpt-4o=deepseek-v4-flash,nope=kimi-k3'], async ({ base }) => {
      const res = await apiCall(base, '/v1/chat/completions', { body: { model: 'gpt-4o' } });
      const data = await res.json();
      assert.equal(data.receivedBody.model, 'deepseek-v4-flash');
      assert.equal(data.receivedHeaders['content-length'], String(Buffer.byteLength(JSON.stringify(data.receivedBody))));
    });
  });

  test('未命中的模型名不动', async () => {
    await withGateway(['--model-map', 'gpt-4o=deepseek-v4-flash'], async ({ base }) => {
      const data = await (await apiCall(base, '/v1/chat/completions', { body: { model: 'kimi-k3' } })).json();
      assert.equal(data.receivedBody.model, 'kimi-k3');
    });
  });
});

describe('流式（SSE）转发', () => {
  test('SSE 逐块透传，不缓冲', async () => {
    await withGateway([], async ({ base }) => {
      const started = Date.now();
      const res = await apiCall(base, '/v1/chat/completions', { body: { __mock: 'sse', stream: true } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      assert.ok(res.headers.get('x-gateway-session'));

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let firstChunkAt = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstChunkAt === null) firstChunkAt = Date.now();
        text += decoder.decode(value, { stream: true });
      }
      const total = Date.now() - started;
      assert.ok(text.includes('[DONE]'), `SSE 内容不完整: ${text}`);
      assert.ok(text.includes('你') && text.includes('好'));
      assert.ok(
        firstChunkAt - started < total - 150,
        `首个数据块应在上游结束前到达 (first=${firstChunkAt - started}ms, total=${total}ms)`,
      );
    });
  });

  test('mode=passthrough 下 SSE 同样逐块透传', async () => {
    await withGateway(['--mode', 'passthrough'], async ({ base }) => {
      const res = await apiCall(base, '/v1/chat/completions', { body: { __mock: 'sse', stream: true } });
      const text = await res.text();
      assert.ok(text.includes('[DONE]'));
      assert.equal(res.headers.get('x-gateway-session'), '(passthrough)');
    });
  });

  test('gzip 响应原样透传并可解压', async () => {
    await withGateway([], async ({ base }) => {
      const url = `${base}/v1/chat/completions`;
      const raw = await new Promise((resolve, reject) => {
        const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
          const bufs = [];
          res.on('data', (c) => bufs.push(c));
          res.on('end', () => resolve({ headers: res.headers, buf: Buffer.concat(bufs) }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ __mock: 'gzip' }));
      });
      assert.equal(raw.headers['content-encoding'], 'gzip');
      const parsed = JSON.parse(zlib.gunzipSync(raw.buf).toString('utf8'));
      assert.equal(parsed.compressed, true);
    });
  });

  test('客户端中途断开不会拖垮网关，也不计成上游故障', async () => {
    await withGateway([], async ({ base }) => {
      // 连续 5 次「收到第一块就断开」
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => {
          const req = http.request(
            `${base}/v1/chat/completions`,
            { method: 'POST', headers: { 'content-type': 'application/json' } },
            (res) => {
              res.on('data', () => {
                req.destroy();
                resolve();
              });
              res.on('end', resolve);
            },
          );
          req.on('error', () => resolve());
          req.end(JSON.stringify({ __mock: 'sse', stream: true }));
        });
        await new Promise((r) => setTimeout(r, 60));
      }

      // 网关必须还活着，且能正常服务下一个请求
      const res = await apiCall(base);
      assert.equal(res.status, 200);
      const status = await (await fetch(`${base}/_gateway/status`)).json();
      assert.equal(status.counters.upstreamError5xx, 0, '客户端断开不该被计成上游故障');
    });
  });
});

describe('连接可达性（排 "Load failed" 用）', () => {
  test('listenHosts 对回环地址同时给出 IPv4 与 IPv6', () => {
    assert.deepEqual(listenHosts('127.0.0.1'), ['127.0.0.1', '::1']);
    assert.deepEqual(listenHosts('localhost'), ['127.0.0.1', '::1']);
    assert.deepEqual(listenHosts('::1'), ['::1', '127.0.0.1']);
    assert.deepEqual(listenHosts('0.0.0.0'), ['0.0.0.0']);
  });

  test('IPv4 与 IPv6 回环都能连上（客户端填 localhost 也不会失败）', async () => {
    await withGateway([], async ({ base, port }) => {
      const v4 = await fetch(`${base}/_gateway/health`);
      assert.equal(v4.status, 200, 'IPv4 127.0.0.1 必须可用');

      let v6ok = true;
      let v6detail = '';
      try {
        const v6 = await fetch(`http://[::1]:${port}/_gateway/health`);
        assert.equal(v6.status, 200);
      } catch (err) {
        v6ok = false;
        v6detail = err.cause?.code ?? err.message;
      }
      // 某些 CI/容器没开 IPv6，此时只要求「跳过而不是崩溃」
      if (!v6ok) console.log(`   [提示] 本机无 IPv6 回环，已跳过: ${v6detail}`);
    });
  });
});

describe('CORS / 浏览器类客户端', () => {
  test('OPTIONS 预检在网关本地应答，不转发到上游', async () => {
    mock.requests.length = 0;
    await withGateway([], async ({ base }) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,authorization',
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
      assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/);
      assert.ok(res.headers.get('access-control-allow-methods')?.includes('POST'));
      assert.equal(mock.requests.length, 0, '预检不该打到上游');
    });
  });

  test('带 Origin 的普通请求会返回 CORS 头，且暴露调试头', async () => {
    await withGateway([], async ({ base }) => {
      const res = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'http://localhost:3000' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
      assert.match(res.headers.get('access-control-expose-headers') ?? '', /x-gateway-session/);
    });
  });

  test('没有 Origin 时不会多余地加 CORS 头', async () => {
    await withGateway([], async ({ base }) => {
      const res = await apiCall(base);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    });
  });

  test('配置了 apiKey 时浏览器预检同样被拦截', async () => {
    await withGateway(['--api-key', 'sk-secret'], async ({ base }) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      assert.equal(res.status, 403);
    });
  });
});

describe('错误与自检', () => {
  test('上游 4xx 原样透传（状态码 + 响应体）', async () => {
    await withGateway([], async ({ base }) => {
      const payload = { type: 'error', error: { type: 'MissingSessionID', message: 'Request is missing x-opencode-session' } };
      const res = await apiCall(base, '/v1/chat/completions', { body: { __mock: 'status', status: 400, payload } });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), payload);
      assert.equal(res.headers.get('x-gateway-upstream-status'), '400');
    });
  });

  test('上游不可达时返回结构化 502', async () => {
    const cfg = resolveConfig(['--port', '0', '--upstream', 'http://127.0.0.1:1', '--log', 'silent'], {});
    const server = await startServer(cfg);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x' }),
      });
      assert.equal(res.status, 502);
      const data = await res.json();
      assert.equal(data.error.type, 'gateway_upstream_unreachable');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('/_gateway/health 与 /_gateway/status 可用且不转发', async () => {
    mock.requests.length = 0;
    await withGateway([], async ({ base }) => {
      const health = await (await fetch(`${base}/_gateway/health`)).json();
      assert.equal(health.ok, true);
      const before = mock.requests.length;
      const status = await (await fetch(`${base}/_gateway/status`)).json();
      assert.equal(status.mode, 'auto');
      assert.equal(status.upstream, mockUrl);
      assert.equal(mock.requests.length, before, '管理端点不应转发到上游');
      assert.equal(status.counters.total, 0, '管理端点不计入业务计数');
      assert.equal(status.apiKeyOverride.startsWith('未配置'), true);
      assert.ok(status.listen.startsWith('127.0.0.1:'));
      await apiCall(base);
      const after = await (await fetch(`${base}/_gateway/status`)).json();
      assert.equal(after.counters.total, 1);
      assert.equal(after.counters.ok, 1);
      assert.equal(after.counters.distinctSessions, 1);
      assert.match(after.recentSessions[0].session, /^ocg-/);
    });
  });

  test('/_gateway/check 会带上会话头探测上游', async () => {
    mock.requests.length = 0;
    await withGateway([], async ({ base }) => {
      const data = await (await fetch(`${base}/_gateway/check`, { headers: { authorization: 'Bearer sk-probe' } })).json();
      assert.equal(data.ok, true);
      assert.equal(data.upstreamStatus, 200);
      assert.ok(data.sentSessionHeader);
      assert.equal(mock.lastRequest().path, '/v1/models');
      assert.equal(mock.lastRequest().headers.authorization, 'Bearer sk-probe');
      assert.equal(mock.lastRequest().headers['x-opencode-session'], data.sentSessionHeader);
    });
  });

  test('--local-token 生效', async () => {
    await withGateway(['--local-token', 's3cret'], async ({ base }) => {
      const denied = await apiCall(base);
      assert.equal(denied.status, 401);
      const ok = await apiCall(base, '/v1/chat/completions', { headers: { 'x-gateway-token': 's3cret' } });
      assert.equal(ok.status, 200);
    });
  });

  test('配置了 --api-key 时拦截带 Origin 的浏览器请求', async () => {
    await withGateway(['--api-key', 'sk-secret'], async ({ base }) => {
      const blocked = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'https://evil.example' } });
      assert.equal(blocked.status, 403);
      const allowed = await withGateway(['--api-key', 'sk-secret', '--allow-browser'], async ({ base: b2 }) => apiCall(b2));
      assert.equal(allowed.status, 200);
    });
  });
});

describe('配置解析', () => {
  test('默认值合理', () => {
    const cfg = resolveConfig([], {});
    assert.equal(cfg.port, 8787);
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.upstream, 'https://opencode.ai/inference/go');
    assert.equal(cfg.mode, 'auto');
    assert.ok(cfg.salt);
  });

  test('环境变量生效，且被命令行覆盖', () => {
    const cfg = resolveConfig(['--port', '9001'], { OCG_PORT: '9000', OCG_MODE: 'model', OCG_LOG: 'debug' });
    assert.equal(cfg.port, 9001);
    assert.equal(cfg.mode, 'model');
    assert.equal(cfg.logLevel, 'debug');
  });

  test('--mode fixed 缺少 --session 会报错', () => {
    assert.throws(() => resolveConfig(['--mode', 'fixed'], {}), /必须同时提供/);
  });

  test('非法 mode / 非法 upstream 会报错', () => {
    assert.throws(() => resolveConfig(['--mode', 'bogus'], {}), /--mode/);
    assert.throws(() => resolveConfig(['--upstream', 'ftp://x'], {}), /http\/https/);
    assert.throws(() => resolveConfig(['--port', 'abc'], {}), /需要是数字/);
  });

  test('--model-map 解析', () => {
    const cfg = resolveConfig(['--model-map', 'a=b, c = d '], {});
    assert.deepEqual(cfg.modelMap, { a: 'b', c: 'd' });
    assert.throws(() => resolveConfig(['--model-map', 'broken'], {}), /别名=真实模型id/);
  });

  test('--log 与 --log-level 都能设置日志级别（别名回归）', () => {
    assert.equal(resolveConfig(['--log', 'silent'], {}).logLevel, 'silent');
    assert.equal(resolveConfig(['--log', 'debug'], {}).logLevel, 'debug');
    assert.equal(resolveConfig(['--log-level', 'warn'], {}).logLevel, 'warn');
    assert.equal(resolveConfig(['--log=silent'], {}).logLevel, 'silent');
    assert.equal(resolveConfig([], { OCG_LOG: 'error' }).logLevel, 'error');
    assert.throws(() => resolveConfig(['--log', 'verbose'], {}), /--log/);
  });

  test('--log silent 时未知参数不再打告警', () => {
    const chunks = [];
    const original = process.stderr.write;
    process.stderr.write = (c) => {
      chunks.push(String(c));
      return true;
    };
    try {
      const cfg = resolveConfig(['--log', 'silent'], {});
      assert.equal(cfg.logLevel, 'silent');
      resolveConfig(['--log', 'silent', '--bogus-flag', 'x'], {});
    } finally {
      process.stderr.write = original;
    }
    const bogusWarnings = chunks.filter((c) => c.includes('bogus-flag'));
    assert.deepEqual(bogusWarnings, [], `silent 级别不该输出告警: ${chunks.join('')}`);
  });

  test('未知参数在非 silent 级别会被提示但仍不致命', () => {
    const chunks = [];
    const original = process.stderr.write;
    process.stderr.write = (c) => {
      chunks.push(String(c));
      return true;
    };
    try {
      const cfg = resolveConfig(['--log', 'warn', '--totally-unknown', '1'], {});
      assert.equal(cfg.logLevel, 'warn');
    } finally {
      process.stderr.write = original;
    }
    assert.ok(chunks.some((c) => c.includes('totally-unknown')), `应该提示未知参数: ${chunks.join('')}`);
  });

  test('配置文件生效，且可被环境变量/命令行覆盖；注释键不告警', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-cfg-'));
    const file = path.join(dir, 'config.json');
    const chunks = [];
    const original = process.stderr.write;
    process.stderr.write = (c) => {
      chunks.push(String(c));
      return true;
    };
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({
          '//': '这是注释，不该告警',
          _note: '也是注释',
          port: 8123,
          mode: 'model',
          logLevel: 'warn',
          modelMap: { 'gpt-4o': 'deepseek-v4-flash' },
          timeoutMs: 5000,
        }),
        'utf8',
      );
      const fromFile = resolveConfig(['--config', file], {});
      assert.equal(fromFile.port, 8123);
      assert.equal(fromFile.mode, 'model');
      assert.equal(fromFile.timeoutMs, 5000);
      assert.deepEqual(fromFile.modelMap, { 'gpt-4o': 'deepseek-v4-flash' });
      assert.deepEqual(chunks.filter((c) => c.includes('未知配置项')), [], '注释键不该告警');

      // 环境变量覆盖文件
      const fromEnv = resolveConfig(['--config', file], { OCG_PORT: '9999', OCG_MODE: 'fixed', OCG_SESSION: 's1' });
      assert.equal(fromEnv.port, 9999);
      assert.equal(fromEnv.mode, 'fixed');

      // 命令行覆盖环境变量
      const fromCli = resolveConfig(['--config', file, '--port', '7777'], { OCG_PORT: '9999' });
      assert.equal(fromCli.port, 7777);

      // 未知键仍然要提示
      fs.writeFileSync(file, JSON.stringify({ port: 1, notARealOption: true }), 'utf8');
      chunks.length = 0;
      resolveConfig(['--config', file], {});
      assert.ok(chunks.some((c) => c.includes('notARealOption')), '未知配置项应该告警');

      assert.throws(() => resolveConfig(['--config', path.join(dir, 'nope.json')], {}), /配置文件不存在/);
    } finally {
      process.stderr.write = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================== *
 * 独立复核发现的问题 —— 回归测试
 * ================================================================== */

describe('复核 B1/B2/B3：健壮性', () => {
  test('B1 通过软链接调用也能正常执行（npm bin / npx 形态）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-link-'));
    const link = path.join(dir, 'opencode-go-gateway');
    const real = path.resolve('gateway.mjs');
    fs.symlinkSync(real, link);
    try {
      const out = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 20000 });
      assert.match(out, /opencode-go-gateway/, '软链接调用必须真的有输出');
      assert.match(out, /用法/, '--help 内容必须正常打印');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('B2 上游返回非法状态码不会让进程猝死，改为回 502', async () => {
    // 裸 TCP 上游，回一个 HTTP/1.1 099 的畸形响应
    const { createServer } = await import('node:net');
    const raw = createServer((socket) => {
      socket.on('data', () => socket.write('HTTP/1.1 099 Weird\r\n\r\n'));
    });
    await new Promise((r) => raw.listen(0, '127.0.0.1', r));
    const rawPort = raw.address().port;

    const cfg = resolveConfig(['--port', '0', '--upstream', `http://127.0.0.1:${rawPort}`, '--log', 'silent'], {});
    const server = await startServer(cfg);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x' }),
      });
      assert.equal(res.status, 502, '非法状态码应被改写为 502');
      const data = await res.json();
      assert.equal(data.error.type, 'gateway_bad_upstream_status');

      // 关键：网关进程必须还活着，还能继续服务
      const health = await fetch(`http://127.0.0.1:${port}/_gateway/health`);
      assert.equal(health.status, 200, '网关必须存活');
    } finally {
      await new Promise((r) => server.close(r));
      await new Promise((r) => raw.close(r));
    }
  });

  test('B3 上游返回 101 时客户端不会永久挂起', async () => {
    const { createServer } = await import('node:net');
    const raw = createServer((socket) => {
      socket.on('data', () =>
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'),
      );
    });
    await new Promise((r) => raw.listen(0, '127.0.0.1', r));
    const rawPort = raw.address().port;

    const cfg = resolveConfig(['--port', '0', '--upstream', `http://127.0.0.1:${rawPort}`, '--log', 'silent', '--timeout-ms', '2000'], {});
    const server = await startServer(cfg);
    const port = server.address().port;
    try {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x' }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(res.status, 502);
      assert.ok(Date.now() - started < 4000, '必须在超时前主动返回，而不是挂到客户端超时');
    } finally {
      await new Promise((r) => server.close(r));
      await new Promise((r) => raw.close(r));
    }
  });
});

describe('复核 M1：会话 ID 不再被 user 字段带偏', () => {
  test('请求体里的 user 逐次变化时，会话仍然稳定', async () => {
    await withGateway([], async ({ base }) => {
      const sessions = [];
      for (let i = 0; i < 3; i += 1) {
        const data = await (await apiCall(base, '/v1/chat/completions', { body: { user: `req-${i}-${Math.random()}` } })).json();
        sessions.push(data.receivedHeaders['x-opencode-session']);
      }
      assert.equal(new Set(sessions).size, 1, `user 变化不该导致会话漂移: ${sessions.join(', ')}`);
    });
  });

  test('--use-user-hint 时才会用 user 当会话提示（且稳定复现）', async () => {
    await withGateway(['--use-user-hint'], async ({ base }) => {
      const a = await (await apiCall(base, '/v1/chat/completions', { body: { user: 'doc-1' } })).json();
      const b = await (await apiCall(base, '/v1/chat/completions', { body: { user: 'doc-1' } })).json();
      const c = await (await apiCall(base, '/v1/chat/completions', { body: { user: 'doc-2' } })).json();
      assert.equal(a.receivedHeaders['x-opencode-session'], b.receivedHeaders['x-opencode-session']);
      assert.notEqual(a.receivedHeaders['x-opencode-session'], c.receivedHeaders['x-opencode-session']);
    });
  });

  test('session_id / conversation_id 仍然被采用（显式会话语义）', async () => {
    await withGateway([], async ({ base }) => {
      const a = await (await apiCall(base, '/v1/chat/completions', { body: { session_id: 'conv-9' } })).json();
      const b = await (await apiCall(base, '/v1/chat/completions', { body: { session_id: 'conv-9' } })).json();
      assert.equal(a.receivedHeaders['x-opencode-session'], b.receivedHeaders['x-opencode-session']);
    });
  });
});

describe('复核 M2/M3/M4：安全边界', () => {
  test('M2 管理端点也在本机校验与 local-token 之后', async () => {
    await withGateway(['--local-token', 's3cret'], async ({ base }) => {
      for (const p of ['/_gateway/health', '/_gateway/status', '/_gateway/check']) {
        const res = await fetch(`${base}${p}`);
        assert.equal(res.status, 401, `${p} 不该绕过 local-token`);
      }
      const ok = await fetch(`${base}/_gateway/status`, { headers: { 'x-gateway-token': 's3cret' } });
      assert.equal(ok.status, 200);
    });
  });

  test('M3 伪造 Host 被拒绝（DNS rebinding）', async () => {
    await withGateway([], async ({ base, port }) => {
      const bad = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/v1/models', method: 'GET', headers: { host: 'evil.example' } },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(bad, 403, '可疑 Host 必须被拒绝');

      const good = await fetch(`${base}/_gateway/health`);
      assert.equal(good.status, 200, '正常 Host 不受影响');
    });
  });

  test('M4 任意网站的 Origin 不再被开成免费中转', async () => {
    await withGateway([], async ({ base }) => {
      const res = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'https://evil.example' } });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.type, 'gateway_origin_denied');

      const pre = await fetch(`${base}/v1/chat/completions`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      assert.equal(pre.status, 403);
    });
  });

  test('M4 回环 Origin 与 file:// (null) 仍然放行', async () => {
    await withGateway([], async ({ base }) => {
      for (const origin of ['http://localhost:3000', 'http://127.0.0.1:5173', 'null']) {
        const res = await apiCall(base, '/v1/chat/completions', { headers: { origin } });
        assert.equal(res.status, 200, `来源 ${origin} 应该放行`);
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
      }
    });
  });

  test('--allow-origin 可显式放行指定来源，也支持 *', async () => {
    await withGateway(['--allow-origin', 'https://my.app'], async ({ base }) => {
      const ok = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'https://my.app' } });
      assert.equal(ok.status, 200);
      const no = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'https://other.app' } });
      assert.equal(no.status, 403);
    });
    await withGateway(['--allow-origin', '*'], async ({ base }) => {
      const ok = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'https://any.app' } });
      assert.equal(ok.status, 200);
    });
  });

  test('CORS 基线不因 --allow-origin 而丢失（回环 / null 仍放行）', async () => {
    const safari = 'safari-web-extension://24d1f36b-a0c5-4b24-a493-04a339726689';
    await withGateway(['--allow-origin', safari], async ({ base }) => {
      for (const origin of ['http://localhost:3000', 'http://127.0.0.1:5173', 'null']) {
        const res = await apiCall(base, '/v1/chat/completions', { headers: { origin } });
        assert.equal(res.status, 200, `追加白名单后 ${origin} 仍应放行`);
      }
      const ext = await apiCall(base, '/v1/chat/completions', { headers: { origin: safari } });
      assert.equal(ext.status, 200, '照 403 提示加上来的扩展来源必须放行');
      assert.equal(ext.headers.get('access-control-allow-origin'), safari);
      const otherExt = await apiCall(base, '/v1/chat/completions', {
        headers: { origin: 'safari-web-extension://ffffffff-0000-0000-0000-000000000000' },
      });
      assert.equal(otherExt.status, 403, '没写通配时别的扩展不放行');
    });
  });

  test('--allow-origin 支持通配（Safari 扩展重装后 UUID 变了也不用改配置）', async () => {
    const safari = 'safari-web-extension://24d1f36b-a0c5-4b24-a493-04a339726689';
    await withGateway(['--allow-origin', 'safari-web-extension://*,chrome-extension://abcd'], async ({ base }) => {
      const pre = await fetch(`${base}/v1/chat/completions`, {
        method: 'OPTIONS',
        headers: {
          origin: safari,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      assert.equal(pre.status, 204, '扩展的预检必须本地应答，不能转到上游');
      assert.equal(pre.headers.get('access-control-allow-origin'), safari);
      assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);

      const wild = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'safari-web-extension://any-other-uuid' } });
      assert.equal(wild.status, 200);
      const exact = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'chrome-extension://abcd' } });
      assert.equal(exact.status, 200, '不带 * 的条目按字面量匹配');
      const notExact = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'chrome-extension://zzzz' } });
      assert.equal(notExact.status, 403, '精确条目不能被前缀放宽');
      const evil = await apiCall(base, '/v1/chat/completions', { headers: { origin: 'https://evil.example' } });
      assert.equal(evil.status, 403);
    });
  });

  test('isOriginAllowed: 通配只作用于条目内部的 *，不放大 scheme', () => {
    const cfg = { allowOrigin: ['safari-web-extension://*'] };
    assert.equal(isOriginAllowed('safari-web-extension://abc', cfg), true);
    assert.equal(isOriginAllowed('https://abc', cfg), false);
    assert.equal(isOriginAllowed('safari-web-extension-other://abc', cfg), false);
    // 未配置白名单时：基线放行，其它一律不放过
    assert.equal(isOriginAllowed('http://localhost:3000'), true);
    assert.equal(isOriginAllowed('http://127.0.0.1:5173'), true);
    assert.equal(isOriginAllowed('null'), true);
    assert.equal(isOriginAllowed('https://evil.example'), false);
    assert.equal(isOriginAllowed(''), false);
    assert.equal(isOriginAllowed('not a url'), false);
  });
});

describe('复核 L1-L6：细节加固', () => {
  test('L1 debug 日志不会泄漏 x-api-key / cookie', async () => {
    const chunks = [];
    const original = process.stderr.write;
    process.stderr.write = (c) => {
      chunks.push(String(c));
      return true;
    };
    try {
      await withGateway(['--log', 'debug'], async ({ base }) => {
        await apiCall(base, '/v1/chat/completions', {
          headers: { 'x-api-key': 'sk-LEAK-xapikey-1234567890', cookie: 'session=LEAK-cookie-abcdef' },
        });
      });
    } finally {
      process.stderr.write = original;
    }
    const text = chunks.join('');
    assert.ok(!text.includes('LEAK-xapikey-1234567890'), 'x-api-key 明文泄漏到日志了');
    assert.ok(!text.includes('LEAK-cookie-abcdef'), 'cookie 明文泄漏到日志了');
  });

  test('L2 x-gateway-token 不会被转发给上游', async () => {
    mock.requests.length = 0;
    await withGateway(['--local-token', 'super-secret-local'], async ({ base }) => {
      const res = await apiCall(base, '/v1/chat/completions', { headers: { 'x-gateway-token': 'super-secret-local' } });
      assert.equal(res.status, 200);
      assert.equal(mock.lastRequest().headers['x-gateway-token'], undefined, '本地令牌泄漏给上游了');
    });
  });

  test('L3 含非 latin1 字符的配置在启动时就报错，而不是每个请求 500', () => {
    assert.throws(() => resolveConfig(['--session', '会话一'], {}), /不能放进 HTTP 头/);
    assert.throws(() => resolveConfig(['--user-agent', '我的客户端'], {}), /不能放进 HTTP 头/);
    assert.throws(() => resolveConfig(['--api-key', '密钥abc'], {}), /不能放进 HTTP 头/);
    assert.doesNotThrow(() => resolveConfig(['--user-agent', 'my-agent/1.0'], {}));
  });

  test('L4 路径里的 . 和 .. 段被清理，不能打到上游其它路径', async () => {
    assert.equal(normalizePath('/../zen/v1/models'), '/v1/zen/v1/models');
    assert.equal(normalizePath('/v1/./models'), '/v1/models');
    assert.equal(normalizePath('/a/../../b'), '/v1/a/b');
    mock.requests.length = 0;
    await withGateway([], async ({ base }) => {
      await fetch(`${base}/v1/../zen/v1/models`);
      const sent = mock.lastRequest().path;
      assert.ok(!sent.includes('..'), `上游收到了含 .. 的路径: ${sent}`);
      assert.ok(sent.startsWith('/v1/'), `上游路径必须以 /v1/ 开头: ${sent}`);
    });
  });

  test('L5 counters.byPath 有上限，不会被海量路径撑爆', async () => {
    await withGateway([], async ({ base }) => {
      for (let i = 0; i < 260; i += 1) {
        await fetch(`${base}/v1/chat/completions?u=${i}`, { headers: { authorization: 'Bearer k' } });
      }
      const status = await (await fetch(`${base}/_gateway/status`)).json();
      assert.ok(Object.keys(status.counters.byPath).length <= 201, 'byPath 必须有上限');
    });
  });

  test('L6 超长请求头返回 431 而不是 400', async () => {
    await withGateway([], async ({ base, port }) => {
      const code = await new Promise((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/_gateway/health', method: 'GET', headers: { 'x-huge': 'y'.repeat(20000) } },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          },
        );
        req.on('error', () => resolve('error'));
        req.end();
      });
      assert.equal(code, 431);
    });
  });

  test('L7 HEAD 请求保留上游 content-length', async () => {
    await withGateway([], async ({ base, port }) => {
      const code = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/v1/models', method: 'HEAD' }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode, cl: res.headers['content-length'] }));
        });
        req.on('error', () => resolve({ status: 'error' }));
        req.end();
      });
      assert.equal(code.status, 200);
      assert.ok(code.cl, 'HEAD 响应应该保留 content-length');
    });
  });
});
