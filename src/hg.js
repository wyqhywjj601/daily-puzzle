/**
 * HG短剧（huangguoai.com）在 Worker 上的实现。
 * 站点把所有读操作收敛成 POST /api/edge/request 信封；
 * HLS 清单、密钥和分片统一经 /api/hongguo/stream 同源代理。
 */

const PREFIX = '/api/hongguo';
const HG_ORIGIN = 'https://huangguoai.com';
const HG_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const IMG_KEY = new TextEncoder().encode('f5d965df75336270');
const IMG_IV = new TextEncoder().encode('97b60394abc2fbe1');

const ALLOWED_HOST =
  /(^|\.)(qznovelvod\.com|byteimg\.com|fqnovelpic\.com|pstatp\.com|douyinvod\.com|bytecdn\.cn|ibytedtos\.com|snssdk\.com|drleao\.cn|hzjvlo\.cn|huangguoai\.com)$/;

class HgError extends Error {
  constructor(message, status = 502, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errorResponse(error) {
  const status = error instanceof HgError ? error.status : 502;
  const payload = { ok: false, error: { message: error.message || '请求失败' } };
  if (error.code) payload.error.code = error.code;
  return jsonResponse(payload, status);
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

async function hgEdge(method, requestPath, body) {
  const payload = JSON.stringify({
    method,
    path: requestPath,
    body: body === undefined ? '' : base64Utf8(JSON.stringify(body)),
    content_type: body === undefined ? '' : 'application/json',
  });

  let response;
  try {
    response = await fetch(`${HG_ORIGIN}/api/edge/request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        referer: `${HG_ORIGIN}/`,
        'user-agent': HG_UA,
      },
      body: payload,
    });
  } catch (error) {
    throw new HgError(`HG 连接失败：${error.message}`, 502);
  }

  if (response.status === 401 || response.status === 403) {
    throw new HgError('HG 站点拒绝了匿名请求', 502, 'ANONYMOUS_LIMITED');
  }
  if (response.status !== 200) {
    throw new HgError(`HG HTTP ${response.status}`, 502);
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new HgError('HG 返回的不是 JSON', 502);
  }
  if (parsed && parsed.status !== 1) {
    throw new HgError(parsed.msg || 'HG 接口返回失败', 502);
  }
  return parsed.data;
}

function hgRow(item) {
  return {
    id: String(item?.id ?? ''),
    title: item?.title ?? '',
    description: item?.description ?? '',
    cover: item?.cover ?? '',
    episodes: Number(item?.episode_count ?? 0) || 0,
    heat: item?.hot ?? item?.like_count,
    score: typeof item?.score === 'number' ? item.score : undefined,
    tags: Array.isArray(item?.tags) ? item.tags.slice(0, 3).map(String) : [],
    finished: item?.is_finished !== false,
  };
}

export async function handleHg(request, url) {
  const path = url.pathname.slice(PREFIX.length);
  try {
    if (path === '/hg/feed') {
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
      const size = Math.min(40, Math.max(6, Number(url.searchParams.get('size') ?? 24) || 24));
      const data = await hgEdge('GET', `/api/videos?page=${page}&size=${size}`);
      return jsonResponse({
        page,
        items: (data?.items ?? []).map(hgRow).filter((item) => item.id),
        total: Number(data?.pagination?.total ?? 0) || undefined,
      });
    }

    if (path === '/hg/search') {
      const text = (url.searchParams.get('q') ?? '').trim();
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
      if (!text) return jsonResponse({ items: [] });
      const data = await hgEdge('GET', `/api/search?q=${encodeURIComponent(text)}&page=${page}&size=24`);
      return jsonResponse({
        items: (data?.items ?? []).map(hgRow).filter((item) => item.id),
        engine: data?.engine,
      });
    }

    if (path === '/hg/series') {
      const id = (url.searchParams.get('id') ?? '').trim();
      if (!/^\d+$/.test(id)) throw new HgError('bad id', 400);
      const data = await hgEdge('GET', `/api/videos/${id}`);
      const episodes = (data?.episodes ?? [])
        .map((episode) => ({
          ep: Number(episode?.ep_num ?? 0) || 0,
          title: episode?.title ?? '',
          duration: Number(episode?.duration ?? 0) || undefined,
          playable: episode?.status !== 0,
        }))
        .filter((episode) => episode.ep > 0 && episode.playable)
        .sort((left, right) => left.ep - right.ep);
      return jsonResponse({
        series: {
          id: String(data?.id ?? id),
          title: data?.title ?? '',
          description: data?.description ?? '',
          cover: data?.cover ?? '',
          episodes: Number(data?.episode_count ?? episodes.length) || episodes.length,
          tags: Array.isArray(data?.tags) ? data.tags.map(String) : [],
          score: typeof data?.score === 'number' ? data.score : undefined,
          finished: data?.is_finished !== false,
        },
        episodes,
      });
    }

    if (path === '/hg/play') {
      const id = (url.searchParams.get('id') ?? '').trim();
      const ep = Math.max(1, Number(url.searchParams.get('ep') ?? 1) || 1);
      if (!/^\d+$/.test(id)) throw new HgError('bad id', 400);
      const data = await hgEdge('POST', `/api/videos/${id}/episodes/${ep}/playback`, {});
      const sources = [];
      if (typeof data?.streams?.main === 'string' && data.streams.main) {
        sources.push({
          kind: 'hls',
          codec: 'h264',
          url: `${PREFIX}/stream?u=${encodeURIComponent(data.streams.main)}`,
        });
      }
      if (typeof data?.streams?.hevc === 'string' && data.streams.hevc) {
        sources.push({
          kind: 'hls',
          codec: 'hevc',
          url: `${PREFIX}/stream?u=${encodeURIComponent(data.streams.hevc)}`,
        });
      }
      if (sources.length === 0) {
        throw new HgError('这一集没有可播放的地址', 502, 'NO_PLAYABLE_SOURCE');
      }
      return jsonResponse({
        id: String(data?.id ?? id),
        episode: Number(data?.ep_num ?? ep) || ep,
        title: data?.title ?? '',
        duration: Number(data?.duration ?? 0) || undefined,
        sources,
      });
    }

    throw new HgError('not found', 404);
  } catch (error) {
    return errorResponse(error);
  }
}

/* ── HLS / 分片代理 ─────────────────────────────────── */

function asTarget(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new HgError('bad stream url', 400);
  }
  if (!/^https?:$/.test(target.protocol) || !ALLOWED_HOST.test(target.hostname)) {
    throw new HgError(`unsupported stream host: ${target.hostname}`, 403);
  }
  return target;
}

function rewriteManifest(text, baseHref) {
  const base = new URL(baseHref);
  const proxied = (raw) => {
    let absolute;
    try {
      absolute = new URL(raw, base).href;
    } catch {
      return raw;
    }
    return `${PREFIX}/stream?u=${encodeURIComponent(absolute)}`;
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (!trimmed.includes('URI="')) return line;
        return trimmed.replace(/URI="([^"]+)"/g, (_, raw) => `URI="${proxied(raw)}"`);
      }
      return proxied(trimmed);
    })
    .join('\n');
}

async function fetchText(target) {
  const response = await fetch(target.href, {
    headers: { 'user-agent': HG_UA, referer: `${HG_ORIGIN}/` },
    redirect: 'follow',
  });
  if (!response.ok) throw new HgError(`manifest ${response.status}`, 502);
  return response.text();
}

export async function handleStream(request, url) {
  try {
    const target = asTarget(url.searchParams.get('u') ?? '');
    const range = request.headers.get('range');
    const upstream = await fetch(target.href, {
      headers: {
        'user-agent': HG_UA,
        referer: `${HG_ORIGIN}/`,
        ...(range ? { range } : {}),
      },
      redirect: 'follow',
    });

    const type = upstream.headers.get('content-type') ?? '';
    const isManifest = /mpegurl/.test(type) || /\.m3u8(\?|$)/.test(target.href);

    if (isManifest && upstream.ok) {
      let text = await upstream.text();
      let base = target.href;
      if (/^#EXTM3U/.test(text.trimStart()) && /#EXT-X-STREAM-INF/.test(text)) {
        const child = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('#'));
        if (child) {
          const childUrl = new URL(child, base);
          text = await fetchText(childUrl);
          base = childUrl.href;
        }
      }
      return new Response(rewriteManifest(text, base), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    const headers = new Headers();
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set('cache-control', 'public, max-age=3600');
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/* ── 封面 ───────────────────────────────────────────── */

function looksLikeImage(bytes) {
  if (!bytes || bytes.byteLength < 12) return false;
  const view = new Uint8Array(bytes);
  if (view[0] === 0xff && view[1] === 0xd8) return true;
  if (String.fromCharCode(...view.subarray(0, 4)) === 'GIF8') return true;
  if (view[0] === 0x89 && String.fromCharCode(...view.subarray(1, 4)) === 'PNG') return true;
  if (String.fromCharCode(...view.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...view.subarray(8, 12)) === 'WEBP') {
    return true;
  }
  return false;
}

async function decryptCover(bytes) {
  try {
    const key = await crypto.subtle.importKey('raw', IMG_KEY, { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: IMG_IV }, key, bytes);
    return new Uint8Array(plain);
  } catch {
    return undefined;
  }
}

export async function handleCover(request, url) {
  try {
    const target = asTarget(url.searchParams.get('u') ?? '');
    const upstream = await fetch(target.href, {
      headers: { 'user-agent': HG_UA, referer: `${HG_ORIGIN}/` },
      redirect: 'follow',
    });
    if (!upstream.ok) throw new HgError(`cover ${upstream.status}`, upstream.status);

    const headers = {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=86400',
    };
    const type = upstream.headers.get('content-type') ?? '';
    if (/^image\/(jpeg|png|webp|gif|avif)/.test(type)) {
      headers['content-type'] = type;
      return new Response(request.method === 'HEAD' ? null : upstream.body, { status: 200, headers });
    }

    const bytes = await upstream.arrayBuffer();
    if (looksLikeImage(bytes)) {
      return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
    }
    const plain = await decryptCover(bytes);
    if (plain && looksLikeImage(plain)) {
      return new Response(request.method === 'HEAD' ? null : plain, { status: 200, headers });
    }
    return new Response(null, { status: 415 });
  } catch (error) {
    return errorResponse(error);
  }
}
