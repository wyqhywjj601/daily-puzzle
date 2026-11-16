/**
 * Cloudflare Worker entry.
 * - 301 http → https
 * - /api/hongguo/hg/*、/stream、/cover → Worker 内实现（HG短剧）
 * - 其余 /api/hongguo/* → DRAMA_ORIGIN（可选：本地 DSH 隧道 / 自建后端）
 * - 其余请求交给静态资源
 */
import { handleCover, handleHg, handleStream } from './hg.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    const path = url.pathname;
    if (path === '/api/hongguo/hg' || path.startsWith('/api/hongguo/hg/')) {
      return handleHg(request, url);
    }
    if (path === '/api/hongguo/stream') {
      return handleStream(request, url);
    }
    if (path === '/api/hongguo/cover') {
      return handleCover(request, url);
    }
    if (path === '/api/hongguo' || path.startsWith('/api/hongguo/')) {
      return proxyDrama(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};

function errorResponse(message, status, code) {
  const error = { message };
  if (code) error.code = code;
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function proxyDrama(request, env, url) {
  const origin = env.DRAMA_ORIGIN;
  if (!origin) {
    return errorResponse('摸鱼短剧仅支持本地运行；线上请切换到 HG短剧。', 503, 'LOCAL_ONLY');
  }

  let target;
  try {
    target = new URL(url.pathname + url.search, origin);
  } catch {
    return errorResponse('DRAMA_ORIGIN 配置无效', 500);
  }

  const headers = new Headers(request.headers);
  headers.delete('host');

  const init = {
    method: request.method,
    headers,
    redirect: 'follow',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    return errorResponse(`短剧服务连接失败：${error.message}`, 502);
  }

  const responseHeaders = new Headers(upstream.headers);
  if (responseHeaders.has('content-encoding')) {
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
  }
  responseHeaders.delete('set-cookie');

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
