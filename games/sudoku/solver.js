// games/sudoku/solver.js
//
// Pure backtracking solver for LinkedIn Mini Sudoku. Zero DOM dependencies -
// input is plain data, output is a plain 2D array. Standard Sudoku rule:
// each row, column and box contains every digit 1..size exactly once.

/**
 * Find up to `cap` distinct solutions. Asking for 2 is how game.js tells a
 * fully-scraped board (exactly one solution) from one scraped mid-render
 * before the givens landed (many solutions) - see the note there.
 *
 * @param {Object} board - see solveSudoku below.
 * @param {number} [cap] - stop searching once this many solutions are found.
 * @returns {number[][][]} zero or more solved grids.
 */
function solveSudokuSolutions(board, cap = 1) {
  const { size: n, boxOf, given } = board;
  const grid = Array.from({ length: n }, () => new Array(n).fill(0));
  const rowUsed = Array.from({ length: n }, () => new Set());
  const colUsed = Array.from({ length: n }, () => new Set());
  const boxUsed = Array.from({ length: n }, () => new Set());
  const solutions = [];

  function key(r, c) {
    return `${r},${c}`;
  }

  // Returns true to mean "stop searching" (the cap has been reached), so a
  // plain solve short-circuits on its first solution exactly as before.
  function backtrack(pos) {
    if (pos === n * n) {
      solutions.push(grid.map((row) => row.slice()));
      return solutions.length >= cap;
    }

    const r = Math.floor(pos / n);
    const c = pos % n;
    const box = boxOf[r][c];
    const forced = given.get(key(r, c));
    const candidates = forced !== undefined ? [forced] : Array.from({ length: n }, (_, i) => i + 1);

    for (const v of candidates) {
      if (rowUsed[r].has(v) || colUsed[c].has(v) || boxUsed[box].has(v)) continue;

      grid[r][c] = v;
      rowUsed[r].add(v);
      colUsed[c].add(v);
      boxUsed[box].add(v);

      const stop = backtrack(pos + 1);

      grid[r][c] = 0;
      rowUsed[r].delete(v);
      colUsed[c].delete(v);
      boxUsed[box].delete(v);

      if (stop) return true;
    }

    return false;
  }

  backtrack(0);
  return solutions;
}

/**
 * @param {Object} board
 * @param {number} board.size - grid is size x size.
 * @param {number[][]} board.boxOf - boxOf[r][c] = which box (0..size-1)
 *   cell (r, c) belongs to. Boxes don't have to be uniform rectangles, just
 *   partitions of exactly `size` cells each.
 * @param {Map<string, number>} board.given - pre-filled cells, keyed by
 *   "row,col", value is the digit 1..size.
 * @returns {number[][]|null} the fully solved grid, or null if unsolvable.
 */
function solveSudoku(board) {
  const [solution] = solveSudokuSolutions(board, 1);
  return solution || null;
}
