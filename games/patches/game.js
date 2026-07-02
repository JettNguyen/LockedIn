// games/patches/game.js
//
// Patches is a region-coloring puzzle. The solver strategy:
//
// 1. Detect clue cells by the presence of a child [data-shape] element rather
//    than the "in drawn region" aria-label suffix, which LinkedIn no longer
//    consistently includes.
//
// 2. Extract clue color from any CSS custom property in the inline style
//    (the obfuscated var name changes between builds), falling back to
//    border-color on inner divs for freeform clues.
//
// 3. Collect known cell→region assignments from aria-labels where LinkedIn
//    still provides "in region with clue at row R, column C". Many cells now
//    have bare labels; those are left for the solver.
//
// 4. Solve via constraint propagation + backtracking:
//    - For rect/square clues, enumerate all valid bounding-box placements.
//    - For freeform clues, enumerate all connected subsets of the given size.
//    - Propagate: apply forced placements, remove conflicts, assign cells that
//      only one clue can reach.
//    - Backtrack if propagation stalls.

(function () {
  function findGrid() {
    // Try selectors from most to least specific. LinkedIn's data-testid for
    // the outer wrapper has changed across deploys, but the inner grid always
    // carries data-testid="interactive-grid", and on the Patches page it also
    // has a data-trail-grid attribute which no other LinkedIn game uses.
    return (
      document.querySelector('[data-testid="patches-game-board"] [data-testid="interactive-grid"]') ||
      document.querySelector('[data-testid="interactive-grid"][data-trail-grid]') ||
      document.querySelector('[data-trail-grid]')
    );
  }

  // A clue cell always has a child div with a data-shape attribute.
  function isClueCellEl(cellEl) {
    return !!cellEl.querySelector('[data-shape]');
  }

  // Extract the hex color from the clue cell's inline style.
  // The CSS custom-property name is obfuscated and may change; we grab
  // whatever --xxx: #RRGGBB appears in the style attribute string.
  function extractClueColor(cellEl) {
    const styleAttr = cellEl.getAttribute('style') || '';
    const varMatch = styleAttr.match(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/);
    if (varMatch) return varMatch[2];

    // Freeform clues use inline border-color on inner divs.
    for (const div of cellEl.querySelectorAll('div[style]')) {
      const rgb = div.style.borderColor.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/);
      if (rgb) {
        return '#' + [1, 2, 3]
          .map((i) => (+rgb[i]).toString(16).padStart(2, '0'))
          .join('');
      }
    }
    return '#f5c542'; // gold fallback
  }

  function parseClueInfo(cellEl) {
    const shapeEl = cellEl.querySelector('[data-shape]');
    const ds = shapeEl ? shapeEl.getAttribute('data-shape') : '';
    const shape =
      ds === 'PatchesShapeConstraint_HORIZONTAL_RECT' ? 'wide' :
      ds === 'PatchesShapeConstraint_VERTICAL_RECT'   ? 'tall' :
      ds === 'PatchesShapeConstraint_SQUARE'           ? 'square' :
                                                         'freeform';
    const numSpan = cellEl.querySelector('[data-testid^="patches-clue-number"]');
    const count = numSpan ? parseInt(numSpan.textContent.trim(), 10) : null;
    return { shape, count: Number.isFinite(count) ? count : null };
  }

  // ── Placement generators ────────────────────────────────────────────────

  // All h×w rectangles satisfying the shape constraint that contain (r,c).
  function genRectPlacements(n, r, c, shape, count) {
    const result = [];
    for (let h = 1; h <= n; h++) {
      for (let w = 1; w <= n; w++) {
        if (shape === 'tall'   && h <= w) continue;
        if (shape === 'wide'   && w <= h) continue;
        if (shape === 'square' && h !== w) continue;
        if (count !== null && h * w !== count) continue;
        for (let r0 = Math.max(0, r - h + 1); r0 <= Math.min(n - h, r); r0++) {
          for (let c0 = Math.max(0, c - w + 1); c0 <= Math.min(n - w, c); c0++) {
            const cells = [];
            for (let dr = 0; dr < h; dr++)
              for (let dc = 0; dc < w; dc++)
                cells.push([r0 + dr, c0 + dc]);
            result.push(cells);
          }
        }
      }
    }
    return result;
  }

  // All connected subsets of exactly `count` cells that contain (r,c).
  function genFreeformPlacements(n, r, c, count) {
    if (!count) return [];
    const results = [];
    const seen = new Set();

    function dfs(cellList, cellSet) {
      if (cellList.length === count) {
        const key = [...cellSet].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          results.push(cellList.map((k) => k.split(',').map(Number)));
        }
        return;
      }
      const frontier = new Set();
      for (const k of cellSet) {
        const [cr, cc] = k.split(',').map(Number);
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = cr + dr, nc = cc + dc;
          if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
            const nk = `${nr},${nc}`;
            if (!cellSet.has(nk)) frontier.add(nk);
          }
        }
      }
      for (const nk of frontier) {
        cellSet.add(nk);
        cellList.push(nk);
        dfs(cellList, cellSet);
        cellList.pop();
        cellSet.delete(nk);
      }
    }

    dfs([`${r},${c}`], new Set([`${r},${c}`]));
    return results;
  }

  // ── Constraint propagation ──────────────────────────────────────────────

  // Returns false if a contradiction is found, true otherwise.
  // Mutates grid and placements in place.
  function propagate(grid, clues, placements, n) {
    let changed = true;
    while (changed) {
      changed = false;

      // Precompute which cells are already grid-assigned to each clue.
      // A valid placement for clue i must (a) not include any cell owned by a
      // different clue, AND (b) include every cell already assigned to clue i.
      // Without (b) the solver can accept a placement that orphans a known cell.
      const assignedForClue = clues.map((_, i) => {
        const s = new Set();
        for (let r = 0; r < n; r++)
          for (let c = 0; c < n; c++)
            if (grid[r][c] === i) s.add(`${r},${c}`);
        return s;
      });

      // Remove placements that conflict with the current grid.
      for (let i = 0; i < clues.length; i++) {
        const assigned = assignedForClue[i];
        const before = placements[i].length;
        placements[i] = placements[i].filter((cells) => {
          const cellSet = new Set(cells.map(([r, c]) => `${r},${c}`));
          // No cell in the placement may belong to a different clue.
          if (!cells.every(([r, c]) => grid[r][c] === -1 || grid[r][c] === i)) return false;
          // Every cell already assigned to this clue must appear in the placement.
          for (const k of assigned) if (!cellSet.has(k)) return false;
          return true;
        });
        if (placements[i].length === 0) return false;
        if (placements[i].length < before) changed = true;
      }

      // A clue with a single remaining placement → apply it.
      for (let i = 0; i < clues.length; i++) {
        if (placements[i].length === 1) {
          for (const [r, c] of placements[i][0]) {
            if (grid[r][c] === -1) {
              grid[r][c] = i;
              changed = true;
            } else if (grid[r][c] !== i) {
              return false;
            }
          }
        }
      }

      // Cells in the intersection of all a clue's placements must belong to it.
      for (let i = 0; i < clues.length; i++) {
        if (placements[i].length === 0) return false;
        const sets = placements[i].map(
          (cells) => new Set(cells.map(([r, c]) => `${r},${c}`))
        );
        const intersection = [...sets[0]].filter((k) => sets.every((s) => s.has(k)));
        for (const k of intersection) {
          const [r, c] = k.split(',').map(Number);
          if (grid[r][c] === -1) {
            grid[r][c] = i;
            changed = true;
          } else if (grid[r][c] !== i) {
            return false;
          }
        }
      }

      // A cell reachable by only one clue must belong to that clue.
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (grid[r][c] !== -1) continue;
          const owners = [];
          for (let i = 0; i < clues.length; i++) {
            if (placements[i].some((cells) => cells.some(([cr, cc]) => cr === r && cc === c)))
              owners.push(i);
          }
          if (owners.length === 0) return false;
          if (owners.length === 1) {
            const i = owners[0];
            const before = placements[i].length;
            placements[i] = placements[i].filter((cells) =>
              cells.some(([cr, cc]) => cr === r && cc === c)
            );
            if (placements[i].length === 0) return false;
            if (placements[i].length < before) changed = true;
          }
        }
      }
    }
    return true;
  }

  // Backtracking search. Returns a solved grid or null.
  function search(grid0, clues, placements0, n) {
    const grid = grid0.map((row) => [...row]);
    const placements = placements0.map((ps) => ps.slice());

    if (!propagate(grid, clues, placements, n)) return null;
    if (grid.every((row) => row.every((v) => v !== -1))) return grid;

    // Branch on the clue with the fewest remaining placements (> 1).
    let best = -1, bestLen = Infinity;
    for (let i = 0; i < clues.length; i++) {
      if (placements[i].length > 1 && placements[i].length < bestLen) {
        best = i;
        bestLen = placements[i].length;
      }
    }
    if (best === -1) return null;

    for (const placement of placements[best]) {
      const g2 = grid.map((row) => [...row]);
      let valid = true;
      for (const [r, c] of placement) {
        if (g2[r][c] !== -1 && g2[r][c] !== best) { valid = false; break; }
        g2[r][c] = best;
      }
      if (!valid) continue;
      const ps2 = placements.map((ps, i) => (i === best ? [placement] : ps.slice()));
      const result = search(g2, clues, ps2, n);
      if (result) return result;
    }
    return null;
  }

  // ── Scraping ────────────────────────────────────────────────────────────

  function scrapeBoard(gridRoot) {
    const cellEls = Array.from(gridRoot.children).filter(
      (el) => /^cell-\d+$/.test(el.dataset.testid || '')
    );
    if (!cellEls.length) return { ok: false, error: 'No cells found inside the grid.' };

    const total = cellEls.length;
    const n = Math.round(Math.sqrt(total));
    if (n * n !== total)
      return { ok: false, error: `Cell count (${total}) is not a perfect square.` };

    const cellElements = Array.from({ length: n }, () => new Array(n).fill(null));
    const clues = []; // { r, c, shape, count, color, cellEl }
    const clueIndexByKey = new Map(); // "r,c" → clueIdx
    const knownAssignment = new Map(); // "r,c" → clueIdx

    // First pass: identify all clue cells.
    for (const cellEl of cellEls) {
      const idx = Number(cellEl.dataset.cellIdx);
      const r = Math.floor(idx / n), c = idx % n;
      cellElements[r][c] = cellEl;

      if (isClueCellEl(cellEl)) {
        const { shape, count } = parseClueInfo(cellEl);
        const color = extractClueColor(cellEl);
        const clueIdx = clues.length;
        clues.push({ r, c, shape, count, color, cellEl });
        clueIndexByKey.set(`${r},${c}`, clueIdx);
        knownAssignment.set(`${r},${c}`, clueIdx);
      }
    }

    if (!clues.length)
      return { ok: false, error: 'No clue cells found. Are you on the Patches puzzle page?' };

    // Second pass: collect known non-clue assignments from aria-labels.
    for (const cellEl of cellEls) {
      const idx = Number(cellEl.dataset.cellIdx);
      const r = Math.floor(idx / n), c = idx % n;
      const key = `${r},${c}`;
      if (knownAssignment.has(key)) continue;
      const label = cellEl.getAttribute('aria-label') || '';
      const m = label.match(/in region with clue at row (\d+), column (\d+)/);
      if (m) {
        const clueKey = `${Number(m[1]) - 1},${Number(m[2]) - 1}`;
        const clueIdx = clueIndexByKey.get(clueKey);
        if (clueIdx !== undefined) knownAssignment.set(key, clueIdx);
      }
    }

    return { ok: true, n, cellElements, clues, knownAssignment };
  }

  // ── Solver entry point ──────────────────────────────────────────────────

  function solvePuzzle(n, clues, knownAssignment) {
    // Build initial grid from known assignments.
    const grid = Array.from({ length: n }, () => new Array(n).fill(-1));
    for (const [key, clueIdx] of knownAssignment) {
      const [r, c] = key.split(',').map(Number);
      grid[r][c] = clueIdx;
    }

    // Generate placements, filtered against the initial grid.
    const placements = clues.map(({ r, c, shape, count }, i) => {
      const raw = shape === 'freeform'
        ? genFreeformPlacements(n, r, c, count)
        : genRectPlacements(n, r, c, shape, count);
      return raw.filter((cells) => {
        if (!cells.some(([cr, cc]) => cr === r && cc === c)) return false;
        return cells.every(([cr, cc]) => grid[cr][cc] === -1 || grid[cr][cc] === i);
      });
    });

    return search(grid, clues, placements, n);
  }

  // ── Region building ─────────────────────────────────────────────────────

  function buildRegions(n, clues, solution, cellElements) {
    return clues.map(({ color }, i) => {
      const rawCells = [];
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++)
          if (solution[r][c] === i) rawCells.push([r, c]);

      const cellSet = new Set(rawCells.map(([r, c]) => `${r},${c}`));
      const cells = rawCells.map(([r, c]) => {
        const edges = [];
        if (!cellSet.has(`${r - 1},${c}`)) edges.push('top');
        if (!cellSet.has(`${r + 1},${c}`)) edges.push('bottom');
        if (!cellSet.has(`${r},${c - 1}`)) edges.push('left');
        if (!cellSet.has(`${r},${c + 1}`)) edges.push('right');
        return { cellEl: cellElements[r][c], edges };
      });

      return {
        color,
        cells,
        // Clue cells have the region's CSS color variable set from the start,
        // so checking the variable alone would make them appear "filled"
        // immediately — their fill overlay would hide and the region border
        // would look open at the clue cell. Exclude clue cells (those with a
        // [data-shape] child) from the "filled" check so their tinted fill
        // always shows alongside every other cell in the region.
        isCellFilled: (cellEl) => {
          if (cellEl.querySelector('[data-shape]')) return false;
          for (const prop of cellEl.style) {
            if (prop.startsWith('--') &&
                cellEl.style.getPropertyValue(prop).trim() === color)
              return true;
          }
          return false;
        },
      };
    });
  }

  // ── Entry point ─────────────────────────────────────────────────────────

  function run() {
    const gridRoot = findGrid();
    if (!gridRoot)
      return { ok: false, error: 'Could not find the Patches puzzle grid on this page.' };

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape;

    const { n, cellElements, clues, knownAssignment } = scrape;
    const solution = solvePuzzle(n, clues, knownAssignment);
    if (!solution)
      return { ok: false, error: 'Could not solve the puzzle — no valid assignment found.' };

    window.LockedInOverlay.show({
      anchorEl: gridRoot,
      markers: [],
      regions: buildRegions(n, clues, solution, cellElements),
    });
    return { ok: true };
  }

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id: 'patches',
    label: 'Patches',
    detect: () => /\/games\/patches(\/|$)/.test(location.pathname),
    run,
  });
})();
