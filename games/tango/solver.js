// games/tango/solver.js
//
// Pure backtracking solver for the LinkedIn Tango puzzle. Zero DOM
// dependencies - input is plain data, output is a plain 2D array.
//
// Rules enforced: each row/column has exactly size/2 Suns and size/2 Moons,
// no run of 3+ identical symbols in a row or column, every given (pre-filled)
// cell keeps its value, and every 'eq'/'neq' edge constraint between two
// adjacent cells is satisfied.

/**
 * @param {Object} board
 * @param {number} board.size - grid is size x size (must be even).
 * @param {Map<string, 0|1>} board.given - pre-filled cells, keyed by
 *   "row,col" (e.g. "0,3"), value 0 = Sun, 1 = Moon.
 * @param {Array<{r1:number,c1:number,r2:number,c2:number,type:'eq'|'neq'}>} board.constraints
 *   each pair must be orthogonally adjacent; 'eq' = same symbol, 'neq' =
 *   different symbols.
 * @returns {(0|1)[][]|null} the fully solved grid, or null if unsolvable.
 */
function solveTango(board) {
  const { size: n, given, constraints } = board;
  if (n % 2 !== 0) return null; // can't split n cells evenly between Sun/Moon

  const half = n / 2;
  const grid = Array.from({ length: n }, () => new Array(n).fill(-1));
  const rowCount = Array.from({ length: n }, () => [0, 0]);
  const colCount = Array.from({ length: n }, () => [0, 0]);

  function key(r, c) {
    return `${r},${c}`;
  }

  // adjacency.get("r,c") -> [{ r, c, type }] for the OTHER cell in each
  // constraint touching (r, c). Built both directions so a lookup from
  // either side of a pair works.
  const adjacency = new Map();
  function addAdjacency(r1, c1, r2, c2, type) {
    const k = key(r1, c1);
    if (!adjacency.has(k)) adjacency.set(k, []);
    adjacency.get(k).push({ r: r2, c: c2, type });
  }
  for (const { r1, c1, r2, c2, type } of constraints) {
    addAdjacency(r1, c1, r2, c2, type);
    addAdjacency(r2, c2, r1, c1, type);
  }

  function violatesConstraints(r, c, v) {
    for (const { r: nr, c: nc, type } of adjacency.get(key(r, c)) || []) {
      const neighborVal = grid[nr][nc];
      if (neighborVal === -1) continue; // not placed yet; checked from its own side later
      if (type === 'eq' && neighborVal !== v) return true;
      if (type === 'neq' && neighborVal === v) return true;
    }
    return false;
  }

  function violatesRun(r, c, v) {
    if (c >= 2 && grid[r][c - 1] === v && grid[r][c - 2] === v) return true;
    if (r >= 2 && grid[r - 1][c] === v && grid[r - 2][c] === v) return true;
    return false;
  }

  function backtrack(pos) {
    if (pos === n * n) return true;

    const r = Math.floor(pos / n);
    const c = pos % n;
    const forced = given.get(key(r, c));
    const candidates = forced !== undefined ? [forced] : [0, 1];

    for (const v of candidates) {
      if (rowCount[r][v] >= half || colCount[c][v] >= half) continue;
      if (violatesRun(r, c, v)) continue;
      if (violatesConstraints(r, c, v)) continue;

      grid[r][c] = v;
      rowCount[r][v]++;
      colCount[c][v]++;

      if (backtrack(pos + 1)) return true;

      grid[r][c] = -1;
      rowCount[r][v]--;
      colCount[c][v]--;
    }

    return false;
  }

  return backtrack(0) ? grid : null;
}
