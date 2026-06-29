// games/sudoku/solver.js
//
// Pure backtracking solver for LinkedIn Mini Sudoku. Zero DOM dependencies -
// input is plain data, output is a plain 2D array. Standard Sudoku rule:
// each row, column and box contains every digit 1..size exactly once.

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
  const { size: n, boxOf, given } = board;
  const grid = Array.from({ length: n }, () => new Array(n).fill(0));
  const rowUsed = Array.from({ length: n }, () => new Set());
  const colUsed = Array.from({ length: n }, () => new Set());
  const boxUsed = Array.from({ length: n }, () => new Set());

  function key(r, c) {
    return `${r},${c}`;
  }

  function backtrack(pos) {
    if (pos === n * n) return true;

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

      if (backtrack(pos + 1)) return true;

      grid[r][c] = 0;
      rowUsed[r].delete(v);
      colUsed[c].delete(v);
      boxUsed[box].delete(v);
    }

    return false;
  }

  return backtrack(0) ? grid : null;
}
