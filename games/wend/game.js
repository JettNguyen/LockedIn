// games/wend/game.js
//
// LinkedIn Wend DOM (current):
//   GRID:  [data-testid="interactive-grid"][data-trail-grid]
//          direct-child divs with data-testid="cell-N", data-cell-idx="N"
//          hole cells: data-cell-is-hole="true"
//          letter cells: single A-Z char in a descendant element
//
//   WORD COLOR: no data attribute; may be accessible via getComputedStyle
//          on the inner wrapper div (depends on LinkedIn's CSS). Treated as
//          optional — if unavailable, we fall back to the path solver below.
//
//   WORD LIST: [data-testid="wend-word-list-row-N"]
//          slot count  = [data-testid*="-slot-"] children  → word length
//          locked state: data-locked="true" when the word is solved
//
// PRIMARY STRATEGY: group cells by computed background-color.
// FALLBACK STRATEGY: backtracking path solver using word lengths when
//   computed colors are unavailable or produce the wrong group sizes.

(function () {
  // ─── DOM helpers ─────────────────────────────────────────────────────────

  function findGrid() {
    const g = document.querySelector('[data-testid="interactive-grid"][data-trail-grid]');
    if (g) return g;
    const any = document.querySelector('[data-testid="interactive-grid"]');
    if (any && document.querySelector('[data-testid^="wend-word-list-row-"]')) return any;
    return null;
  }

  function isHoleCell(el) {
    return el.dataset.cellIsHole === 'true';
  }

  function getLetter(el) {
    for (const child of el.querySelectorAll('*')) {
      const t = child.textContent.trim();
      if (/^[A-Za-z]$/.test(t)) return t.toUpperCase();
    }
    return null;
  }

  function getWordPosition(el) {
    for (const prop of el.style) {
      if (!prop.startsWith('--')) continue;
      const v = el.style.getPropertyValue(prop).trim();
      if (/^\d+$/.test(v)) return parseInt(v, 10);
    }
    return 0;
  }

  function isStartCell(el, idx) {
    return !!el.querySelector(`[data-testid="cell-${idx}-start-indicator"]`);
  }

  // ─── Color detection (best-effort) ───────────────────────────────────────

  const TRANSPARENT = 'rgba(0, 0, 0, 0)';

  function colorVal(cs, prop) {
    const v = cs[prop];
    return (v && v !== TRANSPARENT && v !== 'transparent' && v !== 'none') ? v : null;
  }

  function extractBg(el, pseudo) {
    if (!el) return null;
    const cs = window.getComputedStyle(el, pseudo || null);
    return colorVal(cs, 'backgroundColor') || colorVal(cs, 'backgroundImage') || null;
  }

  // Scan all CSS custom properties on el and return those whose value looks like
  // a colour (hex, rgb, hsl). Returns a Map of propName → value.
  function colorCustomProps(el) {
    if (!el) return new Map();
    const cs = window.getComputedStyle(el);
    const out = new Map();
    for (const prop of cs) {
      if (!prop.startsWith('--')) continue;
      const v = cs.getPropertyValue(prop).trim();
      if (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/.test(v) || /^hsl/.test(v)) {
        out.set(prop, v);
      }
    }
    return out;
  }

  // Given all letter cells, find a CSS custom property (on the cell or its
  // first child) whose value groups cells into sets matching expectedLengths.
  // Returns { propName, elType } or null.
  function findWordColorProp(cells, expectedLengths) {
    if (cells.length < 2) return null;
    const sorted = [...expectedLengths].sort((a, b) => a - b);

    for (const elType of ['self', 'inner']) {
      const getEl = (cell) => elType === 'self' ? cell.el : cell.el.firstElementChild;

      // Collect all candidate color custom props from the first few cells.
      const propSet = new Set();
      for (const cell of cells.slice(0, 3)) {
        for (const p of colorCustomProps(getEl(cell)).keys()) propSet.add(p);
      }

      for (const prop of propSet) {
        const groups = new Map();
        for (const cell of cells) {
          const el = getEl(cell);
          if (!el) continue;
          const v = window.getComputedStyle(el).getPropertyValue(prop).trim();
          if (!groups.has(v)) groups.set(v, []);
          groups.get(v).push(cell);
        }
        const lens = [...groups.values()].map((g) => g.length).sort((a, b) => a - b);
        if (JSON.stringify(lens) === JSON.stringify(sorted)) {
          return { prop, elType };
        }
      }
    }
    return null;
  }

  function getCellColorKey(cellEl) {
    // Old DOM: explicit data attribute.
    if (cellEl.dataset.cellWordColor) return cellEl.dataset.cellWordColor.toLowerCase();
    // Old DOM: inline style with a hex CSS custom property.
    for (const p of cellEl.style) {
      if (!p.startsWith('--')) continue;
      const v = cellEl.style.getPropertyValue(p).trim();
      if (/^#[0-9a-f]{3,8}$/i.test(v)) return v.toUpperCase();
    }
    // New DOM: try background-color / background-image on inner div, cell,
    // and their ::before pseudo-elements.
    return (
      extractBg(cellEl.firstElementChild) ||
      extractBg(cellEl) ||
      extractBg(cellEl.firstElementChild, '::before') ||
      extractBg(cellEl, '::before') ||
      extractBg(cellEl.firstElementChild, '::after') ||
      extractBg(cellEl, '::after') ||
      null
    );
  }

  // ─── Path utilities ───────────────────────────────────────────────────────

  function hasDistinctPositions(group) {
    const pos = group.map((c) => c.position).filter((p) => p > 0);
    return pos.length === group.length && new Set(pos).size === group.length;
  }

  // Walk the unique orthogonal chain through cells in the same group.
  // sameGroup(a, b) defaults to comparing colorKey; Strategy 1b passes a custom predicate.
  function followPath(startCell, cellsByIdx, n, sameGroup) {
    const same = sameGroup || ((a, b) => a.colorKey === b.colorKey);
    const path = [startCell];
    const visited = new Set([startCell.idx]);
    const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    let cur = startCell;
    while (true) {
      const r = Math.floor(cur.idx / n), c = cur.idx % n;
      let next = null;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
        const ni = nr * n + nc;
        if (visited.has(ni)) continue;
        const nb = cellsByIdx.get(ni);
        if (!nb || !same(nb, cur)) continue;
        next = nb;
        break;
      }
      if (!next) break;
      visited.add(next.idx);
      path.push(next);
    }
    return path;
  }

  // ─── Word-list utilities ──────────────────────────────────────────────────

  // Returns [6, 7, 9, ...] — slot count per word-list row.
  function getExpectedWordLengths() {
    const rows = document.querySelectorAll('[data-testid^="wend-word-list-row-"]');
    return Array.from(rows)
      .map((row) => row.querySelectorAll('[data-testid*="-slot-"]').length)
      .filter((n) => n > 0);
  }

  // Map word length → available row elements (multiple words may share a length).
  function buildWordListRowsByLength() {
    const rows = document.querySelectorAll('[data-testid^="wend-word-list-row-"]');
    const map = new Map();
    for (const row of rows) {
      const len = row.querySelectorAll('[data-testid*="-slot-"]').length;
      if (!len) continue;
      if (!map.has(len)) map.set(len, []);
      map.get(len).push(row);
    }
    return map;
  }

  // ─── Backtracking path solver ─────────────────────────────────────────────
  //
  // Partitions all letter cells into connected orthogonal paths whose lengths
  // exactly match wordLengths. Works regardless of colour information.

  const PALETTE = ['#E53935', '#43A047', '#1E88E5', '#FB8C00', '#8E24AA', '#00ACC1', '#F4511E', '#6D4C41'];

  function solveByWordLengths(allCells, cellsByIdx, n, wordLengths) {
    if (!wordLengths.length) return null;

    const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    function availNeighbors(idx, avail) {
      const r = Math.floor(idx / n), c = idx % n;
      const out = [];
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
        const ni = nr * n + nc;
        if (avail.has(ni)) out.push(ni);
      }
      return out;
    }

    // Sort longest word first — longest paths have the fewest valid start
    // positions, pruning the search tree most aggressively.
    const sortedLengths = [...wordLengths].sort((a, b) => b - a);
    const results = [];
    const avail = new Set(allCells.map((c) => c.idx));

    function solve(depthIdx) {
      if (depthIdx === sortedLengths.length) return avail.size === 0;

      const targetLen = sortedLengths[depthIdx];

      // Prefer starting from cells with fewest available neighbours
      // (likely path endpoints — degree-1 cells MUST be path endpoints).
      const candidates = [...avail].sort(
        (a, b) => availNeighbors(a, avail).length - availNeighbors(b, avail).length
      );

      for (const startIdx of candidates) {
        const path = [startIdx];
        avail.delete(startIdx);

        function extend() {
          if (path.length === targetLen) {
            results.push([...path]);
            if (solve(depthIdx + 1)) return true;
            results.pop();
            return false;
          }
          const last = path[path.length - 1];
          for (const next of availNeighbors(last, avail)) {
            path.push(next);
            avail.delete(next);
            if (extend()) return true;
            path.pop();
            avail.add(next);
          }
          return false;
        }

        if (extend()) return true;
        avail.add(startIdx);
      }

      return false;
    }

    if (!solve(0)) return null;
    return results.map((idxList) => idxList.map((idx) => cellsByIdx.get(idx)));
  }

  // ─── Board scraping ───────────────────────────────────────────────────────

  function scrapeBoard(gridRoot) {
    let cellEls = Array.from(gridRoot.children).filter(
      (el) => /^cell-\d+$/.test(el.dataset.testid || '')
    );
    if (!cellEls.length) {
      cellEls = Array.from(gridRoot.querySelectorAll('[data-testid]')).filter(
        (el) => /^cell-\d+$/.test(el.dataset.testid || '')
      );
    }
    if (!cellEls.length) return { ok: false, error: 'Found the Wend grid but no cells inside it.' };

    const n = Math.round(Math.sqrt(cellEls.length));
    if (n * n !== cellEls.length) {
      return { ok: false, error: `Cell count (${cellEls.length}) is not a perfect square.` };
    }

    const cells = [];
    const cellsByIdx = new Map();

    for (const cellEl of cellEls) {
      const idx = Number(cellEl.dataset.cellIdx);
      if (isHoleCell(cellEl)) continue;
      const letter = getLetter(cellEl);
      if (!letter) continue;                     // skip non-letter cells only

      const colorKey  = getCellColorKey(cellEl); // null is OK — handled below
      const position  = getWordPosition(cellEl);
      const start     = isStartCell(cellEl, idx);
      const cell      = { idx, el: cellEl, letter, colorKey, position, isStart: start };
      cells.push(cell);
      cellsByIdx.set(idx, cell);
    }

    if (!cells.length) return { ok: false, error: 'No letter cells found on this Wend board.' };

    const expectedLengths = getExpectedWordLengths();
    let words = null;

    // ── Strategy 1: colour grouping ──────────────────────────────────────
    if (cells.some((c) => c.colorKey !== null)) {
      const groups = new Map();
      for (const cell of cells) {
        const key = cell.colorKey ?? '__none__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(cell);
      }

      // Validate group sizes match expected word lengths.
      const groupLens    = [...groups.values()].map((g) => g.length).sort((a, b) => a - b);
      const expectedSort = [...expectedLengths].sort((a, b) => a - b);
      const valid = !expectedLengths.length ||
                    JSON.stringify(groupLens) === JSON.stringify(expectedSort);

      if (valid) {
        words = [];
        let pi = 0;
        for (const [colorKey, group] of groups) {
          let ordered;
          if (hasDistinctPositions(group)) {
            ordered = [...group].sort((a, b) => a.position - b.position);
          } else {
            const startCell = group.find((c) => c.isStart)
              || group.reduce((m, c) => c.idx < m.idx ? c : m, group[0]);
            ordered = followPath(startCell, cellsByIdx, n);
            if (ordered.length !== group.length) ordered = [...group].sort((a, b) => a.idx - b.idx);
          }
          // If the key looks like an rgb() string, use it directly; else use palette.
          const color = (colorKey.startsWith('rgb') || colorKey.startsWith('#'))
            ? colorKey : PALETTE[pi % PALETTE.length];
          words.push({ color, cells: ordered });
          pi++;
        }
      }
    }

    // ── Strategy 1b: CSS custom property scan ────────────────────────────
    // The word colour may be encoded in a CSS custom property (--xxxx: #color)
    // set by the cell's class and inherited by child elements. We scan all
    // colour-like custom props on the first few cells, then check which one
    // produces the right group sizes across all cells.
    if (!words && expectedLengths.length) {
      const found = findWordColorProp(cells, expectedLengths);
      if (found) {
        const { prop, elType } = found;
        const groups = new Map();
        for (const cell of cells) {
          const el = elType === 'self' ? cell.el : cell.el.firstElementChild;
          const v = el ? window.getComputedStyle(el).getPropertyValue(prop).trim() : '__none__';
          if (!groups.has(v)) groups.set(v, []);
          groups.get(v).push(cell);
        }
        words = [];
        let pi = 0;
        for (const [colorVal, group] of groups) {
          const startCell = group.find((c) => c.isStart)
            || group.reduce((m, c) => c.idx < m.idx ? c : m, group[0]);
          let ordered = followPath(startCell, cellsByIdx, n, (a, b) => {
            const elA = elType === 'self' ? a.el : a.el.firstElementChild;
            const elB = elType === 'self' ? b.el : b.el.firstElementChild;
            if (!elA || !elB) return false;
            return window.getComputedStyle(elA).getPropertyValue(prop).trim() ===
                   window.getComputedStyle(elB).getPropertyValue(prop).trim();
          });
          if (ordered.length !== group.length) ordered = [...group].sort((a, b) => a.idx - b.idx);
          const color = /^#[0-9a-f]{3,8}$/i.test(colorVal) || /^rgba?\(/.test(colorVal)
            ? colorVal : PALETTE[pi % PALETTE.length];
          words.push({ color, cells: ordered });
          pi++;
        }
      }
    }

    // ── Strategy 2: backtracking solver ──────────────────────────────────
    if (!words && expectedLengths.length) {
      const solved = solveByWordLengths(cells, cellsByIdx, n, expectedLengths);
      if (solved) {
        words = solved.map((group, i) => ({ color: PALETTE[i % PALETTE.length], cells: group }));
      }
    }

    // ── Last resort: single group (at least shows the grid) ───────────────
    if (!words) {
      words = [{ color: PALETTE[0], cells }];
    }

    return { ok: true, words };
  }

  // ─── Overlay rendering ────────────────────────────────────────────────────

  function run() {
    const gridRoot = findGrid();
    if (!gridRoot) return { ok: false, error: 'Could not find the Wend puzzle grid on this page.' };

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape;

    const rowsByLength   = buildWordListRowsByLength();
    const wordRowEls     = scrape.words.map(({ cells }) => {
      const avail = rowsByLength.get(cells.length);
      return (avail && avail.length) ? avail.shift() : null;
    });
    const boardSolved    = wordRowEls.every((r) => r && r.dataset.locked === 'true');

    const markers   = [];
    const linePaths = [];

    for (let wi = 0; wi < scrape.words.length; wi++) {
      const { color, cells } = scrape.words[wi];
      const rowEl = wordRowEls[wi];
      const isWordSolved = boardSolved
        ? () => false
        : () => rowEl ? rowEl.dataset.locked === 'true' : false;

      markers.push({
        cellEl: cells[0].el,
        html:   `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:${color};border-radius:3px"><span style="width:32%;height:32%;background:#fff;border-radius:50%;flex-shrink:0"></span></span>`,
        color,
        isFilled: isWordSolved,
      });
      markers.push({
        cellEl: cells[cells.length - 1].el,
        html:   `<span style="display:flex;width:100%;height:100%;background:rgba(255,255,255,0.15);border-radius:3px"></span>`,
        color,
        isFilled: isWordSolved,
      });
      linePaths.push({
        cells:   cells.map((c) => c.el),
        color:   '#ffffff',
        isDrawn: isWordSolved,
      });
    }

    window.LockedInOverlay.show({ anchorEl: gridRoot, markers, linePaths });
    return { ok: true };
  }

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id:     'wend',
    label:  'Wend',
    detect: () => /\/games\/wend(\/|$)/.test(location.pathname),
    run,
  });
})();
