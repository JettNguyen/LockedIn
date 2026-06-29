// content.js
//
// Scraping strategy confirmed against the live LinkedIn Queens DOM (not just
// the task spec): the grid root is #queens-game-board > [data-testid=
// "interactive-grid"], cells are [data-testid^="cell-"] with a matching
// data-cell-idx, and each cell's aria-label reads "...color <Name>, row <R>,
// column <C>" - that aria-label is the primary signal parseAriaLabel() and
// scrapeBoard() rely on. If LinkedIn ever changes that wording, the scraper
// falls back to computed-style + data-cell-idx (see the VERIFY comments
// below) rather than silently producing a wrong board.

(function () {
  // ---------------------------------------------------------------------
  // Grid discovery
  // ---------------------------------------------------------------------

  function findGrid() {
    // Prefer the explicit, human-readable id over any hashed utility class -
    // those are build-tool output and rotate across LinkedIn deploys, while
    // an id like "queens-game-board" reads like a stable, intentional hook.
    const section = document.querySelector('#queens-game-board');
    if (!section) return null;

    const grid = section.querySelector('[data-testid="interactive-grid"]');
    return grid || section;
  }

  // ---------------------------------------------------------------------
  // Cell parsing
  // ---------------------------------------------------------------------

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
  // ".qs-unused { } /* e.g. classes \"_988b0982 dc56d0bb\" */" for region
  // boundaries). If this path triggers, confirm in DevTools which node
  // really carries the color before trusting it.
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
        '[Queens Solver] aria-label parsing failed for at least one cell; using structural fallback. // VERIFY'
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

  // ---------------------------------------------------------------------
  // Overlay rendering (purely additive - never touches the scraped DOM)
  // ---------------------------------------------------------------------

  let overlayState = null;

  function isOverlayActive() {
    return overlayState !== null;
  }

  function dismissOverlay() {
    if (!overlayState) return;
    cancelAnimationFrame(overlayState.rafId);
    overlayState.observer.disconnect();
    overlayState.container.remove();
    overlayState = null;
  }

  function applyQueenStyle(markerEl, rect) {
    const size = Math.min(rect.width, rect.height) * 0.62;
    markerEl.style.left = `${rect.left + rect.width / 2 - size / 2}px`;
    markerEl.style.top = `${rect.top + rect.height / 2 - size / 2}px`;
    markerEl.style.width = `${size}px`;
    markerEl.style.height = `${size}px`;
    markerEl.style.fontSize = `${size * 0.9}px`;
  }

  function positionDismissButton(btn, gridRect) {
    btn.style.left = `${gridRect.right - 8}px`;
    btn.style.top = `${gridRect.top - 8}px`;
  }

  function startTrackingLoop(state) {
    function tick() {
      // SPA navigation guard: if the grid this overlay was drawn for has
      // been removed from the page (route change, re-render, etc.), clean
      // ourselves up instead of floating a stale overlay over new content.
      if (!document.body.contains(state.gridRoot)) {
        dismissOverlay();
        return;
      }

      positionDismissButton(state.dismissBtn, state.gridRoot.getBoundingClientRect());
      for (const { cellEl, markerEl } of state.markers) {
        applyQueenStyle(markerEl, cellEl.getBoundingClientRect());
      }

      state.rafId = requestAnimationFrame(tick);
    }

    state.rafId = requestAnimationFrame(tick);
  }

  function renderOverlay(cellElements, solution, gridRoot) {
    const container = document.createElement('div');
    container.id = 'queens-solver-overlay';
    document.body.appendChild(container);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'qs-dismiss';
    dismissBtn.textContent = '✕';
    dismissBtn.setAttribute('aria-label', 'Dismiss Queens Solver overlay');
    dismissBtn.addEventListener('click', dismissOverlay);
    container.appendChild(dismissBtn);

    const markers = solution.map(([row, col]) => {
      const cellEl = cellElements[row][col];
      const markerEl = document.createElement('div');
      markerEl.className = 'qs-queen';
      markerEl.textContent = '♛'; // ♛
      container.appendChild(markerEl);
      return { cellEl, markerEl };
    });

    // Belt-and-suspenders alongside the rAF loop's own containment check:
    // react immediately (rather than waiting up to one frame) if the grid
    // is removed during a SPA route change.
    const observer = new MutationObserver(() => {
      if (!document.body.contains(gridRoot)) dismissOverlay();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    overlayState = { container, dismissBtn, markers, gridRoot, observer, rafId: null };
    startTrackingLoop(overlayState);
  }

  // ---------------------------------------------------------------------
  // Orchestration + message handling
  // ---------------------------------------------------------------------

  function solveAndRender() {
    if (isOverlayActive()) {
      return { ok: false, error: 'A solution overlay is already showing. Dismiss it (✕) before solving again.' };
    }

    const gridRoot = findGrid();
    if (!gridRoot) {
      return { ok: false, error: 'Could not find the Queens puzzle grid on this page.' };
    }

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) {
      return scrape;
    }

    const solution = solveQueens(scrape.board);
    if (!solution) {
      return { ok: false, error: 'No solution exists for the scraped board (solver returned null).' };
    }

    renderOverlay(scrape.cellElements, solution, gridRoot);
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'QUEENS_SOLVE') return;

    try {
      sendResponse(solveAndRender());
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : 'Unknown error.' });
    }
  });
})();
