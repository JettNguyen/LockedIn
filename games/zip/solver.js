// games/zip/solver.js
//
// Pure backtracking solver for the LinkedIn Zip puzzle. Zero DOM dependencies -
// input is plain data, output is an ordered array of {r, c} cells.
//
// Rules enforced:
// - The path starts at the cell numbered 1 and visits every cell exactly once.
// - Numbered cells (waypoints) must be visited in ascending order; you cannot
//   enter waypoint k until you have already left waypoint k-1.
// - Movement is strictly orthogonal (up / down / left / right).
//
// Pruning: after each step, a flood-fill from any remaining unvisited cell
// counts how many unvisited cells are reachable. If that count is less than
// the number of cells still to visit, the current path has cut the grid into
// disconnected pieces and can never cover all cells - so we backtrack early
// instead of exploring a hopeless branch.

/**
 * @param {Object}             board
 * @param {number}             board.size      - grid is size × size.
 * @param {Map<string,number>} board.waypoints - "row,col" → waypoint number
 *   (1 = start; numbers are consecutive integers starting at 1).
 * @returns {{r:number, c:number}[]|null} ordered path (visit order), or null.
 */
function solveZip(board) {
  const { size: n, waypoints } = board;
  const total = n * n;

  // Locate the starting cell (waypoint 1).
  let startR = -1, startC = -1;
  for (const [k, num] of waypoints) {
    if (num === 1) {
      const parts = k.split(',');
      startR = Number(parts[0]);
      startC = Number(parts[1]);
      break;
    }
  }
  if (startR === -1) return null; // no starting cell found

  const visited = Array.from({ length: n }, () => new Array(n).fill(false));
  const path = [];
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  function key(r, c) { return `${r},${c}`; }

  // Flood-fill from (fr, fc) and count unvisited cells reachable from it.
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
        seen.add(k);
        stack.push([nr, nc]);
        count++;
      }
    }
    return count;
  }

  function dfs(r, c, nextRequired) {
    visited[r][c] = true;
    path.push({ r, c });

    if (path.length === total) return true; // complete Hamiltonian path found

    // Connectivity pruning: find any unvisited cell and check that all
    // remaining unvisited cells are reachable from it (one connected component).
    // If any are cut off by the path we just extended, backtrack now.
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

      const wp = waypoints.get(key(nr, nc));
      // Numbered cells may only be entered when they are the next required stop.
      if (wp !== undefined && wp !== nextRequired) continue;

      if (dfs(nr, nc, wp !== undefined ? nextRequired + 1 : nextRequired)) return true;
    }

    visited[r][c] = false;
    path.pop();
    return false;
  }

  return dfs(startR, startC, 2) ? path : null;
}
