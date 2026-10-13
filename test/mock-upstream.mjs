/**
 * 测试用 mock 上游。模拟 opencode.ai/inference/go 的行为，
 * 记录收到的每个请求（含请求头），方便断言网关到底发了什么。
 */
import http from 'node:http';
import zlib from 'node:zlib';

export function createMockServer() {
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = null;
      }
      const record = {
        method: req.method,
        path: req.url,
        headers: { ...req.headers },
        body,
        rawLength: raw.length,
        raw,
        at: Date.now(),
      };
      requests.push(record);

      const mode = body?.__mock ?? 'echo';

      if (mode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你' } }] })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }, 300);
        return;
      }

      if (mode === 'gzip') {
        const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true, compressed: true }), 'utf8'));
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(payload.length) });
        res.end(payload);
        return;
      }

      if (mode === 'status') {
        const payload = Buffer.from(JSON.stringify(body.payload ?? { error: { type: 'mock_error', message: 'mock failure' } }), 'utf8');
        res.writeHead(body.status ?? 400, { 'content-type': 'application/json', 'content-length': String(payload.length) });
        res.end(payload);
        return;
      }

      if (mode === 'sse-noheader') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
        return;
      }

      const payload = Buffer.from(
        JSON.stringify({
          ok: true,
          receivedPath: req.url,
          receivedMethod: req.method,
          receivedHeaders: req.headers,
          receivedBody: body,
        }),
        'utf8',
      );
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(payload.length) });
      res.end(payload);
    });
  });

  return {
    server,
    requests,
    lastRequest: () => requests[requests.length - 1],
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// 允许直接运行: node test/mock-upstream.mjs [port]
if (process.argv[1] && process.argv[1].endsWith('mock-upstream.mjs')) {
  const port = Number(process.argv[2] || 9931);
  const mock = createMockServer();
  mock.server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`mock upstream on http://127.0.0.1:${port}\n`);
  });
}
