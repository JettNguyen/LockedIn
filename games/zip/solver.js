// games/zip/solver.js
//
// Backtracking Hamiltonian-path solver for LinkedIn Zip.
// Walls (scraped from the DOM by game.js) block specific moves. Both the
// main DFS and the connectivity flood-fill respect walls so the pruning
// heuristic stays accurate in puzzles with internal barriers.

/**
 * @param {Object}               board
 * @param {number}               board.size      - grid is size × size.
 * @param {Map<string,number>}   board.waypoints - "row,col" → waypoint number.
 * @param {Array<Array<{top:boolean,bottom:boolean,left:boolean,right:boolean}>>}
 *                               board.walls     - walls[r][c] for each cell.
 * @param {number} [cap] - stop once this many distinct solutions are found.
 * @param {number} [budget] - max search nodes before giving up.
 * @returns {{solutions: {r:number,c:number}[][], exhaustedBudget: boolean}}
 */
function solveZipSolutions({ size: n, waypoints, walls }, cap = 1, budget = 4000000) {
  const total = n * n;
  const solutions = [];
  let nodes = 0;
  let exhaustedBudget = false;

  // Locate waypoint 1 (start).
  let startR = -1, startC = -1;
  for (const [k, num] of waypoints) {
    if (num === 1) {
      [startR, startC] = k.split(',').map(Number);
      break;
    }
  }
  if (startR === -1) return { solutions: [], exhaustedBudget: false };

  const visited = Array.from({ length: n }, () => new Array(n).fill(false));
  const path = [];
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  function key(r, c) { return `${r},${c}`; }

  // Returns true if moving from (r,c) to (nr,nc) is not blocked by a wall.
  // We check the departing side of (r,c) AND the arriving side of (nr,nc)
  // so that walls encoded on only one of the two cells are handled correctly.
  function canMove(r, c, nr, nc) {
    const dc = nc - c, dr = nr - r;
    if (dc ===  1) return !(walls[r][c].right  || walls[nr][nc].left);
    if (dc === -1) return !(walls[r][c].left   || walls[nr][nc].right);
    if (dr ===  1) return !(walls[r][c].bottom || walls[nr][nc].top);
    if (dr === -1) return !(walls[r][c].top    || walls[nr][nc].bottom);
    return false;
  }

  // Flood-fill from (fr,fc), counting unvisited cells reachable without
  // crossing walls. Used for early pruning: if the reachable count is less
  // than the cells still left to visit, the current path has created an
  // unreachable pocket and we backtrack immediately.
  function reachableCount(fr, fc) {
    const stack = [[fr, fc]];
    const seen = new Set([key(fr, fc)]);
    let count = 1;
    while (stack.length) {
      const [r, c] = stack.pop();
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
        const k = key(nr, nc);
        if (visited[nr][nc] || seen.has(k)) continue;
        if (!canMove(r, c, nr, nc)) continue;
        seen.add(k);
        stack.push([nr, nc]);
        count++;
      }
    }
    return count;
  }

  // Returns true to mean "stop searching" - the caller's cap has been reached.
  // A plain solve passes cap=1 and so short-circuits on the first solution
  // exactly as before.
  function dfs(r, c, nextRequired) {
    visited[r][c] = true;
    path.push({ r, c });

    if (++nodes > budget) { exhaustedBudget = true; visited[r][c] = false; path.pop(); return true; }

    if (path.length === total) {
      solutions.push(path.map((cell) => ({ r: cell.r, c: cell.c })));
      visited[r][c] = false;
      path.pop();
      return solutions.length >= cap;
    }

    // Connectivity pruning.
    const remaining = total - path.length;
    let seedR = -1, seedC = -1;
    outer: for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (!visited[row][col]) { seedR = row; seedC = col; break outer; }
      }
    }
    if (seedR !== -1 && reachableCount(seedR, seedC) < remaining) {
      visited[r][c] = false;
      path.pop();
      return false;
    }

    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
      if (visited[nr][nc]) continue;
      if (!canMove(r, c, nr, nc)) continue;

      const wp = waypoints.get(key(nr, nc));
      if (wp !== undefined && wp !== nextRequired) continue;

      if (dfs(nr, nc, wp !== undefined ? nextRequired + 1 : nextRequired)) return true;
    }

    visited[r][c] = false;
    path.pop();
    return false;
  }

  dfs(startR, startC, 2);
  return { solutions, exhaustedBudget };
}

/**
 * Convenience wrapper: the single solution, or null.
 * @param {number} [cap] - stop once this many distinct solutions are found.
 * @param {number} [budget] - max search nodes before giving up.
 * @returns {{solutions: {r:number,c:number}[][], exhaustedBudget: boolean}}
 */
function solveZip(board) {
  const [solution] = solveZipSolutions(board, 1).solutions;
  return solution || null;
}
