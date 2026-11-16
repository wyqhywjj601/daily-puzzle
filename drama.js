/* =========================================================
   短剧弹窗 — 摸鱼短剧 / HG短剧
   数据与播放统一走同源 /api/hongguo（本地由 DSH 插件提供，
   线上由 Worker 反代到 DRAMA_ORIGIN）。
   ========================================================= */
(function () {
  'use strict';

  const API = '/api/hongguo';

  const dramaModal = document.getElementById('dramaModal');
  if (!dramaModal) return;

  const dramaClose = document.getElementById('dramaClose');
  const dramaBtn = document.getElementById('dramaBtn');
  const tabs = Array.from(dramaModal.querySelectorAll('.drama-tab'));
  const refreshBtn = document.getElementById('dramaRefresh');
  const listWrap = document.getElementById('dramaListWrap');
  const grid = document.getElementById('dramaGrid');
  const emptyEl = document.getElementById('dramaEmpty');
  const playerEl = document.getElementById('dramaPlayer');
  const video = document.getElementById('dramaVideo');
  const stageMask = document.getElementById('dramaStageMask');
  const stageText = document.getElementById('dramaStageText');
  const backBtn = document.getElementById('dramaBack');
  const nowTitle = document.getElementById('dramaNowTitle');
  const nowSub = document.getElementById('dramaNowSub');
  const epSelect = document.getElementById('dramaEpisodeSelect');

  const state = {
    source: 'moyu',
    items: { moyu: [], hg: [] },
    loadedAt: { moyu: 0, hg: 0 },
    hgPage: 0,
    loading: { moyu: false, hg: false },
    series: null, // { source, id, title, episodes: [{ id, number, label }], index }
    hls: null,
    hlsLib: null,
    playToken: 0,
  };

  const cacheMs = 60 * 1000;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  function friendlyError(error, status) {
    const message = String(error && error.message ? error.message : error || '');
    if (status === 503 || /Failed to fetch|NetworkError|Load failed|服务未连接/.test(message)) {
      return '短剧服务未连接。请先启动本地 DSH，并用 npm run dev 打开页面。';
    }
    return message || '加载失败，请稍后重试';
  }

  async function api(path) {
    let response;
    try {
      response = await fetch(API + path, { headers: { accept: 'application/json' }, cache: 'no-store' });
    } catch (error) {
      throw new Error(friendlyError(error));
    }
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      throw new Error(friendlyError('服务未连接', response.status));
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || (body && body.ok === false)) {
      const message = body && body.error && body.error.message;
      const error = new Error(friendlyError(message || `HTTP ${response.status}`, response.status));
      if (body && body.error && body.error.code) error.code = body.error.code;
      throw error;
    }
    return body;
  }

  function coverURL(url) {
    if (!url) return '';
    return `${API}/cover?u=${encodeURIComponent(url)}`;
  }

  /* ── 列表 ───────────────────────────────────────────── */

  function setListMessage(text) {
    emptyEl.textContent = text || '';
    emptyEl.hidden = !text;
  }

  function skeletons(count) {
    return Array.from({ length: count }, () => `
      <div class="drama-card is-skeleton" aria-hidden="true">
        <span class="drama-cover"></span>
        <span class="drama-card-line"></span>
        <span class="drama-card-line is-short"></span>
      </div>`).join('');
  }

  function cardHTML(item) {
    const cover = coverURL(item.cover);
    const metaParts = [];
    if (item.episodes) metaParts.push(`共 ${item.episodes} 集`);
    if (typeof item.score === 'number') metaParts.push(`${item.score} 分`);
    if (Array.isArray(item.tags) && item.tags.length) metaParts.push(item.tags[0]);
    return `
      <button class="drama-card" type="button" data-id="${esc(item.id)}">
        <span class="drama-cover">
          ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async">` : ''}
          <span class="drama-cover-fallback" aria-hidden="true">短剧</span>
        </span>
        <span class="drama-card-title">${esc(item.title || '未命名短剧')}</span>
        <span class="drama-card-meta">${esc(metaParts.join(' · ') || '—')}</span>
      </button>`;
  }

  function bindCoverFallbacks(root) {
    root.querySelectorAll('.drama-cover img').forEach((img) => {
      img.addEventListener('error', () => img.remove(), { once: true });
    });
  }

  function renderList() {
    const items = state.items[state.source];
    grid.innerHTML = items.map(cardHTML).join('');
    bindCoverFallbacks(grid);
    setListMessage(items.length ? '' : '暂时没有拿到短剧列表');
  }

  async function loadList(options = {}) {
    const source = state.source;
    if (state.loading[source]) return;
    const fresh = Date.now() - state.loadedAt[source] < cacheMs && state.items[source].length > 0;
    if (fresh && !options.force) {
      renderList();
      return;
    }

    state.loading[source] = true;
    refreshBtn.disabled = true;
    setListMessage('');
    grid.innerHTML = skeletons(12);
    try {
      let items;
      if (source === 'moyu') {
        const data = await api('/feed');
        items = Array.isArray(data.items) ? data.items : [];
      } else {
        const page = options.next ? state.hgPage + 1 : 1;
        const data = await api(`/hg/feed?page=${page}&size=24`);
        items = Array.isArray(data.items) ? data.items : [];
        state.hgPage = page;
        if (page > 1 && items.length === 0) {
          state.hgPage = 0;
          state.loadedAt.hg = 0;
          state.items.hg = [];
          state.loading.hg = false;
          refreshBtn.disabled = false;
          await loadList({ force: true });
          return;
        }
      }
      if (source !== state.source) return;
      state.items[source] = items;
      state.loadedAt[source] = Date.now();
      renderList();
    } catch (error) {
      if (source !== state.source) return;
      grid.innerHTML = '';
      // 线上没有本地 DSH：摸鱼源不可用时自动切到 HG，避免打开弹窗先看到报错。
      if (error && error.code === 'LOCAL_ONLY' && source === 'moyu') {
        setSource('hg');
        return;
      }
      setListMessage(friendlyError(error));
    } finally {
      state.loading[source] = false;
      refreshBtn.disabled = false;
    }
  }

  /* ── 播放器 ─────────────────────────────────────────── */

  function setStage(text, isError) {
    stageMask.hidden = false;
    stageMask.classList.toggle('is-error', Boolean(isError));
    stageMask.classList.toggle('is-ready', !text && !isError);
    stageText.textContent = text || '';
    if (!text && !isError) stageMask.hidden = true;
  }

  function destroyHls() {
    if (state.hls) {
      try { state.hls.destroy(); } catch (error) { /* ignore */ }
      state.hls = null;
    }
  }

  function resetVideo() {
    destroyHls();
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  function loadHlsLib() {
    if (state.hlsLib) return Promise.resolve(state.hlsLib);
    if (window.Hls) {
      state.hlsLib = window.Hls;
      return Promise.resolve(window.Hls);
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/hls.min.js';
      script.onload = () => {
        if (window.Hls) {
          state.hlsLib = window.Hls;
          resolve(window.Hls);
        } else {
          reject(new Error('播放器组件加载失败'));
        }
      };
      script.onerror = () => reject(new Error('播放器组件加载失败'));
      document.head.appendChild(script);
    });
  }

  function pickSource(sources) {
    const list = Array.isArray(sources) ? sources.filter((source) => source && source.url) : [];
    return list.find((source) => source.kind === 'file')
      || list.find((source) => source.kind === 'hls' && source.codec !== 'hevc')
      || list[0];
  }

  async function attachSource(source) {
    resetVideo();
    if (source.kind === 'hls') {
      const Hls = await loadHlsLib();
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          capLevelToPlayerSize: true,
          maxBufferLength: 20,
          maxMaxBufferLength: 30,
          backBufferLength: 10,
          maxBufferSize: 30 * 1000 * 1000,
        });
        state.hls = hls;
        hls.loadSource(source.url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (event, data) => {
          if (!data || !data.fatal) return;
          const message = data.type === Hls.ErrorTypes.NETWORK_ERROR ? '视频流连接失败' : '这一集暂时无法解码';
          setStage(message + '，可以换一集试试', true);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
        });
        return;
      }
    }
    video.src = source.url;
    video.play().catch(() => {});
  }

  function updateEpisodeUI() {
    const series = state.series;
    if (!series) return;
    nowTitle.textContent = series.title;
    const episode = series.episodes[series.index];
    nowSub.textContent = episode && episode.label
      ? `${episode.label} · 共 ${series.episodes.length} 集`
      : `共 ${series.episodes.length} 集`;
    epSelect.innerHTML = series.episodes
      .map((item, index) => `<option value="${index}">${esc(item.label || `第 ${index + 1} 集`)}</option>`)
      .join('');
    epSelect.value = String(series.index);
  }

  async function playIndex(index, options = {}) {
    const series = state.series;
    if (!series) return;
    const episode = series.episodes[index];
    if (!episode) return;

    series.index = index;
    updateEpisodeUI();
    setStage('正在准备播放…');

    const token = ++state.playToken;
    try {
      let data;
      if (series.source === 'moyu') {
        data = await api(`/play?episode=${encodeURIComponent(episode.id)}&series=${encodeURIComponent(series.id)}`);
      } else {
        data = await api(`/hg/play?id=${encodeURIComponent(series.id)}&ep=${encodeURIComponent(episode.number)}`);
      }
      if (token !== state.playToken) return;
      const source = pickSource(data && data.sources);
      if (!source) throw new Error('这一集暂时没有可播放的地址');
      await attachSource(source);
      if (token !== state.playToken) return;
      if (options.autoplay !== false) video.play().catch(() => {});
    } catch (error) {
      if (token !== state.playToken) return;
      setStage(friendlyError(error), true);
    }
  }

  function showPlayer() {
    listWrap.hidden = true;
    playerEl.hidden = false;
    refreshBtn.hidden = true;
    dramaModal.querySelector('.drama-modal').classList.add('is-playing');
  }

  function showList() {
    resetVideo();
    state.series = null;
    state.playToken += 1;
    playerEl.hidden = true;
    listWrap.hidden = false;
    refreshBtn.hidden = false;
    epSelect.innerHTML = '';
    const modal = dramaModal.querySelector('.drama-modal');
    if (modal) modal.classList.remove('is-playing');
  }

  async function openSeries(id) {
    const source = state.source;
    setStage('正在打开短剧…');
    showPlayer();
    resetVideo();
    nowTitle.textContent = '正在加载…';
    nowSub.textContent = '';
    epSelect.innerHTML = '';

    try {
      let series;
      if (source === 'moyu') {
        const data = await api(`/series?id=${encodeURIComponent(id)}`);
        const rows = Array.isArray(data.episodes) ? data.episodes : [];
        series = {
          source,
          id: String(data.series && data.series.id ? data.series.id : id),
          title: (data.series && data.series.title) || '未命名短剧',
          episodes: rows
            .filter((row) => row && row.id && row.playable !== false)
            .map((row) => ({ id: String(row.id), number: Number(row.number) || 0, label: row.title || `第 ${row.number || ''} 集` })),
        };
      } else {
        const data = await api(`/hg/series?id=${encodeURIComponent(id)}`);
        const rows = Array.isArray(data.episodes) ? data.episodes : [];
        series = {
          source,
          id: String(data.series && data.series.id ? data.series.id : id),
          title: (data.series && data.series.title) || '未命名短剧',
          episodes: rows
            .filter((row) => row && row.ep)
            .map((row) => ({ id: String(row.ep), number: Number(row.ep) || 0, label: `第 ${row.ep} 集` })),
        };
      }
      if (!series.episodes.length) throw new Error('这部剧暂时没有可播放的剧集');
      state.series = series;
      await playIndex(0);
    } catch (error) {
      setStage(friendlyError(error), true);
      nowTitle.textContent = '打开失败';
      nowSub.textContent = '';
    }
  }

  /* ── 弹窗 ───────────────────────────────────────────── */

  function openModal() {
    if (!dramaModal.hidden) return;
    const toast = document.getElementById('toast');
    if (toast) toast.classList.remove('is-visible');
    dramaModal.hidden = false;
    document.body.classList.add('drama-open');
    dramaModal.offsetWidth; // eslint-disable-line no-unused-expressions
    dramaModal.classList.add('is-open');
    showList();
    loadList();
    const modal = dramaModal.querySelector('.drama-modal');
    if (modal) modal.focus({ preventScroll: true });
  }

  function closeModal() {
    if (dramaModal.hidden) return;
    showList();
    dramaModal.classList.remove('is-open');
    dramaModal.hidden = true;
    document.body.classList.remove('drama-open');
    if (dramaBtn) dramaBtn.focus({ preventScroll: true });
  }

  function setSource(source) {
    if (state.source === source) return;
    state.source = source;
    tabs.forEach((tab) => {
      const active = tab.dataset.source === source;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    showList();
    loadList();
  }

  /* ── 事件 ───────────────────────────────────────────── */

  if (dramaBtn) dramaBtn.addEventListener('click', openModal);
  dramaClose.addEventListener('click', closeModal);
  dramaModal.addEventListener('click', (event) => {
    if (event.target === dramaModal) closeModal();
  });

  tabs.forEach((tab) => tab.addEventListener('click', () => setSource(tab.dataset.source)));

  refreshBtn.addEventListener('click', () => {
    if (state.source === 'hg') {
      loadList({ force: true, next: true });
      return;
    }
    if (state.items.moyu.length > 12) {
      state.items.moyu.push(...state.items.moyu.splice(0, 12));
      renderList();
      return;
    }
    loadList({ force: true });
  });

  grid.addEventListener('click', (event) => {
    const card = event.target.closest('.drama-card');
    if (!card || !card.dataset.id) return;
    openSeries(card.dataset.id);
  });

  backBtn.addEventListener('click', showList);

  epSelect.addEventListener('change', () => {
    playIndex(Number(epSelect.value));
  });

  video.addEventListener('loadedmetadata', () => {
    const stage = video.closest('.drama-stage');
    const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 0;
    if (!stage || !ratio) return;
    stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    stage.style.width = ratio < 1.2
      ? `min(100%, calc(min(56dvh, 540px) * ${ratio.toFixed(4)}))`
      : '100%';
  });
  video.addEventListener('loadeddata', () => setStage(''));
  video.addEventListener('playing', () => setStage(''));
  video.addEventListener('error', () => {
    if (!video.currentSrc) return;
    setStage('这一集暂时无法解码，可以换一集试试', true);
  });
  video.addEventListener('ended', () => {
    const series = state.series;
    if (!series) return;
    if (series.index + 1 < series.episodes.length) playIndex(series.index + 1);
  });

  window.addEventListener('keydown', (event) => {
    if (dramaModal.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  }, true);

  // 切到后台时停掉声音和 HLS 拉流，回来再继续
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !dramaModal.hidden) video.pause();
    if (!state.hls) return;
    if (document.hidden) state.hls.stopLoad();
    else state.hls.startLoad();
  });
})();
