/* =========================================================
   每日拼图 — Daily Calendar Puzzle
   Vanilla JS, no dependencies.
   ========================================================= */
(() => {
  'use strict';

  const COLS = 7;
  const ROWS = 8;
  const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
  const WEEKDAY_NAMES = WEEKDAY_CHARS.map((c) => `星期${c}`);
  const STORAGE_PREFIX = 'daily-puzzle.v2.state.';
  const HISTORY_KEY = 'daily-puzzle.v1.history';
  const SOUND_KEY = 'daily-puzzle.v1.sound';
  const INTRO_KEY = 'daily-puzzle.v1.intro';

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const pad2 = (n) => String(n).padStart(2, '0');
  const coordKey = (c, r) => `${c},${r}`;

  function dateKeyOf(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function makeDate(y, m, d) {
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }

  function addDays(date, amount) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + amount);
    return d;
  }

  function todayAtNoon() {
    const now = new Date();
    return makeDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function parseHashDate() {
    const match = location.hash.match(/^#(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const date = makeDate(y, m, d);
    if (date.getFullYear() !== y || date.getMonth() + 1 !== m || date.getDate() !== d) return null;
    return date;
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
  }

  function fullDateText(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · ${WEEKDAY_NAMES[date.getDay()]}`;
  }

  /* =========================================================
     Board model
     ========================================================= */

  const boardSpec = new Map();

  for (let m = 1; m <= 12; m += 1) {
    const c = (m - 1) % 6;
    const r = Math.floor((m - 1) / 6);
    boardSpec.set(coordKey(c, r), { type: 'month', value: m, key: `month-${m}` });
  }

  for (let d = 1; d <= 31; d += 1) {
    let c;
    let r;
    if (d <= 28) {
      c = (d - 1) % 7;
      r = 2 + Math.floor((d - 1) / 7);
    } else {
      c = d - 29;
      r = 6;
    }
    boardSpec.set(coordKey(c, r), { type: 'day', value: d, key: `day-${d}` });
  }

  [0, 1, 2, 3].forEach((weekday, i) => {
    boardSpec.set(coordKey(3 + i, 6), { type: 'weekday', value: weekday, key: `weekday-${weekday}` });
  });
  [4, 5, 6].forEach((weekday, i) => {
    boardSpec.set(coordKey(4 + i, 7), { type: 'weekday', value: weekday, key: `weekday-${weekday}` });
  });

  const cells = [];
  const cellByKey = new Map();
  const cellByCoord = new Map();

  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const spec = boardSpec.get(coordKey(c, r));
      if (!spec) continue;
      const def = {
        ...spec,
        c,
        r,
        index: cells.length,
        coord: coordKey(c, r),
        aria: spec.type === 'month'
          ? `${spec.value}月`
          : spec.type === 'day'
            ? `${spec.value}日`
            : WEEKDAY_NAMES[spec.value],
      };
      cells.push(def);
      cellByKey.set(def.key, def);
      cellByCoord.set(def.coord, def);
    }
  }

  const CELL_COUNT = cells.length;
  const ALL_MASK = (1n << BigInt(CELL_COUNT)) - 1n;
  const FULL_PIECE_MASK = (1 << 10) - 1;
  const bitToIndex = new Map();
  for (let i = 0; i < CELL_COUNT; i += 1) {
    bitToIndex.set((1n << BigInt(i)).toString(36), i);
  }

  /* =========================================================
     Piece model
     ========================================================= */

  const BASE_PIECES = [
    [[0, 0], [1, 0], [0, 1], [0, 2], [1, 2]],         // U 形 · 开口朝右
    [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1]],         // 缺角 · 左上缺一格
    [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]],         // 大 Z · 闪电形
    [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]],         // 丁字 · 横梁在上
    [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]],         // 长 L · 四格加一格
    [[1, 0], [2, 0], [3, 0], [0, 1], [1, 1]],         // 台阶 · 两段错开
    [[1, 0], [2, 0], [0, 1], [1, 1]],                 // 小 Z · 两格错开
    [[0, 0], [1, 0], [2, 0], [3, 0]],                 // 长条 · 直的四格
    [[0, 0], [0, 1], [0, 2], [1, 2]],                 // 小 L · 三格加一格
    [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]],         // 拐角 · 两边都是三格
  ].map((shape) => normalizeCells(shape));

  const PIECE_TONES = [
    ['#f7d76a', '#f0c33c', '#d9a520'],
    ['#6d93ea', '#3d6fd8', '#2a51b0'],
    ['#e8705f', '#d4513f', '#b23a2a'],
    ['#46bfa2', '#2aa385', '#1c7f66'],
    ['#cb7f45', '#b0602a', '#8c4718'],
    ['#9a6ee0', '#7b45c9', '#5c2ea3'],
    ['#ef6cb2', '#e0479e', '#b92b7b'],
    ['#5fd4e8', '#35bfd8', '#1d97af'],
    ['#f7a45a', '#f08a2e', '#c96a17'],
    ['#47ad8a', '#2e8f6e', '#1e6d52'],
  ];

  function normalizeCells(input) {
    const unique = new Map();
    for (const [x, y] of input) unique.set(`${x},${y}`, [x, y]);
    const pts = [...unique.values()];
    const minX = Math.min(...pts.map((p) => p[0]));
    const minY = Math.min(...pts.map((p) => p[1]));
    return pts
      .map(([x, y]) => [x - minX, y - minY])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }

  function cellsKey(input) {
    return input.map(([x, y]) => `${x},${y}`).sort().join('|');
  }

  function rotateCells(input) {
    return normalizeCells(input.map(([x, y]) => [-y, x]));
  }

  function flipCells(input) {
    return normalizeCells(input.map(([x, y]) => [-x, y]));
  }

  function bboxOf(input) {
    let maxX = 0;
    let maxY = 0;
    for (const [x, y] of input) {
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { w: maxX + 1, h: maxY + 1 };
  }

  function buildTransforms(base) {
    const map = new Map();
    const baseNorm = normalizeCells(base);
    for (let flipped = 0; flipped < 2; flipped += 1) {
      let shape = flipped ? flipCells(baseNorm) : baseNorm;
      for (let rotation = 0; rotation < 4; rotation += 1) {
        const key = cellsKey(shape);
        if (!map.has(key)) map.set(key, normalizeCells(shape));
        shape = rotateCells(shape);
      }
    }
    return [...map.values()];
  }

  const ALL_TRANSFORMS = BASE_PIECES.map(buildTransforms);
  const TRANSFORM_KEYS = ALL_TRANSFORMS.map((list) => new Set(list.map(cellsKey)));

  function freshPieces() {
    return BASE_PIECES.map((shape, id) => ({
      id,
      shape: shape.map((cell) => cell.slice()),
      anchor: null,
    }));
  }

  /* =========================================================
     SVG piece rendering
     ========================================================= */

  const pathCache = new Map();

  function boundaryPoints(shape) {
    const occupied = new Set(shape.map(([x, y]) => `${x},${y}`));
    const edges = new Map();

    const addEdge = (a, b) => {
      const key = a.join(',');
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push(b);
    };

    for (const [x, y] of shape) {
      if (!occupied.has(`${x},${y - 1}`)) addEdge([x, y], [x + 1, y]);
      if (!occupied.has(`${x + 1},${y}`)) addEdge([x + 1, y], [x + 1, y + 1]);
      if (!occupied.has(`${x},${y + 1}`)) addEdge([x + 1, y + 1], [x, y + 1]);
      if (!occupied.has(`${x - 1},${y}`)) addEdge([x, y + 1], [x, y]);
    }

    const starts = [...edges.keys()].sort((a, b) => {
      const [ax, ay] = a.split(',').map(Number);
      const [bx, by] = b.split(',').map(Number);
      return ay - by || ax - bx;
    });
    if (!starts.length) return [];

    const startKey = starts[0];
    const start = startKey.split(',').map(Number);
    let key = startKey;
    let current = start;
    const points = [start];

    for (let guard = 0; guard < 500; guard += 1) {
      const outgoing = edges.get(key);
      if (!outgoing || !outgoing.length) break;
      const next = outgoing.shift();
      points.push(next);
      current = next;
      key = next.join(',');
      if (current[0] === start[0] && current[1] === start[1]) break;
    }

    return points;
  }

  function simplifyLoop(points) {
    const pts = points.slice();
    if (pts.length > 1) {
      const last = pts[pts.length - 1];
      if (last[0] === pts[0][0] && last[1] === pts[0][1]) pts.pop();
    }

    let changed = true;
    while (changed && pts.length > 3) {
      changed = false;
      const next = [];
      const n = pts.length;
      for (let i = 0; i < n; i += 1) {
        const a = pts[(i - 1 + n) % n];
        const b = pts[i];
        const c = pts[(i + 1) % n];
        const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
        if (cross === 0 && dot > 0) {
          changed = true;
          continue;
        }
        next.push(b);
      }
      if (next.length === pts.length) break;
      pts.splice(0, pts.length, ...next);
    }
    return pts;
  }

  function roundedPath(shape, radius = 0.09) {
    const pts = simplifyLoop(boundaryPoints(shape));
    if (pts.length < 3) return '';
    const n = pts.length;
    let d = '';

    for (let i = 0; i < n; i += 1) {
      const prev = pts[(i - 1 + n) % n];
      const vertex = pts[i];
      const next = pts[(i + 1) % n];
      const len1 = Math.hypot(vertex[0] - prev[0], vertex[1] - prev[1]);
      const len2 = Math.hypot(next[0] - vertex[0], next[1] - vertex[1]);
      if (!len1 || !len2) continue;
      const r = Math.min(radius, len1 / 2, len2 / 2);
      const u1 = [(vertex[0] - prev[0]) / len1, (vertex[1] - prev[1]) / len1];
      const u2 = [(next[0] - vertex[0]) / len2, (next[1] - vertex[1]) / len2];
      const p1 = [vertex[0] - u1[0] * r, vertex[1] - u1[1] * r];
      const p2 = [vertex[0] + u2[0] * r, vertex[1] + u2[1] * r];
      d += `${i === 0 ? 'M' : 'L'} ${p1[0].toFixed(3)} ${p1[1].toFixed(3)} `;
      d += `Q ${vertex[0]} ${vertex[1]} ${p2[0].toFixed(3)} ${p2[1].toFixed(3)} `;
    }

    return `${d}Z`;
  }

  function pathForShape(shape) {
    const key = cellsKey(shape);
    if (pathCache.has(key)) return pathCache.get(key);
    const { w, h } = bboxOf(shape);
    const value = { d: roundedPath(shape), w, h };
    pathCache.set(key, value);
    return value;
  }

  let renderSerial = 0;

  function grainPaths(w, h) {
    let paths = '';
    for (let i = 1; i <= 3; i += 1) {
      const y = (h * i) / 4 + 0.06;
      const amp = Math.min(0.11, h * 0.035);
      paths += `<path d="M ${-0.15} ${y.toFixed(3)} C ${(w * 0.24).toFixed(3)} ${(y - amp).toFixed(3)}, ${(w * 0.55).toFixed(3)} ${(y + amp).toFixed(3)}, ${(w + 0.15).toFixed(3)} ${(y - amp * 0.6).toFixed(3)}"></path>`;
    }
    return paths;
  }

  function pieceSVG(pieceId, shape) {
    const { d, w, h } = pathForShape(shape);
    const clipId = `pieceClip${renderSerial += 1}`;
    return `<svg class="piece-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs><clipPath id="${clipId}"><path d="${d}"></path></clipPath></defs>
      <path class="piece-shade" d="${d}"></path>
      <path class="piece-face" d="${d}" fill="url(#pieceGrad-${pieceId})"></path>
      <g class="piece-grain" clip-path="url(#${clipId})" aria-hidden="true">${grainPaths(w, h)}</g>
      <path class="piece-bevel" d="${d}"></path>
    </svg>`;
  }

  function buildPieceDefs() {
    pieceDefs.innerHTML = PIECE_TONES.map((tone, i) => `
      <linearGradient id="pieceGrad-${i}" x1="0" y1="0" x2=".38" y2="1">
        <stop offset="0" stop-color="${tone[0]}"></stop>
        <stop offset=".52" stop-color="${tone[1]}"></stop>
        <stop offset="1" stop-color="${tone[2]}"></stop>
      </linearGradient>
    `).join('');
  }

  /* =========================================================
     Solver data
     ========================================================= */

  const coordIndex = new Map(cells.map((cell) => [cell.coord, cell.index]));
  const solver = {
    placements: [],
    candidates: Array.from({ length: CELL_COUNT }, () => []),
  };

  (function buildSolverData() {
    BASE_PIECES.forEach((base, pieceId) => {
      const list = [];
      const seenMasks = new Set();

      for (const shape of ALL_TRANSFORMS[pieceId]) {
        const { w, h } = bboxOf(shape);
        for (let r = 0; r <= ROWS - h; r += 1) {
          for (let c = 0; c <= COLS - w; c += 1) {
            let mask = 0n;
            let ok = true;
            for (const [x, y] of shape) {
              const idx = coordIndex.get(coordKey(c + x, r + y));
              if (idx === undefined) {
                ok = false;
                break;
              }
              mask |= 1n << BigInt(idx);
            }
            if (!ok) continue;
            const maskKey = mask.toString(36);
            if (seenMasks.has(maskKey)) continue;
            seenMasks.add(maskKey);

            const placement = { pieceId, shape, anchor: { c, r }, mask };
            list.push(placement);
            for (let i = 0; i < CELL_COUNT; i += 1) {
              if (mask & (1n << BigInt(i))) solver.candidates[i].push(placement);
            }
          }
        }
      }
      solver.placements.push(list);
    });
  })();

  function solveRemaining() {
    let fixedMask = 0n;
    let fixedPiecesMask = 0;
    let fixedCount = 0;

    for (const piece of state.pieces) {
      if (!piece.anchor) continue;
      fixedCount += 1;
      fixedPiecesMask |= 1 << piece.id;
      for (const [x, y] of piece.shape) {
        const idx = coordIndex.get(coordKey(piece.anchor.c + x, piece.anchor.r + y));
        if (idx === undefined) return { ok: false, ans: null, nodes: 0 };
        fixedMask |= 1n << BigInt(idx);
      }
    }

    if (fixedMask & state.holeMask) return { ok: false, ans: null, nodes: 0 };
    if (fixedCount === state.pieces.length) {
      return { ok: fixedMask === (ALL_MASK & ~state.holeMask), ans: null, nodes: 0 };
    }

    const fullTarget = ALL_MASK & ~state.holeMask;
    const target = fullTarget & ~fixedMask;
    const answer = new Array(state.pieces.length).fill(null);
    let nodes = 0;

    function recurse(usedPieces, usedMask) {
      nodes += 1;
      if (usedPieces === FULL_PIECE_MASK) return usedMask === fullTarget;

      const uncovered = target & ~usedMask;
      if (uncovered === 0n) return false;

      let bestCell = -1;
      let bestCount = Infinity;
      let remaining = uncovered;

      while (remaining) {
        const bit = remaining & -remaining;
        remaining ^= bit;
        const idx = bitToIndex.get(bit.toString(36));
        if (idx === undefined) continue;

        let count = 0;
        const list = solver.candidates[idx];
        for (let i = 0; i < list.length; i += 1) {
          const placement = list[i];
          if (usedPieces & (1 << placement.pieceId)) continue;
          if (placement.mask & (usedMask | state.holeMask)) continue;
          count += 1;
          if (count >= bestCount) break;
        }

        if (count < bestCount) {
          bestCount = count;
          bestCell = idx;
          if (count === 0) break;
        }
      }

      if (bestCell < 0 || bestCount === 0) return false;

      const list = solver.candidates[bestCell];
      for (let i = 0; i < list.length; i += 1) {
        const placement = list[i];
        if (usedPieces & (1 << placement.pieceId)) continue;
        if (placement.mask & (usedMask | state.holeMask)) continue;

        answer[placement.pieceId] = placement;
        if (recurse(usedPieces | (1 << placement.pieceId), usedMask | placement.mask)) return true;
        answer[placement.pieceId] = null;
      }

      return false;
    }

    const ok = recurse(fixedPiecesMask, fixedMask);
    return { ok, ans: ok ? answer : null, nodes };
  }

  /* =========================================================
     DOM refs
     ========================================================= */

  const boardGrid = document.getElementById('boardGrid');
  const boardFrame = document.getElementById('boardFrame');
  const boardCard = document.querySelector('.board-card');
  const pieceLayer = document.getElementById('pieceLayer');
  const previewLayer = document.getElementById('previewLayer');
  const tray = document.getElementById('tray');
  const placedCountEl = document.getElementById('placedCount');
  const progressText = document.getElementById('progressText');
  const timerText = document.getElementById('timerText');
  const timerPill = document.querySelector('.timer-pill');
  const dateMain = document.getElementById('dateMain');
  const dateYear = document.getElementById('dateYear');
  const dateWeekday = document.getElementById('dateWeekday');
  const todayBadge = document.getElementById('todayBadge');
  const doneBadge = document.getElementById('doneBadge');
  const dateCard = document.getElementById('dateCard');
  const dateNav = document.getElementById('dateNav');
  const datePopover = document.getElementById('datePopover');
  const dateInput = document.getElementById('dateInput');
  const goalRow = document.getElementById('goalRow');
  const helpTargetText = document.getElementById('helpTargetText');
  const selectionLabel = document.getElementById('selectionLabel');
  const rotateBtn = document.getElementById('rotateBtn');
  const flipBtn = document.getElementById('flipBtn');
  const hintBtn = document.getElementById('hintBtn');
  const resetBtn = document.getElementById('resetBtn');
  const helpBtn = document.getElementById('helpBtn');
  const howBtn = document.getElementById('howBtn');
  const soundBtn = document.getElementById('soundBtn');
  const soundOnIcon = document.getElementById('soundOnIcon');
  const soundOffIcon = document.getElementById('soundOffIcon');
  const prevDayBtn = document.getElementById('prevDay');
  const nextDayBtn = document.getElementById('nextDay');
  const todayBtn = document.getElementById('todayBtn');
  const jumpDateBtn = document.getElementById('jumpDateBtn');
  const helpModal = document.getElementById('helpModal');
  const helpClose = document.getElementById('helpClose');
  const helpStart = document.getElementById('helpStart');
  const winModal = document.getElementById('winModal');
  const winDate = document.getElementById('winDate');
  const winTarget = document.getElementById('winTarget');
  const winTime = document.getElementById('winTime');
  const winHints = document.getElementById('winHints');
  const winBest = document.getElementById('winBest');
  const winStreak = document.getElementById('winStreak');
  const playAgainBtn = document.getElementById('playAgainBtn');
  const admireBtn = document.getElementById('admireBtn');
  const toast = document.getElementById('toast');
  const confettiCanvas = document.getElementById('confetti');
  const pieceDefs = document.getElementById('pieceDefs');

  /* =========================================================
     App state
     ========================================================= */

  let currentDate = todayAtNoon();
  let selectedPieceId = null;
  let drag = null;
  let toastTimer = null;
  let timerInterval = null;
  let saveTick = 0;
  let soundOn = readSoundPreference();
  let audioCtx = null;
  let confettiFrame = null;
  let modalOpen = null;

  const state = {
    dateKey: '',
    holes: new Set(),
    holeMask: 0n,
    pieces: freshPieces(),
    elapsedMs: 0,
    runningSince: null,
    completed: false,
    hints: 0,
  };

  /* =========================================================
     Board rendering
     ========================================================= */

  function buildBoard() {
    const html = [];

    for (const cell of cells) {
      const isWeekday = cell.type === 'weekday';
      const label = isWeekday
        ? `<span class="wd-top">星期</span><span class="wd-char">${WEEKDAY_CHARS[cell.value]}</span>`
        : `<span class="num">${cell.value}</span><span class="unit">${cell.type === 'month' ? '月' : '日'}</span>`;
      html.push(`<div class="cell${isWeekday ? ' cell--weekday' : ''}" data-cell="${cell.key}" style="grid-column:${cell.c + 1};grid-row:${cell.r + 1}" role="img" aria-label="${cell.aria}">${label}</div>`);
    }

    html.push(`<div class="motto" aria-hidden="true">坚持就是胜利</div>`);
    html.push(`<div class="corner-mark" aria-hidden="true">
      <svg class="daily-sun" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round">
        <circle cx="20" cy="20" r="5.6"></circle>
        <path d="M20 5.2v4.4M20 30.4v4.4M5.2 20h4.4M30.4 20h4.4M9.6 9.6l3.1 3.1M27.3 27.3l3.1 3.1M30.4 9.6l-3.1 3.1M12.7 27.3l-3.1 3.1"></path>
      </svg>
      <svg class="complete-check" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="20" cy="20" r="12.5" opacity=".32"></circle>
        <path d="m14.4 20.4 3.8 3.8 7.7-8.6"></path>
      </svg>
      <span>留白</span>
    </div>`);

    boardGrid.innerHTML = html.join('');
  }

  function syncCellSize() {
    const rect = boardGrid.getBoundingClientRect();
    if (rect.width > 0) {
      boardGrid.style.setProperty('--cell', `${rect.width / COLS}px`);
    }
  }

  /* =========================================================
     Date + state persistence
     ========================================================= */

  function holesForDate(date) {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekday = date.getDay();
    return {
      keys: new Set([`month-${month}`, `day-${day}`, `weekday-${weekday}`]),
      month,
      day,
      weekday,
    };
  }

  function stateStorageKey(dateKey) {
    return `${STORAGE_PREFIX}${dateKey}`;
  }

  function readSoundPreference() {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off';
    } catch (err) {
      return true;
    }
  }

  function setSoundPreference(value) {
    soundOn = value;
    try {
      localStorage.setItem(SOUND_KEY, value ? 'on' : 'off');
    } catch (err) {
      /* ignore */
    }
    updateSoundUI();
  }

  function updateSoundUI() {
    soundOnIcon.toggleAttribute('hidden', !soundOn);
    soundOffIcon.toggleAttribute('hidden', soundOn);
    soundBtn.setAttribute('aria-label', soundOn ? '关闭音效' : '开启音效');
    soundBtn.title = soundOn ? '关闭音效' : '开启音效';
  }

  function readHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return {};
      const value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : {};
    } catch (err) {
      return {};
    }
  }

  function writeHistory(history) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (err) {
      /* ignore */
    }
  }

  function loadSavedState(dateKey) {
    let data;
    try {
      const raw = localStorage.getItem(stateStorageKey(dateKey));
      if (!raw) return null;
      data = JSON.parse(raw);
    } catch (err) {
      return null;
    }

    if (!data || data.v !== 2 || !Array.isArray(data.shapes) || !Array.isArray(data.anchors)) return null;
    if (data.shapes.length !== BASE_PIECES.length || data.anchors.length !== BASE_PIECES.length) return null;

    const pieces = freshPieces();
    const occupied = new Set();
    const holes = state.holes;

    for (let i = 0; i < pieces.length; i += 1) {
      const shape = data.shapes[i];
      if (!Array.isArray(shape) || !TRANSFORM_KEYS[i].has(cellsKey(shape))) return null;
      pieces[i].shape = normalizeCells(shape.map((cell) => [Number(cell[0]), Number(cell[1])]));

      const anchor = data.anchors[i];
      if (anchor !== null && anchor !== undefined) {
        if (typeof anchor !== 'object' || !Number.isInteger(anchor.c) || !Number.isInteger(anchor.r)) return null;
        if (!canPlaceWith(pieces[i].shape, anchor.c, anchor.r, holes, occupied)) return null;
        for (const [x, y] of pieces[i].shape) {
          occupied.add(coordKey(anchor.c + x, anchor.r + y));
        }
        pieces[i].anchor = { c: anchor.c, r: anchor.r };
      }
    }

    const complete = isCoverageComplete(pieces, holes);
    return {
      pieces,
      elapsedMs: Number.isFinite(data.elapsedMs) ? Math.max(0, data.elapsedMs) : 0,
      completed: Boolean(data.completed) && complete,
      hints: Number.isFinite(data.hints) ? Math.max(0, Math.floor(data.hints)) : 0,
    };
  }

  function saveState() {
    if (!state.dateKey) return;
    const payload = {
      v: 2,
      date: state.dateKey,
      shapes: state.pieces.map((piece) => piece.shape.map((cell) => cell.slice())),
      anchors: state.pieces.map((piece) => (piece.anchor ? { c: piece.anchor.c, r: piece.anchor.r } : null)),
      elapsedMs: Math.round(elapsedNow()),
      completed: state.completed,
      hints: state.hints,
    };
    try {
      localStorage.setItem(stateStorageKey(state.dateKey), JSON.stringify(payload));
    } catch (err) {
      /* ignore quota / privacy mode */
    }
  }

  function loadDate(date, options = {}) {
    if (drag) cancelDrag();
    closeDatePopover();
    if (!winModal.hidden) closeModal(winModal);

    if (state.dateKey) {
      pauseTimer();
      saveState();
    }

    const nextDate = makeDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
    currentDate = nextDate;
    const dateKey = dateKeyOf(nextDate);
    const holeInfo = holesForDate(nextDate);

    state.dateKey = dateKey;
    state.holes = holeInfo.keys;
    state.holeMask = 0n;
    for (const key of holeInfo.keys) {
      const cell = cellByKey.get(key);
      if (cell) state.holeMask |= 1n << BigInt(cell.index);
    }

    const saved = loadSavedState(dateKey);
    if (saved) {
      state.pieces = saved.pieces;
      state.elapsedMs = saved.elapsedMs;
      state.completed = saved.completed;
      state.hints = saved.hints;
    } else {
      state.pieces = freshPieces();
      state.elapsedMs = 0;
      state.completed = false;
      state.hints = 0;
    }
    state.runningSince = null;
    selectedPieceId = null;
    clearPreview();

    updateDateHeader(holeInfo);
    updateTargets();
    renderPieces();
    renderTray();
    updateCounts();
    updateTimerUI();
    updateCompletionUI();
    updateSelectionUI();
    syncCellSize();

    try {
      history.replaceState(null, '', `#${dateKey}`);
    } catch (err) {
      /* ignore */
    }

    if (!options.initial && saved && saved.completed) {
      showToast('这一天已经完成，可以再拼一次');
    }
  }

  function updateDateHeader(holeInfo) {
    const date = currentDate;
    const today = todayAtNoon();
    dateMain.textContent = `${holeInfo.month}月${holeInfo.day}日`;
    dateYear.textContent = String(date.getFullYear());
    dateWeekday.textContent = WEEKDAY_NAMES[holeInfo.weekday];
    todayBadge.hidden = !isSameDay(date, today);
    doneBadge.hidden = !state.completed;
    dateCard.title = `${fullDateText(date)} · 选择日期`;
    dateInput.value = state.dateKey;
    document.title = `每日拼图 · ${holeInfo.month}月${holeInfo.day}日`;

    const chips = goalRow.querySelectorAll('.goal-chip');
    const values = {
      month: `${holeInfo.month}月`,
      day: `${holeInfo.day}日`,
      weekday: WEEKDAY_NAMES[holeInfo.weekday],
    };
    chips.forEach((chip) => {
      const kind = chip.dataset.hole;
      chip.textContent = values[kind] || '';
      chip.classList.toggle('is-done', state.completed);
    });

    helpTargetText.textContent = `${holeInfo.month}月 · ${holeInfo.day}日 · ${WEEKDAY_NAMES[holeInfo.weekday]}`;
    boardGrid.setAttribute('aria-label', `${date.getFullYear()}年${holeInfo.month}月${holeInfo.day}日，${WEEKDAY_NAMES[holeInfo.weekday]}的拼图棋盘`);
  }

  function updateTargets() {
    const targetEls = boardGrid.querySelectorAll('.cell');
    targetEls.forEach((el) => {
      el.classList.toggle('is-target', state.holes.has(el.dataset.cell));
    });
  }

  /* =========================================================
     Placement helpers
     ========================================================= */

  function canPlaceWith(shape, c, r, holes, occupied) {
    for (const [x, y] of shape) {
      const key = coordKey(c + x, r + y);
      if (!cellByCoord.has(key)) return false;
      if (holes.has(cellByCoord.get(key).key)) return false;
      if (occupied.has(key)) return false;
    }
    return true;
  }

  function occupiedCells(excludeId = null) {
    const occupied = new Set();
    for (const piece of state.pieces) {
      if (piece.id === excludeId || !piece.anchor) continue;
      for (const [x, y] of piece.shape) {
        occupied.add(coordKey(piece.anchor.c + x, piece.anchor.r + y));
      }
    }
    return occupied;
  }

  function canPlace(shape, c, r, excludeId = null) {
    return canPlaceWith(shape, c, r, state.holes, occupiedCells(excludeId));
  }

  function isCoverageComplete(pieces, holes) {
    const covered = new Set();
    for (const piece of pieces) {
      if (!piece.anchor) continue;
      for (const [x, y] of piece.shape) {
        const key = coordKey(piece.anchor.c + x, piece.anchor.r + y);
        if (holes.has(cellByCoord.get(key)?.key)) return false;
        covered.add(key);
      }
    }

    for (const cell of cells) {
      if (holes.has(cell.key)) {
        if (covered.has(cell.coord)) return false;
      } else if (!covered.has(cell.coord)) {
        return false;
      }
    }
    return true;
  }

  function checkCompletion() {
    if (state.completed) return true;
    if (!isCoverageComplete(state.pieces, state.holes)) return false;
    completeGame();
    return true;
  }

  /* =========================================================
     UI rendering
     ========================================================= */

  function renderPieces(fx = {}) {
    const html = [];

    for (const piece of state.pieces) {
      if (!piece.anchor) continue;
      const { w, h } = bboxOf(piece.shape);
      const left = (piece.anchor.c / COLS) * 100;
      const top = (piece.anchor.r / ROWS) * 100;
      const width = (w / COLS) * 100;
      const height = (h / ROWS) * 100;
      const classes = ['board-piece'];
      if (selectedPieceId === piece.id) classes.push('is-selected');
      if (fx.justPlacedId === piece.id) classes.push('just-placed');
      if (fx.hintId === piece.id) classes.push('hint-placed');
      html.push(`<div class="${classes.join(' ')}" data-piece="${piece.id}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%" role="button" tabindex="0" aria-label="木片 ${piece.id + 1}，可拖动">
        ${pieceSVG(piece.id, piece.shape)}
      </div>`);
    }

    pieceLayer.innerHTML = html.join('');
  }

  function renderTray() {
    const unit = 15;
    const html = state.pieces.map((piece) => {
      const placed = Boolean(piece.anchor);
      const { w, h } = bboxOf(piece.shape);
      const classes = ['piece-slot'];
      if (placed) classes.push('is-placed');
      if (selectedPieceId === piece.id) classes.push('is-selected');
      return `<button type="button" class="${classes.join(' ')}" data-piece="${piece.id}"${placed ? ' disabled' : ''} aria-label="木片 ${piece.id + 1}，${piece.shape.length} 格${placed ? '，已放入棋盘' : ''}" aria-pressed="${selectedPieceId === piece.id}">
        <span class="slot-num">${String(piece.id + 1).padStart(2, '0')}</span>
        <span class="slot-piece" style="width:${w * unit}px;height:${h * unit}px">${pieceSVG(piece.id, piece.shape)}</span>
        <span class="slot-check">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.2 10.4 3.6 3.6 8-8.4"></path></svg>
          <span>已入盘</span>
        </span>
      </button>`;
    }).join('');

    tray.innerHTML = html;
  }

  function updateCounts() {
    const placed = state.pieces.filter((piece) => piece.anchor).length;
    placedCountEl.textContent = String(placed);
    progressText.textContent = `已放置 ${placed} / ${state.pieces.length}`;
  }

  function updateSelectionUI() {
    const piece = selectedPieceId === null ? null : state.pieces[selectedPieceId];
    rotateBtn.disabled = !piece || state.completed;
    flipBtn.disabled = !piece || state.completed;
    if (!piece) {
      selectionLabel.textContent = '点选一块木片';
    } else {
      selectionLabel.innerHTML = `<strong>木片 ${piece.id + 1}</strong> · ${piece.shape.length} 格${piece.anchor ? ' · 已入盘' : ' · 点棋盘格子放置'}`;
    }

    tray.querySelectorAll('.piece-slot').forEach((slot) => {
      slot.classList.toggle('is-selected', Number(slot.dataset.piece) === selectedPieceId);
      slot.setAttribute('aria-pressed', String(Number(slot.dataset.piece) === selectedPieceId));
    });
    pieceLayer.querySelectorAll('.board-piece').forEach((el) => {
      el.classList.toggle('is-selected', Number(el.dataset.piece) === selectedPieceId);
    });
  }

  function updateTimerUI() {
    timerText.textContent = formatDuration(elapsedNow());
    timerPill.classList.toggle('is-running', Boolean(state.runningSince) && !state.completed);
  }

  function updateCompletionUI() {
    boardCard.classList.toggle('is-complete', state.completed);
    doneBadge.hidden = !state.completed;
    goalRow.querySelectorAll('.goal-chip').forEach((chip) => {
      chip.classList.toggle('is-done', state.completed);
    });
  }

  /* =========================================================
     Timer
     ========================================================= */

  function elapsedNow() {
    return state.elapsedMs + (state.runningSince ? Date.now() - state.runningSince : 0);
  }

  function startTimer() {
    if (state.completed || state.runningSince) return;
    state.runningSince = Date.now();
    updateTimerUI();
  }

  function pauseTimer() {
    if (state.runningSince) {
      state.elapsedMs += Date.now() - state.runningSince;
      state.runningSince = null;
    }
    updateTimerUI();
  }

  function tickTimer() {
    updateTimerUI();
    saveTick += 1;
    if (saveTick >= 20 && state.runningSince) {
      saveTick = 0;
      saveState();
    }
  }

  /* =========================================================
     Sound
     ========================================================= */

  function ensureAudio() {
    if (!soundOn) return null;
    try {
      if (!audioCtx) {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) return null;
        audioCtx = new AudioCtor();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (err) {
      return null;
    }
  }

  function tone(freq, duration, type = 'sine', volume = 0.03, delay = 0, slideTo = null) {
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
      const start = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    } catch (err) {
      /* ignore */
    }
  }

  function playSound(kind) {
    if (!soundOn) return;
    switch (kind) {
      case 'snap':
        tone(245, 0.055, 'triangle', 0.035, 0, 175);
        tone(540, 0.035, 'sine', 0.014, 0.012);
        break;
      case 'rotate':
        tone(370, 0.045, 'sine', 0.022, 0, 430);
        break;
      case 'invalid':
        tone(125, 0.11, 'sawtooth', 0.017, 0, 92);
        break;
      case 'hint':
        tone(520, 0.07, 'sine', 0.022, 0);
        tone(780, 0.09, 'sine', 0.018, 0.055);
        break;
      case 'win':
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
          tone(freq, 0.34, 'sine', 0.028, i * 0.105);
          tone(freq / 2, 0.34, 'triangle', 0.008, i * 0.105);
        });
        break;
      case 'click':
        tone(420, 0.03, 'sine', 0.012);
        break;
      default:
        break;
    }
  }

  /* =========================================================
     Toast, modals, confetti
     ========================================================= */

  function showToast(message, options = {}) {
    const { error = false, duration = 2400 } = options;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('is-error', error);
    toast.classList.add('is-visible');
    toastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, duration);
  }

  function openModal(el, focusTarget) {
    if (!el) return;
    clearTimeout(toastTimer);
    toast.classList.remove('is-visible');
    modalOpen = el;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      el.classList.add('is-open');
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus({ preventScroll: true });
    });
  }

  function closeModal(el) {
    if (!el || el.hidden) return;
    el.classList.remove('is-open');
    const finish = () => {
      el.hidden = true;
      if (modalOpen === el) modalOpen = null;
      if (!document.querySelector('.modal-backdrop.is-open')) document.body.style.overflow = '';
    };
    setTimeout(finish, 220);
  }

  function openHelp() {
    helpTargetText.textContent = `${currentDate.getMonth() + 1}月 · ${currentDate.getDate()}日 · ${WEEKDAY_NAMES[currentDate.getDay()]}`;
    openModal(helpModal, helpClose);
    playSound('click');
  }

  function launchConfetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (confettiFrame) cancelAnimationFrame(confettiFrame);

    const canvas = confettiCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colors = ['#d7a64d', '#ecd09a', '#55705a', '#b26f4c', '#f5ead7', '#c68f3c'];
    const parts = [];
    const startX = width * 0.5;
    const startY = height * 0.48;

    for (let i = 0; i < 110; i += 1) {
      const angle = (Math.PI * 2 * i) / 110 + (Math.random() - 0.5) * 0.5;
      const speed = 4 + Math.random() * 8;
      parts.push({
        x: startX + (Math.random() - 0.5) * 80,
        y: startY + (Math.random() - 0.5) * 30,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3,
        w: 4 + Math.random() * 6,
        h: 6 + Math.random() * 10,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.25,
        color: colors[i % colors.length],
        life: 0,
      });
    }

    const started = performance.now();

    function draw(now) {
      const elapsed = now - started;
      ctx.clearRect(0, 0, width, height);
      for (const p of parts) {
        p.life += 1;
        p.vy += 0.16;
        p.vx *= 0.992;
        p.vy *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        const alpha = clamp(1 - Math.max(0, elapsed - 1700) / 1600, 0, 1);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (elapsed < 3400) {
        confettiFrame = requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, width, height);
        confettiFrame = null;
      }
    }

    confettiFrame = requestAnimationFrame(draw);
  }

  /* =========================================================
     Completion
     ========================================================= */

  function completeGame() {
    if (state.completed) return;
    pauseTimer();
    state.completed = true;
    state.elapsedMs = Math.max(0, Math.round(state.elapsedMs));
    saveState();

    const history = readHistory();
    const previous = history[state.dateKey];
    const finalMs = Math.max(1, Math.round(state.elapsedMs));
    const bestMs = previous && Number.isFinite(previous.bestMs) ? Math.min(previous.bestMs, finalMs) : finalMs;
    const newRecord = !previous || !Number.isFinite(previous.bestMs) || finalMs < previous.bestMs;

    history[state.dateKey] = {
      bestMs,
      completedAt: new Date().toISOString(),
      hints: state.hints,
    };
    writeHistory(history);

    clearTimeout(toastTimer);
    toast.classList.remove('is-visible');
    updateDateHeader(holesForDate(currentDate));
    updateCompletionUI();
    updateCounts();
    updateTimerUI();
    playSound('win');
    launchConfetti();

    winDate.textContent = fullDateText(currentDate);
    winTarget.textContent = `你留下了 ${currentDate.getMonth() + 1}月 · ${currentDate.getDate()}日 · ${WEEKDAY_NAMES[currentDate.getDay()]}`;
    winTime.textContent = formatDuration(Math.max(1000, finalMs));
    winHints.textContent = `${state.hints} 次`;
    winBest.textContent = formatDuration(Math.max(1000, bestMs));
    winBest.style.color = newRecord ? '#8f5c15' : '';
    winBest.title = newRecord ? '新纪录' : '';

    const streak = currentStreak(currentDate);
    winStreak.hidden = streak < 2;
    winStreak.textContent = streak >= 2 ? `已连续完成 ${streak} 天` : '';

    const keyAtWin = state.dateKey;
    setTimeout(() => {
      if (state.dateKey === keyAtWin && state.completed) openModal(winModal, playAgainBtn);
    }, 620);
  }

  function currentStreak(fromDate) {
    const history = readHistory();
    let streak = 0;
    let cursor = makeDate(fromDate.getFullYear(), fromDate.getMonth() + 1, fromDate.getDate());
    while (history[dateKeyOf(cursor)]) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  /* =========================================================
     Hint + reset
     ========================================================= */

  function handleHint() {
    if (state.completed) {
      showToast('今天已经拼好啦');
      return;
    }

    startTimer();
    const solution = solveRemaining();
    if (!solution.ok || !solution.ans) {
      playSound('invalid');
      showToast('现在的摆法无解，先移动几块或重置试试', { error: true });
      return;
    }

    const missing = state.pieces.find((piece) => !piece.anchor && solution.ans[piece.id]);
    if (!missing) {
      showToast('木片已经全部放好，检查一下留白的格子');
      return;
    }

    const placement = solution.ans[missing.id];
    state.hints += 1;
    commitPlacement(missing.id, placement.shape, placement.anchor, { hint: true });
    playSound('hint');
    const left = state.pieces.filter((piece) => !piece.anchor).length;
    if (!state.completed) {
      showToast(left > 0 ? `已放好一块 · 还差 ${left} 块` : '木片都放好啦');
    }
  }

  function resetPuzzle(options = {}) {
    if (drag) cancelDrag();
    closeModal(winModal);
    pauseTimer();
    state.pieces = freshPieces();
    state.elapsedMs = 0;
    state.runningSince = null;
    state.completed = false;
    state.hints = 0;
    selectedPieceId = null;
    saveTick = 0;
    saveState();
    updateDateHeader(holesForDate(currentDate));
    updateCompletionUI();
    updateTargets();
    renderPieces();
    renderTray();
    updateCounts();
    updateSelectionUI();
    updateTimerUI();
    if (!options.silent) showToast('棋盘已清空，重新开始');
  }

  function commitPlacement(pieceId, shape, anchor, options = {}) {
    const piece = state.pieces[pieceId];
    if (!piece) return;
    piece.shape = normalizeCells(shape.map((cell) => [cell[0], cell[1]]));
    piece.anchor = { c: anchor.c, r: anchor.r };
    selectedPieceId = pieceId;
    renderPieces({
      justPlacedId: options.hint ? null : pieceId,
      hintId: options.hint ? pieceId : null,
    });
    renderTray();
    updateCounts();
    updateSelectionUI();
    saveState();
    checkCompletion();
  }

  /* =========================================================
     Rotation / flip
     ========================================================= */

  function tryTransformSelected(transformFn) {
    if (state.completed) {
      showToast('今日已完成，重置后可以再玩一次');
      return;
    }
    if (drag && drag.active) {
      transformDrag(transformFn);
      return;
    }
    if (selectedPieceId === null) return;

    const piece = state.pieces[selectedPieceId];
    if (!piece) return;

    startTimer();

    if (!piece.anchor) {
      piece.shape = transformFn(piece.shape);
      renderTray();
      updateSelectionUI();
      saveState();
      playSound('rotate');
      return;
    }

    const oldShape = piece.shape;
    const oldAnchor = { ...piece.anchor };
    const oldBox = bboxOf(oldShape);
    const newShape = transformFn(oldShape);
    const newBox = bboxOf(newShape);
    const centerX = oldAnchor.c + oldBox.w / 2;
    const centerY = oldAnchor.r + oldBox.h / 2;
    const baseC = Math.round(centerX - newBox.w / 2);
    const baseR = Math.round(centerY - newBox.h / 2);
    const offsets = [
      [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0],
      [-1, -1], [1, -1], [-1, 1], [1, 1],
      [-2, 0], [2, 0], [0, -2], [0, 2],
    ];

    for (const [dc, dr] of offsets) {
      const c = baseC + dc;
      const r = baseR + dr;
      if (canPlace(newShape, c, r, piece.id)) {
        piece.shape = newShape;
        piece.anchor = { c, r };
        renderPieces({ justPlacedId: piece.id });
        renderTray();
        updateSelectionUI();
        saveState();
        playSound('rotate');
        checkCompletion();
        return;
      }
    }

    playSound('invalid');
    showToast('这里转不开，先把木片挪一挪');
  }

  function rotateSelected() {
    tryTransformSelected(rotateCells);
  }

  function flipSelected() {
    tryTransformSelected(flipCells);
  }

  /* =========================================================
     Nudge a placed piece with the arrow keys
     ========================================================= */

  function moveSelectedBy(dc, dr) {
    if (drag || modalOpen || selectedPieceId === null || state.completed) return false;
    const piece = state.pieces[selectedPieceId];
    if (!piece || !piece.anchor) return false;

    const c = piece.anchor.c + dc;
    const r = piece.anchor.r + dr;
    if (!canPlace(piece.shape, c, r, piece.id)) return false;

    piece.anchor = { c, r };
    startTimer();

    const el = pieceLayer.querySelector(`.board-piece[data-piece="${piece.id}"]`);
    if (el) {
      el.style.left = `${(c / COLS) * 100}%`;
      el.style.top = `${(r / ROWS) * 100}%`;
    } else {
      renderPieces();
    }
    updateSelectionUI();
    saveState();
    playSound('click');
    return true;
  }

  /**
   * 触屏放置：先点木片盒里的木片，再点棋盘格子。
   * 以点击格为中心，就近找一个能放下的锚点。
   */
  function placeSelectedAtCell(cellKey) {
    if (modalOpen || state.completed || selectedPieceId === null) return false;
    const cell = cellByKey.get(cellKey);
    const piece = state.pieces[selectedPieceId];
    if (!cell || !piece || piece.anchor) return false;

    const { w, h } = bboxOf(piece.shape);
    const baseC = Math.round(cell.c - (w - 1) / 2);
    const baseR = Math.round(cell.r - (h - 1) / 2);
    const offsets = [];
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) offsets.push([dc, dr]);
    }
    offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));

    for (const [dc, dr] of offsets) {
      const c = clamp(baseC + dc, 0, COLS - w);
      const r = clamp(baseR + dr, 0, ROWS - h);
      if (!canPlace(piece.shape, c, r, piece.id)) continue;
      startTimer();
      commitPlacement(piece.id, piece.shape, { c, r });
      playSound('snap');
      return true;
    }

    playSound('invalid');
    showToast('这个位置放不下，换个格子试试', { error: true });
    return false;
  }

  /* =========================================================
     Drag interaction
     ========================================================= */

  function boardMetrics() {
    const rect = boardGrid.getBoundingClientRect();
    return {
      rect,
      cw: rect.width / COLS,
      ch: rect.height / ROWS,
    };
  }

  function clearPreview() {
    previewLayer.innerHTML = '';
    boardFrame.classList.remove('can-drop', 'drop-bad');
  }

  function pointerDown(e, pieceId, source, sourceEl) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (state.completed) {
      showToast('今日已完成，点「重新开始」可以再拼一次');
      return;
    }
    if (drag) return;

    startTimer();
    selectedPieceId = pieceId;
    updateSelectionUI();

    drag = {
      pieceId,
      source,
      sourceEl,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      active: false,
      shape: state.pieces[pieceId].shape.map((cell) => cell.slice()),
      ghost: null,
      offsetX: 0,
      offsetY: 0,
      anchor: null,
      valid: false,
      overBoard: false,
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onWindowBlur);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;

    if (!drag.active) {
      const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (dist < 5) return;
      activateDrag(e);
    }

    if (drag.active) {
      if (e.cancelable) e.preventDefault();
      positionGhost(e.clientX, e.clientY);
    }
  }

  function activateDrag(e) {
    const metrics = boardMetrics();
    if (!metrics.cw || !metrics.ch) return;

    drag.active = true;
    drag.shape = state.pieces[drag.pieceId].shape.map((cell) => cell.slice());
    drag.sourceEl.classList.add('is-dragging-source');
    document.body.classList.add('is-dragging');

    const { w, h } = bboxOf(drag.shape);
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.width = `${w * metrics.cw}px`;
    ghost.style.height = `${h * metrics.ch}px`;
    ghost.innerHTML = pieceSVG(drag.pieceId, drag.shape);
    document.body.appendChild(ghost);
    drag.ghost = ghost;

    if (drag.source === 'board') {
      const rect = drag.sourceEl.getBoundingClientRect();
      drag.offsetX = clamp(e.clientX - rect.left, 0, rect.width);
      drag.offsetY = clamp(e.clientY - rect.top, 0, rect.height);
    } else {
      drag.offsetX = (w * metrics.cw) / 2;
      drag.offsetY = (h * metrics.ch) / 2;
    }

    positionGhost(e.clientX, e.clientY);
  }

  function positionGhost(clientX, clientY) {
    if (!drag || !drag.ghost) return;
    const left = clientX - drag.offsetX;
    const top = clientY - drag.offsetY;
    drag.ghost.style.left = `${left}px`;
    drag.ghost.style.top = `${top}px`;
    updateDropPreview(left, top, clientX, clientY);
  }

  function updateDropPreview(left, top, clientX, clientY) {
    if (!drag) return;
    const { rect, cw, ch } = boardMetrics();
    const nearBoard = clientX >= rect.left - cw * 0.8
      && clientX <= rect.right + cw * 0.8
      && clientY >= rect.top - ch * 0.8
      && clientY <= rect.bottom + ch * 0.8;

    if (!nearBoard) {
      drag.overBoard = false;
      drag.valid = false;
      drag.anchor = null;
      clearPreview();
      return;
    }

    const { w, h } = bboxOf(drag.shape);
    let c = Math.round((left - rect.left) / cw);
    let r = Math.round((top - rect.top) / ch);
    c = clamp(c, 0, COLS - w);
    r = clamp(r, 0, ROWS - h);

    const valid = canPlace(drag.shape, c, r, drag.pieceId);
    drag.overBoard = true;
    drag.valid = valid;
    drag.anchor = { c, r };

    const parts = [];
    for (const [x, y] of drag.shape) {
      const cc = c + x;
      const rr = r + y;
      if (!cellByCoord.has(coordKey(cc, rr))) continue;
      parts.push(`<div class="preview-cell${valid ? '' : ' is-bad'}" style="left:${(cc / COLS) * 100}%;top:${(rr / ROWS) * 100}%;width:${100 / COLS}%;height:${100 / ROWS}%"></div>`);
    }
    previewLayer.innerHTML = parts.join('');
    boardFrame.classList.toggle('can-drop', valid);
    boardFrame.classList.toggle('drop-bad', !valid);
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasActive = drag.active;
    const dragData = drag;
    removeDragListeners();

    if (!wasActive) {
      drag = null;
      return;
    }

    if (dragData.overBoard && dragData.valid && dragData.anchor) {
      const pieceId = dragData.pieceId;
      const shape = dragData.shape;
      const anchor = dragData.anchor;
      cleanupDragVisuals();
      drag = null;
      commitPlacement(pieceId, shape, anchor, { hint: false });
      playSound('snap');
      return;
    }

    const { rect, cw, ch } = boardMetrics();
    const outside = dragData.lastX < rect.left - cw * 0.9
      || dragData.lastX > rect.right + cw * 0.9
      || dragData.lastY < rect.top - ch * 0.9
      || dragData.lastY > rect.bottom + ch * 0.9;

    if (dragData.source === 'board' && outside) {
      state.pieces[dragData.pieceId].anchor = null;
      cleanupDragVisuals();
      drag = null;
      renderPieces();
      renderTray();
      updateCounts();
      updateSelectionUI();
      saveState();
      playSound('click');
      showToast('木片已收回木片盒');
      return;
    }

    const droppedOnBoard = dragData.overBoard;
    cleanupDragVisuals();
    drag = null;
    renderPieces();
    renderTray();
    updateSelectionUI();
    if (droppedOnBoard) {
      playSound('invalid');
      showToast('这个位置放不下', { error: true });
    }
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    cancelDrag();
  }

  function onWindowBlur() {
    if (drag && drag.active) cancelDrag();
  }

  function cancelDrag() {
    if (!drag) return;
    removeDragListeners();
    cleanupDragVisuals();
    drag = null;
    renderPieces();
    renderTray();
    updateSelectionUI();
  }

  function removeDragListeners() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('blur', onWindowBlur);
  }

  function cleanupDragVisuals() {
    if (drag) {
      if (drag.ghost) drag.ghost.remove();
      if (drag.sourceEl) drag.sourceEl.classList.remove('is-dragging-source');
    }
    document.body.classList.remove('is-dragging');
    clearPreview();
  }

  function transformDrag(transformFn) {
    if (!drag) return;
    drag.shape = transformFn(drag.shape);
    const metrics = boardMetrics();
    const { w, h } = bboxOf(drag.shape);
    if (drag.ghost) {
      drag.ghost.style.width = `${w * metrics.cw}px`;
      drag.ghost.style.height = `${h * metrics.ch}px`;
      drag.ghost.innerHTML = pieceSVG(drag.pieceId, drag.shape);
      drag.offsetX = (w * metrics.cw) / 2;
      drag.offsetY = (h * metrics.ch) / 2;
      positionGhost(drag.lastX, drag.lastY);
    }
    playSound('rotate');
  }

  /* =========================================================
     Date navigation / popover
     ========================================================= */

  function toggleDatePopover() {
    const open = datePopover.hidden;
    if (open) {
      dateInput.value = state.dateKey;
      datePopover.hidden = false;
      dateCard.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => dateInput.focus({ preventScroll: true }));
    } else {
      closeDatePopover();
    }
  }

  function closeDatePopover() {
    datePopover.hidden = true;
    dateCard.setAttribute('aria-expanded', 'false');
  }

  function applyDateInput() {
    if (!dateInput.value) {
      showToast('请选择一个日期');
      return;
    }
    const parts = dateInput.value.split('-').map(Number);
    if (parts.length !== 3) return;
    const date = makeDate(parts[0], parts[1], parts[2]);
    if (date.getFullYear() !== parts[0] || date.getMonth() + 1 !== parts[1] || date.getDate() !== parts[2]) {
      showToast('这个日期不太对');
      return;
    }
    closeDatePopover();
    loadDate(date);
    playSound('click');
  }

  /* =========================================================
     Event wiring
     ========================================================= */

  function bindEvents() {
    boardGrid.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.board-piece')) return;
      const cellEl = e.target.closest('.cell[data-cell]');
      const piece = selectedPieceId === null ? null : state.pieces[selectedPieceId];
      // 选中木片盒里的木片后，点棋盘格子直接放置（手机上没有跨屏拖拽）。
      if (cellEl && piece && !piece.anchor && !state.completed) {
        if (placeSelectedAtCell(cellEl.dataset.cell)) return;
      }
      if (selectedPieceId !== null) {
        selectedPieceId = null;
        updateSelectionUI();
      }
    });

    pieceLayer.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('.board-piece');
      if (!el) return;
      pointerDown(e, Number(el.dataset.piece), 'board', el);
    });

    pieceLayer.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.board-piece');
      if (!el || state.completed) return;
      const id = Number(el.dataset.piece);
      selectedPieceId = id;
      updateSelectionUI();
      rotateSelected();
    });

    pieceLayer.addEventListener('keydown', (e) => {
      const el = e.target.closest('.board-piece');
      if (!el) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectedPieceId = Number(el.dataset.piece);
        updateSelectionUI();
      }
    });

    tray.addEventListener('pointerdown', (e) => {
      const slot = e.target.closest('.piece-slot');
      if (!slot || slot.disabled) return;
      pointerDown(e, Number(slot.dataset.piece), 'tray', slot);
    });

    tray.addEventListener('dblclick', (e) => {
      const slot = e.target.closest('.piece-slot');
      if (!slot || slot.disabled || state.completed) return;
      selectedPieceId = Number(slot.dataset.piece);
      updateSelectionUI();
      rotateSelected();
    });

    rotateBtn.addEventListener('click', rotateSelected);
    flipBtn.addEventListener('click', flipSelected);
    hintBtn.addEventListener('click', handleHint);
    resetBtn.addEventListener('click', () => {
      resetPuzzle();
      playSound('click');
    });
    helpBtn.addEventListener('click', openHelp);
    howBtn.addEventListener('click', openHelp);

    soundBtn.addEventListener('click', () => {
      setSoundPreference(!soundOn);
      if (soundOn) playSound('click');
    });

    prevDayBtn.addEventListener('click', () => {
      loadDate(addDays(currentDate, -1));
      playSound('click');
    });
    nextDayBtn.addEventListener('click', () => {
      loadDate(addDays(currentDate, 1));
      playSound('click');
    });
    dateCard.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDatePopover();
    });
    todayBtn.addEventListener('click', () => {
      closeDatePopover();
      loadDate(todayAtNoon());
      playSound('click');
    });
    jumpDateBtn.addEventListener('click', applyDateInput);
    dateInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyDateInput();
      }
    });

    document.addEventListener('pointerdown', (e) => {
      if (!datePopover.hidden && !e.target.closest('.date-nav')) closeDatePopover();
    });

    helpClose.addEventListener('click', () => closeModal(helpModal));
    helpStart.addEventListener('click', () => closeModal(helpModal));
    helpModal.addEventListener('click', (e) => {
      if (e.target === helpModal) closeModal(helpModal);
    });
    winModal.addEventListener('click', (e) => {
      if (e.target === winModal) closeModal(winModal);
    });
    playAgainBtn.addEventListener('click', () => {
      closeModal(winModal);
      setTimeout(() => resetPuzzle({ silent: true }), 220);
    });
    admireBtn.addEventListener('click', () => closeModal(winModal));

    window.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      if (document.body.classList.contains('drama-open')) return;

      if (e.key === 'Escape') {
        if (drag) {
          cancelDrag();
          return;
        }
        if (modalOpen) {
          closeModal(modalOpen);
          return;
        }
        if (!datePopover.hidden) closeDatePopover();
        return;
      }

      const arrowSteps = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      const step = arrowSteps[e.key];
      if (step) {
        const focusedPiece = e.target && e.target.closest ? e.target.closest('.board-piece') : null;
        if (focusedPiece) {
          const id = Number(focusedPiece.dataset.piece);
          if (selectedPieceId !== id) {
            selectedPieceId = id;
            updateSelectionUI();
          }
        }
        if (!drag && !modalOpen && selectedPieceId !== null) {
          const piece = state.pieces[selectedPieceId];
          if (piece && piece.anchor) {
            e.preventDefault();
            moveSelectedBy(step[0], step[1]);
          }
        }
        return;
      }

      if (e.key === 'r' || e.key === 'R') {
        if (drag || selectedPieceId !== null) {
          e.preventDefault();
          rotateSelected();
        }
      } else if (e.key === 'f' || e.key === 'F') {
        if (drag || selectedPieceId !== null) {
          e.preventDefault();
          flipSelected();
        }
      }
    });

    window.addEventListener('pagehide', () => {
      pauseTimer();
      saveState();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) saveState();
    });

    window.addEventListener('resize', syncCellSize);
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(syncCellSize);
      ro.observe(boardGrid);
    }

    window.addEventListener('hashchange', () => {
      const date = parseHashDate();
      if (date && dateKeyOf(date) !== state.dateKey) loadDate(date);
    });
  }

  /* =========================================================
     Init
     ========================================================= */

  function init() {
    buildPieceDefs();
    buildBoard();
    updateSoundUI();
    bindEvents();

    const initialDate = parseHashDate() || todayAtNoon();
    loadDate(initialDate, { initial: true });
    syncCellSize();
    updateTimerUI();

    timerInterval = window.setInterval(tickTimer, 500);

    let introSeen = false;
    try {
      introSeen = Boolean(sessionStorage.getItem(INTRO_KEY));
    } catch (err) {
      /* ignore */
    }

    if (!state.completed && !introSeen) {
      try {
        sessionStorage.setItem(INTRO_KEY, '1');
      } catch (err) {
        /* ignore */
      }
      setTimeout(() => {
        if (!state.completed && !drag) {
          const coarse = window.matchMedia('(pointer: coarse)').matches;
          const message = coarse
            ? '点木片，再点棋盘格子放置'
            : `拖动木片，只留下 ${currentDate.getMonth() + 1}月 · ${currentDate.getDate()}日 · ${WEEKDAY_NAMES[currentDate.getDay()]}`;
          showToast(message, { duration: 3400 });
        }
      }, 900);
    }
  }

  init();
})();
