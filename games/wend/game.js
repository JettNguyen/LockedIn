// games/wend/game.js
//
// Scraping strategy confirmed against the live LinkedIn Wend DOM.
//
// BOARD: same interactive-grid/data-trail-grid container as Zip. Each non-hole
// cell has:
//   data-cell-idx        - row-major index
//   data-cell-word-color - hex color of the word this cell belongs to
//   inline style         - two CSS custom properties:
//     one integer  (--xxxx: N)     → word position (smallest = first letter)
//     one hex color (--xxxx: #RR)  → same as data-cell-word-color
// Hole cells carry data-cell-is-hole="true" and have no letter or word color.
//
// WORD ORDER: the integer CSS custom property encodes the cell's position within
// its word. Grouping by color and sorting by this integer immediately gives the
// full ordered path.
//
// FALLBACK: if position values are missing or non-distinct within a color group,
// we find the start-indicator cell and follow the unique orthogonal chain
// through same-color cells. Covers all non-branching paths.
//
// UI: numbered badges on each cell (1 = first letter, 2 = second, …) with a
// white background so they're readable on any cell color, plus a white
// connecting polyline showing path direction. Both vanish per-word once
// data-locked="true" appears on the matching word-list row.

(function () {
  function findGrid() {
    // Primary selector (same as Zip).
    const grid = document.querySelector('[data-testid="interactive-grid"][data-trail-grid]');
    if (grid) return grid;
    // Fallback: any interactive-grid, confirmed by the presence of a Wend word-list.
    const anyGrid = document.querySelector('[data-testid="interactive-grid"]');
    if (anyGrid && document.querySelector('[data-testid^="wend-word-list-row-"]')) return anyGrid;
    return null;
  }

  function isHoleCell(cellEl) {
    return cellEl.dataset.cellIsHole === 'true';
  }

  // The letter lives in a <span> whose trimmed text content is exactly one A–Z char.
  function getLetter(cellEl) {
    for (const span of cellEl.querySelectorAll('span')) {
      const t = span.textContent.trim();
      if (/^[A-Z]$/.test(t)) return t;
    }
    return null;
  }

  // Read the integer CSS custom property encoding the cell's word position.
  // Returns 0 if not found.
  function getWordPosition(cellEl) {
    for (const prop of cellEl.style) {
      if (!prop.startsWith('--')) continue;
      const val = cellEl.style.getPropertyValue(prop).trim();
      if (/^\d+$/.test(val)) return parseInt(val, 10);
    }
    return 0;
  }

  function isStartCell(cellEl, idx) {
    return !!cellEl.querySelector(`[data-testid="cell-${idx}-start-indicator"]`);
  }

  // Walk the unique orthogonal chain through same-color cells starting from startCell.
  function followPath(startCell, cellsByIdx, n) {
    const path = [startCell];
    const visited = new Set([startCell.idx]);
    const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    let current = startCell;
    while (true) {
      const r = Math.floor(current.idx / n);
      const c = current.idx % n;
      let next = null;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
        const nidx = nr * n + nc;
        if (visited.has(nidx)) continue;
        const neighbor = cellsByIdx.get(nidx);
        if (!neighbor || neighbor.color !== current.color) continue;
        next = neighbor;
        break;
      }
      if (!next) break;
      visited.add(next.idx);
      path.push(next);
    }
    return path;
  }

  function hasDistinctPositions(group) {
    const positions = group.map((c) => c.position).filter((p) => p > 0);
    return positions.length === group.length && new Set(positions).size === group.length;
  }

  function scrapeBoard(gridRoot) {
    const cellEls = Array.from(gridRoot.children).filter(
      (el) => /^cell-\d+$/.test(el.dataset.testid || '')
    );
    if (cellEls.length === 0) {
      return { ok: false, error: 'Found the Wend grid but no cells inside it.' };
    }

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
      if (!letter) continue;

      const color = (cellEl.dataset.cellWordColor || '').toUpperCase();
      if (!color) continue;

      const position = getWordPosition(cellEl);
      const start = isStartCell(cellEl, idx);

      const cell = { idx, el: cellEl, letter, color, position, isStart: start };
      cells.push(cell);
      cellsByIdx.set(idx, cell);
    }

    if (cells.length === 0) {
      return { ok: false, error: 'No letter cells found on this Wend board.' };
    }

    const groups = new Map();
    for (const cell of cells) {
      if (!groups.has(cell.color)) groups.set(cell.color, []);
      groups.get(cell.color).push(cell);
    }

    const words = [];
    for (const [color, group] of groups) {
      let ordered;
      if (hasDistinctPositions(group)) {
        ordered = [...group].sort((a, b) => a.position - b.position);
      } else {
        const startCell = group.find((c) => c.isStart) || group[0];
        ordered = followPath(startCell, cellsByIdx, n);
        if (ordered.length !== group.length) ordered = group;
      }
      words.push({ color, cells: ordered });
    }

    return { ok: true, words };
  }

  // Find the word-list row whose inline-style CSS custom property matches the color.
  function findWordListRow(color) {
    const colorUpper = color.toUpperCase();
    const rows = document.querySelectorAll('[data-testid^="wend-word-list-row-"]');
    for (const row of rows) {
      for (const prop of row.style) {
        if (!prop.startsWith('--')) continue;
        if (row.style.getPropertyValue(prop).trim().toUpperCase() === colorUpper) return row;
      }
    }
    return null;
  }

  function run() {
    const gridRoot = findGrid();
    if (!gridRoot) {
      return { ok: false, error: 'Could not find the Wend puzzle grid on this page.' };
    }

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape;

    // If every word is already locked (solved board), skip completion callbacks so the
    // overlay stays fully visible — useful for testing on a previously-solved puzzle.
    const wordRowEls = scrape.words.map(({ color }) => findWordListRow(color));
    const boardAlreadySolved = wordRowEls.every((row) => row && row.dataset.locked === 'true');

    // Build markers and paths for every word simultaneously.
    const markers = [];
    const linePaths = [];

    for (let wi = 0; wi < scrape.words.length; wi++) {
      const { color, cells } = scrape.words[wi];
      const rowEl = wordRowEls[wi];
      // Once the whole word is locked in, its overlay fades — unless the board was
      // already solved when the overlay was created, in which case we always show it.
      const isWordSolved = boardAlreadySolved
        ? () => false
        : () => rowEl ? rowEl.dataset.locked === 'true' : false;

      // Start marker: solid colored square with a white dot in the center, mirroring
      // the game's own circle indicator for the first cell of each word.
      markers.push({
        cellEl: cells[0].el,
        html: `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:${color};border-radius:3px"><span style="width:32%;height:32%;background:#fff;border-radius:50%;flex-shrink:0"></span></span>`,
        color,
        isFilled: isWordSolved,
      });

      // End marker: outlined square (just the colored border, light interior) so it
      // reads visually as a destination/target rather than a starting point.
      markers.push({
        cellEl: cells[cells.length - 1].el,
        html: `<span style="display:flex;width:100%;height:100%;background:rgba(255,255,255,0.15);border-radius:3px"></span>`,
        color,
        isFilled: isWordSolved,
      });

      // White polyline connecting the full path — visible against any cell color.
      linePaths.push({
        cells: cells.map((c) => c.el),
        color: '#ffffff',
        isDrawn: isWordSolved,
      });
    }

    window.LockedInOverlay.show({ anchorEl: gridRoot, markers, linePaths });
    return { ok: true };
  }

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id: 'wend',
    label: 'Wend',
    detect: () => /\/games\/wend(\/|$)/.test(location.pathname),
    run,
  });
})();
