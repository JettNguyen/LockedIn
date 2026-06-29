// games/queens/game.js
//
// Scraping strategy confirmed against the live LinkedIn Queens DOM (not just
// a spec snapshot): the grid root is #queens-game-board > [data-testid=
// "interactive-grid"], cells are [data-testid^="cell-"] with a matching
// data-cell-idx, and each cell's aria-label reads "...color <Name>, row <R>,
// column <C>" - that aria-label is the primary signal parseAriaLabel() and
// scrapeBoard() rely on. If LinkedIn ever changes that wording, the scraper
// falls back to computed-style + data-cell-idx (see the VERIFY comments
// below) rather than silently producing a wrong board.

(function () {
  function findGrid() {
    // Prefer the explicit, human-readable id over any hashed utility class -
    // those are build-tool output and rotate across LinkedIn deploys, while
    // an id like "queens-game-board" reads like a stable, intentional hook.
    const section = document.querySelector('#queens-game-board');
    if (!section) return null;

    const grid = section.querySelector('[data-testid="interactive-grid"]');
    return grid || section;
  }

  function parseAriaLabel(cellEl) {
    const label = cellEl.getAttribute('aria-label') || '';
    // Matches LinkedIn's accessibility label, e.g.
    //   "Empty cell of color Lavender, row 1, column 1"
    // Not anchored to the start, so prefixes like "Cell with queen of
    // color..." (if the puzzle already has marks on it) still match.
    const match = label.match(/color\s+([a-z ]+?)\s*,\s*row\s+(\d+)\s*,\s*column\s+(\d+)/i);
    if (!match) return null;

    return {
      colorName: match[1].trim().toLowerCase(),
      row: Number(match[2]) - 1,
      col: Number(match[3]) - 1,
    };
  }

  // VERIFY: only used if parseAriaLabel() fails for at least one cell (i.e.
  // LinkedIn changed the aria-label wording). Assumes the region's color is
  // painted as a solid, non-transparent background-color on the cell itself
  // or on one of its descendant <div>s, and that whichever element actually
  // paints the fill has a larger on-screen area than any border/wall
  // decoration divs (the reference HTML had thin strip divs like
  // classes "_988b0982 dc56d0bb" for region boundaries). If this path
  // triggers, confirm in DevTools which node really carries the color
  // before trusting it.
  function computedBackgroundKey(cellEl) {
    const candidates = [cellEl, ...cellEl.querySelectorAll('div')];
    let best = null;
    let bestArea = 0;

    for (const el of candidates) {
      const bg = getComputedStyle(el).backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;

      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = bg;
      }
    }

    return best || 'unknown';
  }

  function scrapeBoard(gridRoot) {
    const cellEls = Array.from(gridRoot.querySelectorAll('[data-testid^="cell-"]'));
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

    const ariaResults = cellEls.map(parseAriaLabel);
    const ariaPathOk = ariaResults.every(Boolean);

    let positionOf; // (cellEl, idx) => { row, col }
    let colorKeyOf; // (cellEl, idx) => string

    if (ariaPathOk) {
      positionOf = (_cellEl, idx) => ({ row: ariaResults[idx].row, col: ariaResults[idx].col });
      colorKeyOf = (_cellEl, idx) => ariaResults[idx].colorName;
    } else {
      // VERIFY: falls back to data-cell-idx, assuming row-major order
      // (idx = row * n + col). That matched every cell in the reference
      // HTML (idx 0-6 were row 1, 7-13 were row 2, etc. for n=7), but it's
      // an inferred pattern, not a documented contract.
      console.warn(
        '[LockedIn/Queens] aria-label parsing failed for at least one cell; using structural fallback. // VERIFY'
      );
      positionOf = (cellEl, idx) => {
        const rawIdx = Number(cellEl.dataset.cellIdx);
        const useIdx = Number.isInteger(rawIdx) ? rawIdx : idx;
        return { row: Math.floor(useIdx / n), col: useIdx % n };
      };
      colorKeyOf = (cellEl) => computedBackgroundKey(cellEl);
    }

    const board = Array.from({ length: n }, () => new Array(n).fill(null));
    const cellElements = Array.from({ length: n }, () => new Array(n).fill(null));
    const regionIds = new Map();
    let nextRegionId = 0;

    cellEls.forEach((cellEl, idx) => {
      const { row, col } = positionOf(cellEl, idx);
      if (row < 0 || row >= n || col < 0 || col >= n) return;

      const colorKey = colorKeyOf(cellEl, idx);
      if (!regionIds.has(colorKey)) regionIds.set(colorKey, nextRegionId++);

      board[row][col] = regionIds.get(colorKey);
      cellElements[row][col] = cellEl;
    });

    if (board.some((rowArr) => rowArr.some((v) => v === null))) {
      return { ok: false, error: "Couldn't map every cell to a row/column; the grid layout may have changed." };
    }

    if (regionIds.size < 2) {
      return { ok: false, error: 'Could not distinguish colored regions (every cell resolved to the same color).' };
    }

    return { ok: true, board, cellElements, n };
  }

  // VERIFY: the only confirmed wording from the live DOM is "Empty cell of
  // color <Name>, row <R>, column <C>" for untouched cells. I haven't seen
  // the aria-label LinkedIn uses once a cell has a queen (vs. an X mark) on
  // it, so this treats "no longer contains the word Empty" as "the user has
  // marked this cell" - covers both marks, not strictly "queen only". If you
  // want the overlay to dim solely on a placed queen (not an X), check a
  // marked cell's aria-label in DevTools and tighten this.
  function isCellMarked(cellEl) {
    return !(cellEl.getAttribute('aria-label') || '').toLowerCase().includes('empty');
  }

  function run() {
    const gridRoot = findGrid();
    if (!gridRoot) {
      return { ok: false, error: 'Could not find the Queens puzzle grid on this page.' };
    }

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape;

    const solution = solveQueens(scrape.board); // from games/queens/solver.js
    if (!solution) {
      return { ok: false, error: 'No solution exists for the scraped board (solver returned null).' };
    }

    const markers = solution.map(([row, col]) => ({
      cellEl: scrape.cellElements[row][col],
      glyph: '♛',
      color: '#f5c542',
      isFilled: isCellMarked,
    }));
    window.LockedInOverlay.show({ anchorEl: gridRoot, markers });

    return { ok: true };
  }

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id: 'queens',
    label: 'Queens',
    detect: () => /\/games\/queens(\/|$)/.test(location.pathname),
    run,
  });
})();
