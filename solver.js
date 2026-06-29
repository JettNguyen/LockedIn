// solver.js
//
// Pure backtracking solver for the LinkedIn Queens puzzle. This file has
// zero DOM dependencies on purpose so it can be loaded standalone (e.g.
// pasted into a console) and unit-tested without a browser page.

/**
 * @param {number[][]} board - board[row][col] = regionId (any integer; ids
 *   don't need to be contiguous, only "same id => same region").
 * @returns {Array<[number, number]>|null} one valid queen placement as a
 *   list of [row, col] pairs (one per row, in row order), or null if the
 *   board has no solution.
 */
function solveQueens(board) {
  const n = board.length;
  if (n === 0) return [];

  const queens = []; // placed so far; queens[i] corresponds to row i
  const usedCols = new Set();
  const usedRegions = new Set();

  function touchesAnyQueen(row, col) {
    // Queens are placed one per row in increasing row order, so the only
    // previously-placed queen that could ever be within Chebyshev distance 1
    // is the one in row - 1. We still scan all placed queens for clarity;
    // n is small (<=10) so this is cheap.
    for (const [qr, qc] of queens) {
      if (Math.abs(qr - row) <= 1 && Math.abs(qc - col) <= 1) return true;
    }
    return false;
  }

  function backtrack(row) {
    if (row === n) return true;

    for (let col = 0; col < n; col++) {
      if (usedCols.has(col)) continue;

      const region = board[row][col];
      if (usedRegions.has(region)) continue;

      if (touchesAnyQueen(row, col)) continue;

      queens.push([row, col]);
      usedCols.add(col);
      usedRegions.add(region);

      if (backtrack(row + 1)) return true;

      queens.pop();
      usedCols.delete(col);
      usedRegions.delete(region);
    }

    return false;
  }

  return backtrack(0) ? queens.slice() : null;
}

// Note on "exporting": content scripts listed together in manifest.json's
// content_scripts.js array execute in the same isolated-world global scope,
// in array order. So this top-level function declaration is already visible
// to content.js (loaded right after it) - no module system needed, and
// `export`/`module.exports` would throw since this loads as a classic
// script, not an ES module.
