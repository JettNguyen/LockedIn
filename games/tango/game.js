// games/tango/game.js
//
// Scraping strategy confirmed against the live LinkedIn Tango DOM. The grid
// root is [data-testid="tango-gameboard-wrapper"] [data-testid=
// "interactive-grid"]; each cell is a direct child with data-cell-idx and
// data-testid="cell-N"; cell content (Sun/Moon/Empty) is read from a nested
// svg's data-testid ("cell-zero" | "cell-one" | "cell-empty"); an edge
// constraint (the "=" or "x" between two adjacent cells) is read from a
// nested svg's data-testid ("edge-equal" | "edge-cross").
//
// Two things about edge markers are worth knowing:
//
// A cell can carry MORE than one marker - the top-left cell often has both a
// "=" to its right and a "=" below it. Read every marker in the cell, not
// just the first one, or the solver quietly solves a looser puzzle and hands
// back a grid that breaks the mark you can see on screen.
//
// The DOM also gives no class or attribute saying which neighbor a marker
// constrains - every direction renders the same square icon, positioned via
// hashed CSS classes I can't read semantics from statically. So
// inferEdgeDirection() below measures the marker's actual on-screen position
// relative to its cell at solve time (getBoundingClientRect()) and picks the
// neighbor it sits toward. That needs a live page, so when this starts
// missing puzzles again, check the highlighted Suns and Moons against the
// visible "=" and "x" marks first.

(function () {
  // Matching Tango's own palette.
  const SUN_COLOR = '#f4b400';
  const MOON_COLOR = '#4a90e2';

  function findGrid() {
    const wrapper = document.querySelector('[data-testid="tango-gameboard-wrapper"]');
    if (!wrapper) return null;
    return wrapper.querySelector('[data-testid="interactive-grid"]');
  }

  // Which neighbor does this marker sit between us and? Ranked best-first by
  // the direction it's offset toward, then by whatever neighbor is left, so a
  // marker whose measurement is noisy still lands somewhere sensible. `taken`
  // holds the neighbors this cell's earlier markers already claimed, which
  // keeps two markers on one cell from both grabbing the same side.
  function inferEdgeDirection(cellEl, edgeSvg, row, col, n, taken) {
    const cellRect = cellEl.getBoundingClientRect();
    const edgeRect = edgeSvg.getBoundingClientRect();
    const dx = edgeRect.left + edgeRect.width / 2 - (cellRect.left + cellRect.width / 2);
    const dy = edgeRect.top + edgeRect.height / 2 - (cellRect.top + cellRect.height / 2);

    const horizontal = { row, col: dx < 0 ? col - 1 : col + 1 };
    const vertical = { row: dy < 0 ? row - 1 : row + 1, col };
    const ranked = Math.abs(dx) >= Math.abs(dy) ? [horizontal, vertical] : [vertical, horizontal];
    ranked.push({ row, col: col + 1 }, { row: row + 1, col }, { row, col: col - 1 }, { row: row - 1, col });

    for (const target of ranked) {
      if (target.row < 0 || target.row >= n || target.col < 0 || target.col >= n) continue;
      if (taken.has(`${target.row},${target.col}`)) continue;
      return target;
    }
    return null;
  }

  function scrapeBoard(gridRoot) {
    const cellEls = Array.from(gridRoot.children).filter((el) => /^cell-\d+$/.test(el.dataset.testid || ''));
    if (cellEls.length === 0) {
      return { ok: false, error: 'Found the grid container but no cells inside it.' };
    }

    const n = Math.round(Math.sqrt(cellEls.length));
    if (n * n !== cellEls.length) {
      return { ok: false, error: `Cell count (${cellEls.length}) is not a perfect square; can't infer an NxN grid.` };
    }
    if (n % 2 !== 0) {
      return { ok: false, error: `Grid size ${n} is odd; Tango requires an even-sized grid.` };
    }

    const cellElements = Array.from({ length: n }, () => new Array(n).fill(null));
    const given = new Map();
    const constraints = [];

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

      const contentSvg = cellEl.querySelector(
        '[data-testid="cell-zero"], [data-testid="cell-one"], [data-testid="cell-empty"]'
      );
      if (!contentSvg) {
        return { ok: false, error: 'A cell has no recognizable Sun/Moon/Empty marker.' };
      }
      if (contentSvg.dataset.testid === 'cell-zero') given.set(`${row},${col}`, 0);
      else if (contentSvg.dataset.testid === 'cell-one') given.set(`${row},${col}`, 1);

      // A cell can hold several markers (right and below), so take them all.
      const edgeSvgs = cellEl.querySelectorAll('[data-testid="edge-cross"], [data-testid="edge-equal"]');
      const taken = new Set();
      for (const edgeSvg of edgeSvgs) {
        const type = edgeSvg.dataset.testid === 'edge-cross' ? 'neq' : 'eq';
        const target = inferEdgeDirection(cellEl, edgeSvg, row, col, n, taken);
        if (!target) {
          return { ok: false, error: `Could not resolve the constraint neighbor for cell (row ${row + 1}, column ${col + 1}).` };
        }
        taken.add(`${target.row},${target.col}`);
        constraints.push({ r1: row, c1: col, r2: target.row, c2: target.col, type });
      }
    }

    return { ok: true, n, given, constraints, cellElements };
  }

  // Returns true only when the cell holds the expected value (0=Sun, 1=Moon),
  // so the highlight fades only once the user places the correct symbol.
  function isCellCorrect(cellEl, expected) {
    const testId = expected === 0 ? 'cell-zero' : 'cell-one';
    return !!cellEl.querySelector(`[data-testid="${testId}"]`);
  }

  function run() {
    const gridRoot = findGrid();
    if (!gridRoot) {
      return { ok: false, error: 'Could not find the Tango puzzle grid on this page.' };
    }

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape;

    const solution = solveTango({ size: scrape.n, given: scrape.given, constraints: scrape.constraints }); // from games/tango/solver.js
    if (!solution) {
      return { ok: false, error: 'No solution exists for the scraped board (solver returned null).' };
    }

    const markers = [];
    for (let r = 0; r < scrape.n; r++) {
      for (let c = 0; c < scrape.n; c++) {
        if (scrape.given.has(`${r},${c}`)) continue; // already shown on the page, no need to mark it
        const expected = solution[r][c]; // 0 = Sun, 1 = Moon
        const isSun = expected === 0;
        markers.push({
          cellEl: scrape.cellElements[r][c],
          glyph: '',
          color: isSun ? SUN_COLOR : MOON_COLOR,
          isFilled: (cellEl) => isCellCorrect(cellEl, expected),
        });
      }
    }

    window.LockedInOverlay.show({ anchorEl: gridRoot, markers });
    return { ok: true };
  }

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id: 'tango',
    label: 'Tango',
    detect: () => window.LockedInDetect.gameDetector('tango')(),
    run,
  });
})();
