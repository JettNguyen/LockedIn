// games/sudoku/game.js
//
// Scraping strategy confirmed against the live LinkedIn Mini Sudoku DOM. The
// grid root is [data-sudoku-grid="true"] .sudoku-grid, sized via its own
// --rows/--cols CSS custom properties; each cell is a .sudoku-cell with a
// numeric data-cell-idx, its digit (if any) in a .sudoku-cell-content child,
// and original puzzle givens flagged with the .sudoku-cell-prefilled class
// (distinct from anything the player has typed in since - only prefilled
// cells are treated as fixed constraints, so a half-finished board scrapes
// the same as a fresh one).
//
// Box (region) membership isn't given directly per-cell anywhere in the DOM
// - it's reconstructed from .sudoku-cell-wall-right / .sudoku-cell-wall-
// bottom, which mark the actual box boundary lines (confirmed: every cell in
// rows 1 and 3 carries wall-bottom, every cell in column 2 carries
// wall-right, matching this board's real 2-row x 3-col boxes). Deriving it
// from those classes instead of hardcoding "2x3" means this keeps working
// if LinkedIn ever ships a different box shape (e.g. a 9x9 variant).
//
// VERIFY: I haven't seen the live markup for pencil/notes mode, only a class
// name hint ("sudoku-notes-grid-rows--2") that it exists. isFilled() compares
// a cell's text content against the expected solved digit as an exact
// string match, which should naturally ignore multi-digit notes scribbles,
// but double-check on a real puzzle if the overlay never marks cells as
// confirmed once you fill them in.
//
// URL confirmed as https://www.linkedin.com/games/mini-sudoku/ - detect()
// also accepts a bare /games/sudoku path since the regex cost nothing extra.
//
// LOADING: the cells of this grid render before their digits do, so a scrape
// that lands in that gap sees a legal board with too few givens - and a solver
// handed too few givens returns a perfectly valid Sudoku that has nothing to do
// with today's puzzle. run() therefore asks for two solutions and treats "more
// than one" as "still loading", which is a scrape-order-independent readiness
// test rather than a guess at how long LinkedIn takes to paint.

