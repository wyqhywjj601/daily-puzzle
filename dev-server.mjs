/**
 * 本地调试服务器
 * - 静态文件：当前目录
 * - /api/hongguo/*：反代到本地 DSH 插件（默认 http://127.0.0.1:59649）
 *
 * 用法：npm run dev
 * 若 DSH 端口不同：DRAMA_ORIGIN=http://127.0.0.1:PORT npm run dev
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve('.');
const PORT = Number(process.env.PORT || 4173);
const PREFIX = '/api/hongguo';
let ORIGIN = new URL(process.env.DRAMA_ORIGIN || 'http://127.0.0.1:59649');

/** DSH 桌面端的监听端口每次重启都可能变，自动找一下。 */
function detectDshPort() {
  try {
    const output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    let command = '';
    const ports = [];
    for (const line of output.split('\n')) {
      if (line.startsWith('c')) command = line.slice(1);
      else if (line.startsWith('n') && /DeepSeek/i.test(command)) {
        const match = /127\.0\.0\.1:(\d+)$/.exec(line.slice(1));
        if (match) ports.push(Number(match[1]));
      }
    }
    return ports[0];
  } catch {
    return undefined;
  }
}

async function resolveOrigin() {
  if (process.env.DRAMA_ORIGIN) return;
  const port = detectDshPort();
  if (!port) return;
  const candidate = new URL(`http://127.0.0.1:${port}`);
  try {
    const response = await fetch(`${candidate.origin}${PREFIX}/feed`, {
      signal: AbortSignal.timeout(2500),
    });
    if (response.ok) ORIGIN = candidate;
  } catch {
    // 自动探测失败就保留默认端口，页面会给出提示。
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`)) {
    proxy(request, response, url);
    return;
  }
  serveStatic(request, response, url);
});

function serveStatic(request, response, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = normalize(join(ROOT, pathname));
  if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let info;
  try {
    info = statSync(filePath);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  if (!info.isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function proxy(request, response, url) {
  const target = new URL(url.pathname + url.search, ORIGIN);
  const headers = { ...request.headers, host: target.host };

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: request.method,
      headers,
      timeout: 300_000,
    },
    (upstreamResponse) => {
      const outHeaders = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue;
        if (['connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'].includes(name)) continue;
        outHeaders[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode || 502, outHeaders);
      if (request.method === 'HEAD') {
        upstreamResponse.resume();
        response.end();
        return;
      }
      upstreamResponse.pipe(response);
      upstreamResponse.on('error', () => response.destroy());
    },
  );

  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, error: { message: `短剧服务未连接：${error.message}` } }));
  });
  response.on('close', () => {
    if (!response.writableEnded) upstream.destroy();
  });
  request.pipe(upstream);
}

await resolveOrigin();

server.listen(PORT, () => {
  console.log(`每日拼图 dev: http://127.0.0.1:${PORT}`);
  console.log(`短剧接口反代: ${PREFIX} -> ${ORIGIN.origin}`);
});
