// games/zip/game.js
//
// Scraping strategy confirmed against the live LinkedIn Zip DOM. The grid root
// is [data-testid="interactive-grid"][data-trail-grid]; cells are direct
// children with data-testid="cell-N" and data-cell-idx for their position.
// Waypoint cells (the numbered ones) carry aria-label="Number N" on the cell
// element itself, and render the digit inside a child [data-cell-content="true"]
// div. Non-waypoint cells have neither attribute.
//
// The grid size can be inferred from the cell count (always a perfect square so
// far). LinkedIn also stores it in CSS custom properties on the grid element but
// their obfuscated names change across deploys, so cell-count √ is more stable.

(function () {
  // Zip's interactive grid carries data-trail-grid; this distinguishes it from
  // the shared [data-testid="interactive-grid"] used by Tango.
  function findGrid() {
    return document.querySelector('[data-testid="interactive-grid"][data-trail-grid]');
  }

  // Waypoint number from a cell element, or null for non-waypoint cells.
  // Confirmed: waypoint cells have aria-label="Number N" (e.g. "Number 2").
  function getWaypointNumber(cellEl) {
    const label = cellEl.getAttribute('aria-label') || '';
    const match = label.match(/^Number\s+(\d+)$/i);
    return match ? Number(match[1]) : null;
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

      const wp = getWaypointNumber(cellEl);
      if (wp !== null) waypoints.set(`${row},${col}`, wp);
    }

    if (!([...waypoints.values()].includes(1))) {
      return { ok: false, error: 'Could not find the starting cell (numbered 1).' };
    }
    if (waypoints.size < 2) {
      return { ok: false, error: 'Too few numbered waypoints found on this board.' };
    }

    return { ok: true, size: n, waypoints, cellElements };
  }

  // VERIFY: LinkedIn marks a Zip cell as drawn (user has dragged through it)
  // by setting aria-pressed="true" on the cell element. Confirm in DevTools
  // after dragging through a cell: inspect the cell and check for that attribute.
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

    const path = solveZip({ size: scrape.size, waypoints: scrape.waypoints }); // from games/zip/solver.js
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