(function () {
  function findGrid() {
    const root = document.querySelector('[data-sudoku-grid="true"]');
    if (!root) return null;
    return root.querySelector('.sudoku-grid');
  }

  function readGridDims(gridRoot, cellCount) {
    const style = getComputedStyle(gridRoot);
    const rows = parseInt(style.getPropertyValue('--rows'), 10);
    const cols = parseInt(style.getPropertyValue('--cols'), 10);
    if (Number.isInteger(rows) && Number.isInteger(cols) && rows * cols === cellCount) {
      return { rows, cols };
    }

    // VERIFY: --rows/--cols were missing or didn't match the cell count -
    // falling back to assuming a square grid.
    const side = Math.round(Math.sqrt(cellCount));
    return side * side === cellCount ? { rows: side, cols: side } : { rows: NaN, cols: NaN };
  }

  function deriveBoxOf(cellElements, rows, cols) {
    const rowBoundaries = new Set();
    for (let r = 0; r < rows; r++) {
      const allWallBottom = Array.from({ length: cols }, (_, c) => cellElements[r][c]).every((el) =>
        el.classList.contains('sudoku-cell-wall-bottom')
      );
      if (allWallBottom) rowBoundaries.add(r);
    }

    const colBoundaries = new Set();
    for (let c = 0; c < cols; c++) {
      const allWallRight = Array.from({ length: rows }, (_, r) => cellElements[r][c]).every((el) =>
        el.classList.contains('sudoku-cell-wall-right')
      );
      if (allWallRight) colBoundaries.add(c);
    }

    const rowGroupOf = new Array(rows);
    {
      let g = 0;
      for (let r = 0; r < rows; r++) {
        rowGroupOf[r] = g;
        if (rowBoundaries.has(r)) g++;
      }
    }
    const colGroupOf = new Array(cols);
    {
      let g = 0;
      for (let c = 0; c < cols; c++) {
        colGroupOf[c] = g;
        if (colBoundaries.has(c)) g++;
      }
    }
    const numColGroups = colGroupOf[cols - 1] + 1;

    return Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => rowGroupOf[r] * numColGroups + colGroupOf[c])
    );
  }

  function scrapeBoard(gridRoot) {
    const cellEls = Array.from(gridRoot.querySelectorAll('.sudoku-cell'));
    if (cellEls.length === 0) {
      return { ok: false, error: 'Found the grid container but no cells inside it.' };
    }

    const { rows, cols } = readGridDims(gridRoot, cellEls.length);
    if (!Number.isInteger(rows) || !Number.isInteger(cols)) {
      return { ok: false, error: `Cell count (${cellEls.length}) doesn't match a readable grid size.` };
    }
    if (rows !== cols) {
      return { ok: false, error: 'Non-square Sudoku grids are not supported.' };
    }

    const cellElements = Array.from({ length: rows }, () => new Array(cols).fill(null));
    const given = new Map();

    for (const cellEl of cellEls) {
      const idx = Number(cellEl.dataset.cellIdx);
      if (!Number.isInteger(idx)) {
        return { ok: false, error: 'A cell is missing a numeric data-cell-idx.' };
      }

      const row = Math.floor(idx / cols);
      const col = idx % cols;
      if (row < 0 || row >= rows || col < 0 || col >= cols) {
        return { ok: false, error: `Cell index ${idx} doesn't fit a ${rows}x${cols} grid.` };
      }
      cellElements[row][col] = cellEl;

      if (cellEl.classList.contains('sudoku-cell-prefilled')) {
        const contentEl = cellEl.querySelector('.sudoku-cell-content');
        const text = ((contentEl && contentEl.textContent) || '').trim();
        const digit = Number(text);
        if (!Number.isInteger(digit) || digit < 1) {
          return { ok: false, error: `A prefilled cell (row ${row + 1}, column ${col + 1}) doesn't contain a readable digit.` };
        }
        given.set(`${row},${col}`, digit);
      }
    }

    // deriveBoxOf() walks every position, so a hole left by a skipped or
    // repeated data-cell-idx would throw there instead of failing cleanly here.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!cellElements[r][c]) {
          return { ok: false, error: `The grid is still loading — no cell rendered at row ${r + 1}, column ${c + 1}.` };
        }
      }
    }

    const boxOf = deriveBoxOf(cellElements, rows, cols);
    return { ok: true, size: rows, given, boxOf, cellElements };
  }

  function isCellFilled(cellEl, expectedDigit) {
    const contentEl = cellEl.querySelector('.sudoku-cell-content');
    const text = ((contentEl && contentEl.textContent) || '').trim();
    return text === String(expectedDigit);
  }

  function run() {
    const gridRoot = findGrid();
    if (!gridRoot) {
      return { ok: false, error: 'Could not find the Sudoku puzzle grid on this page.' };
    }

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape;

    // Ask for two solutions, not one. The cells of this grid render a beat
    // before their digits do, so a scrape that lands in that gap sees a valid
    // but under-constrained board - and a solver handed too few givens happily
    // returns *a* Sudoku, just not this puzzle's. More than one solution means
    // we're looking at a half-rendered board, so fail (the auto-solver will
    // retry once it settles) rather than overlay confidently wrong digits.
    // from games/sudoku/solver.js
    const solutions = solveSudokuSolutions(
      { size: scrape.size, boxOf: scrape.boxOf, given: scrape.given },
      2
    );
    if (solutions.length === 0) {
      return { ok: false, error: 'No solution exists for the scraped board (solver returned null).' };
    }
    if (solutions.length > 1) {
      return {
        ok: false,
        error: `The grid is still loading — only ${scrape.given.size} given digit(s) have rendered so far, which leaves this board with more than one solution.`,
      };
    }
    const solution = solutions[0];

    const markers = [];
    for (let r = 0; r < scrape.size; r++) {
      for (let c = 0; c < scrape.size; c++) {
        if (scrape.given.has(`${r},${c}`)) continue; // already shown on the page, no need to mark it
        const digit = solution[r][c];
        markers.push({
          cellEl: scrape.cellElements[r][c],
          glyph: String(digit),
          color: '#f5c542',
          isFilled: (cellEl) => isCellFilled(cellEl, digit),
        });
      }
    }

    window.LockedInOverlay.show({ anchorEl: gridRoot, markers });
    return { ok: true };
  }

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id: 'sudoku',
    label: 'Mini Sudoku',
    detect: () => /\/games\/(mini-)?sudoku(\/|$)/.test(location.pathname),
    run,
  });
})();
