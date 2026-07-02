// games/zip/game.js
//
// Scraping strategy confirmed against the live LinkedIn Zip DOM.
//
// WALLS: cells with a wall on one of their four sides contain a plain child
// div (no data-testid, no data-cell-content) whose className includes one of
// four directional marker classes:
//   _7354ccbe → wall on the RIGHT side of this cell
//   eb4f579a  → wall on the LEFT  side of this cell
//   ce74d07a  → wall on the BOTTOM side of this cell
//   a1d68cc0  → wall on the BOTTOM side of this cell
//
// For horizontal walls LinkedIn marks both adjacent cells (right-cell gets
// "right", left-cell gets "left"). For vertical walls only the cell that
// visually displays the wall indicator is marked. In canMove() we check
// BOTH adjacent cells so a single-sided encoding is handled correctly.

(function () {
  function findGrid() {
    return document.querySelector('[data-testid="interactive-grid"][data-trail-grid]');
  }

  function getWaypointNumber(cellEl) {
    const label = cellEl.getAttribute('aria-label') || '';
    const match = label.match(/^Number\s+(\d+)$/i);
    return match ? Number(match[1]) : null;
  }

  // Return the wall flags for a single cell by inspecting its child divs.
  // We skip the filled-cell div and the number-content div; everything else
  // is a candidate wall indicator and we look for the directional class.
  function parseWalls(cellEl) {
    const w = { top: false, bottom: false, left: false, right: false };
    for (const child of cellEl.children) {
      if (child.dataset.testid === 'filled-cell') continue;
      if (child.dataset.cellContent) continue;
      const cls = child.className || '';
      if (cls.includes('_7354ccbe')) w.right  = true;
      if (cls.includes('eb4f579a'))  w.left   = true;
      if (cls.includes('ce74d07a'))  w.bottom = true;
      if (cls.includes('a1d68cc0'))  w.bottom = true;
    }
    return w;
  }

  function scrapeBoard(gridRoot) {
    const cellEls = Array.from(gridRoot.children).filter(
      (el) => /^cell-\d+$/.test(el.dataset.testid || '')
    );
    if (cellEls.length === 0) {
      return { ok: false, error: 'Found the grid container but no cells inside it.' };
    }

    const n = Math.round(Math.sqrt(cellEls.length));
    if (n * n !== cellEls.length) {
      return {
        ok: false,
        error: `Cell count (${cellEls.length}) is not a perfect square; can't infer an NxN grid.`,
      };
    }

    const cellElements = Array.from({ length: n }, () => new Array(n).fill(null));
    const walls = Array.from({ length: n }, () => new Array(n).fill(null));
    const waypoints = new Map();

    for (const cellEl of cellEls) {
      const idx = Number(cellEl.dataset.cellIdx);
      if (!Number.isInteger(idx)) {
        return { ok: false, error: 'A cell is missing a numeric data-cell-idx.' };
      }
      const row = Math.floor(idx / n);
      const col = idx % n;
      if (row < 0 || row >= n || col < 0 || col >= n) {
        return { ok: false, error: `Cell index ${idx} doesn't fit a ${n}x${n} grid.` };
      }
      cellElements[row][col] = cellEl;
      walls[row][col] = parseWalls(cellEl);

      const wp = getWaypointNumber(cellEl);
      if (wp !== null) waypoints.set(`${row},${col}`, wp);
    }

    if (![...waypoints.values()].includes(1)) {
      return { ok: false, error: 'Could not find the starting cell (numbered 1).' };
    }
    if (waypoints.size < 2) {
      return { ok: false, error: 'Too few numbered waypoints found on this board.' };
    }

    return { ok: true, size: n, waypoints, cellElements, walls };
  }

  function isCellDrawn(cellEl) {
    return cellEl.getAttribute('aria-pressed') === 'true';
  }

  function run() {
    const gridRoot = findGrid();
    if (!gridRoot) {
      return { ok: false, error: 'Could not find the Zip puzzle grid on this page.' };
    }

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape;

    const path = solveZip({ size: scrape.size, waypoints: scrape.waypoints, walls: scrape.walls });
    if (!path) {
      return { ok: false, error: 'No solution exists for the scraped board (solver returned null).' };
    }

    const cells = path.map((cell) => scrape.cellElements[cell.r][cell.c]);
    window.LockedInOverlay.show({
      anchorEl: gridRoot,
      markers: [],
      linePath: { cells, color: '#22c55e', isDrawn: isCellDrawn },
    });
    return { ok: true };
  }

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id: 'zip',
    label: 'Zip',
    detect: () => /\/games\/zip(\/|$)/.test(location.pathname),
    run,
  });
})();
