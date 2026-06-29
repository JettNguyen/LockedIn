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
// ACTION REQUIRED (already worked around, but worth knowing): the DOM gives
// no class or attribute saying whether an edge marker constrains the cell to
// its right or the cell below it - both directions render the same square
// icon, positioned via hashed CSS classes I can't read semantics from
// statically. I confirmed this is genuinely ambiguous by hand-deriving
// constraints from the pasted HTML and finding the puzzle unsatisfiable
// under a "assume horizontal" guess. Rather than guess, inferEdgeDirection()
// below measures the marker's actual on-screen position relative to its
// cell at solve time (getBoundingClientRect()) and picks whichever axis it's
// offset along - this needs a live page and can't be verified from static
// HTML, so the first time you run this on a real puzzle, check the
// highlighted Suns/Moons actually satisfy the visible "=" / "x" marks.

(function () {
  // Matching Tango's own palette (its Sun icon renders yellow, its Moon
  // icon renders blue). Plain emoji (☀️/🌙) can't be recolored via CSS -
  // they always render with their own built-in colors - so these are small
  // hand-drawn outline icons instead, using currentColor so the overlay's
  // per-marker `color` actually takes effect.
  const SUN_COLOR = '#f4b400';
  const MOON_COLOR = '#4a90e2';
  const SUN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<circle cx="12" cy="12" r="5"></circle>' +
    '<line x1="12" y1="1" x2="12" y2="4"></line>' +
    '<line x1="12" y1="20" x2="12" y2="23"></line>' +
    '<line x1="1" y1="12" x2="4" y2="12"></line>' +
    '<line x1="20" y1="12" x2="23" y2="12"></line>' +
    '<line x1="4.2" y1="4.2" x2="6.3" y2="6.3"></line>' +
    '<line x1="17.7" y1="17.7" x2="19.8" y2="19.8"></line>' +
    '<line x1="4.2" y1="19.8" x2="6.3" y2="17.7"></line>' +
    '<line x1="17.7" y1="6.3" x2="19.8" y2="4.2"></line>' +
    '</svg>';
  const MOON_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>' +
    '</svg>';

  function findGrid() {
    const wrapper = document.querySelector('[data-testid="tango-gameboard-wrapper"]');
    if (!wrapper) return null;
    return wrapper.querySelector('[data-testid="interactive-grid"]');
  }

  function inferEdgeDirection(cellEl, edgeSvg, row, col, n) {
    const cellRect = cellEl.getBoundingClientRect();
    const edgeRect = edgeSvg.getBoundingClientRect();
    const dx = edgeRect.left + edgeRect.width / 2 - (cellRect.left + cellRect.width / 2);
    const dy = edgeRect.top + edgeRect.height / 2 - (cellRect.top + cellRect.height / 2);

    const wantsHorizontal = Math.abs(dx) >= Math.abs(dy);
    const canGoRight = col + 1 < n;
    const canGoDown = row + 1 < n;

    if (wantsHorizontal && canGoRight) return { row, col: col + 1 };
    if (!wantsHorizontal && canGoDown) return { row: row + 1, col };
    // Geometry disagreed with what's actually possible at a grid edge (e.g.
    // measurement noise on the last column) - fall back to whichever
    // direction is actually available.
    if (canGoRight) return { row, col: col + 1 };
    if (canGoDown) return { row: row + 1, col };
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

      const edgeSvg = cellEl.querySelector('[data-testid="edge-cross"], [data-testid="edge-equal"]');
      if (edgeSvg) {
        const type = edgeSvg.dataset.testid === 'edge-cross' ? 'neq' : 'eq';
        const target = inferEdgeDirection(cellEl, edgeSvg, row, col, n);
        if (!target) {
          return { ok: false, error: `Could not resolve the constraint neighbor for cell (row ${row + 1}, column ${col + 1}).` };
        }
        constraints.push({ r1: row, c1: col, r2: target.row, c2: target.col, type });
      }
    }

    return { ok: true, n, given, constraints, cellElements };
  }

  function isCellFilled(cellEl) {
    const svg = cellEl.querySelector('[data-testid="cell-empty"], [data-testid="cell-zero"], [data-testid="cell-one"]');
    return !!svg && svg.dataset.testid !== 'cell-empty';
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
        const isSun = solution[r][c] === 0;
        markers.push({
          cellEl: scrape.cellElements[r][c],
          html: isSun ? SUN_ICON : MOON_ICON,
          color: isSun ? SUN_COLOR : MOON_COLOR,
          isFilled: isCellFilled,
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
    detect: () => /\/games\/tango(\/|$)/.test(location.pathname),
    run,
  });
})();
