// games/zip/game.js
//
// Scraping strategy confirmed against the live LinkedIn Zip DOM. The grid root
// is [data-testid="interactive-grid"][data-trail-grid]; cells are direct
// children with data-testid="cell-N" and data-cell-idx for their position.
//
// WALLS: a cell with a wall on one of its sides carries an extra child div
// (no data-testid, no data-cell-content) that paints the wall bar. LinkedIn
// identifies those divs only by hashed CSS-module class names, which rotate on
// every deploy - and the previous mapping here had TWO hashes pointing at
// "bottom" and nothing pointing at "top", so a wall LinkedIn encoded on the
// lower cell got recorded one row too low. The solver then walked straight
// through the real wall while dodging an imaginary one.
//
// So walls are now read by GEOMETRY: measure each candidate child against its
// cell and see which edge it hugs. That can't be fooled by a hash rotation and
// it can always tell a top wall from a bottom one. The hashed class names are
// kept purely as a fallback for the case where the wall markup stops looking
// like a bar (see run()).

(function () {
  const SIDES = ['top', 'right', 'bottom', 'left'];

  const BORDER_WIDTH_PROP = {
    top: 'borderTopWidth',
    right: 'borderRightWidth',
    bottom: 'borderBottomWidth',
    left: 'borderLeftWidth',
  };

  // Fallback only. `a1d68cc0` was previously mapped to "bottom" alongside
  // `ce74d07a`; "top" is the only side LinkedIn has no hash for here, and a
  // duplicate is what produced the off-by-one-row walls, so it's mapped to
  // "top" now. Geometry decides in practice.
  const WALL_CLASS_SIDES = [
    ['_7354ccbe', 'right'],
    ['eb4f579a', 'left'],
    ['ce74d07a', 'bottom'],
    ['a1d68cc0', 'top'],
  ];

  // Geometry thresholds, all as fractions of the cell's own size so they hold
  // at any board size / zoom level.
  const BAR_MAX_THICKNESS = 0.4; // a wall bar is thin across the edge it sits on
  const BAR_MIN_LENGTH = 0.55; // ...and spans most of that edge
  const BAR_MAX_OFFSET = 0.25; // ...and is centered on it
  const MIN_WALL_PX = 2; // 1px lines are ordinary grid rules, not walls

  function findGrid() {
    return document.querySelector('[data-testid="interactive-grid"][data-trail-grid]');
  }

  function emptyWalls() {
    return { top: false, bottom: false, left: false, right: false };
  }

  function getWaypointNumber(cellEl) {
    const label = cellEl.getAttribute('aria-label') || '';
    const match = label.match(/^Number\s+(\d+)$/i);
    return match ? Number(match[1]) : null;
  }

  // A wall painted as its own element: a thin bar lying along one edge of the
  // cell. getBoundingClientRect() includes borders, so this catches both a
  // background-filled sliver and a hairline div with a thick border.
  function detectWallSideByGeometry(cellRect, el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;

    const cw = cellRect.width;
    const ch = cellRect.height;

    // Vertical bar → left or right wall.
    if (r.width <= cw * BAR_MAX_THICKNESS && r.width >= MIN_WALL_PX && r.height >= ch * BAR_MIN_LENGTH) {
      const cx = r.left + r.width / 2;
      if (Math.abs(cx - cellRect.left) <= cw * BAR_MAX_OFFSET) return 'left';
      if (Math.abs(cx - cellRect.right) <= cw * BAR_MAX_OFFSET) return 'right';
    }

    // Horizontal bar → top or bottom wall.
    if (r.height <= ch * BAR_MAX_THICKNESS && r.height >= MIN_WALL_PX && r.width >= cw * BAR_MIN_LENGTH) {
      const cy = r.top + r.height / 2;
      if (Math.abs(cy - cellRect.top) <= ch * BAR_MAX_OFFSET) return 'top';
      if (Math.abs(cy - cellRect.bottom) <= ch * BAR_MAX_OFFSET) return 'bottom';
    }

    return null;
  }

  // A wall painted as a one-sided border on an element that covers the whole
  // cell (so it has no thin bar of its own to measure). Exactly one thick side
  // means a wall; two or more means it's just a box outline.
  function detectWallSideByBorder(el) {
    const cs = getComputedStyle(el);
    let found = null;
    for (const side of SIDES) {
      const width = parseFloat(cs[BORDER_WIDTH_PROP[side]]) || 0;
      if (width < MIN_WALL_PX) continue;
      if (found) return null;
      found = side;
    }
    return found;
  }

  // Two independent readings of one cell's walls. run() picks between them.
  function parseWalls(cellEl) {
    const geometric = emptyWalls();
    const byClass = emptyWalls();
    const cellRect = cellEl.getBoundingClientRect();
    const measurable = cellRect.width > 0 && cellRect.height > 0;

    for (const child of cellEl.children) {
      if (child.dataset.testid === 'filled-cell') continue;
      if (child.dataset.cellContent) continue;

      // getAttribute, not .className: on an SVG child that property is an
      // SVGAnimatedString and .includes() would throw, taking the whole solve
      // down with it.
      const cls = child.getAttribute('class') || '';
      for (const [hash, side] of WALL_CLASS_SIDES) {
        if (cls.includes(hash)) byClass[side] = true;
      }

      if (measurable) {
        const side = detectWallSideByGeometry(cellRect, child) || detectWallSideByBorder(child);
        if (side) geometric[side] = true;
      }
    }

    return { geometric, byClass };
  }

  function scrapeBoard(gridRoot) {
    const cellEls = Array.from(gridRoot.children).filter(
      (el) => /^cell-\d+$/.test(el.dataset.testid || '')
    );
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

    const cellElements = Array.from({ length: n }, () => new Array(n).fill(null));
    const wallsGeometric = Array.from({ length: n }, () => new Array(n).fill(null));
    const wallsByClass = Array.from({ length: n }, () => new Array(n).fill(null));
    const waypoints = new Map();

    for (const cellEl of cellEls) {
      const idx = Number(cellEl.dataset.cellIdx);
      if (!Number.isInteger(idx)) {
        return { ok: false, error: 'A cell is missing a numeric data-cell-idx.' };
      }
      const row = Math.floor(idx / n);
      const col = idx % n;
      if (row < 0 || row >= n || col < 0 || col >= n) {
        return { ok: false, error: `Cell index ${idx} doesn't fit a ${n}x${n} grid.` };
      }
      cellElements[row][col] = cellEl;

      const { geometric, byClass } = parseWalls(cellEl);
      wallsGeometric[row][col] = geometric;
      wallsByClass[row][col] = byClass;

      const wp = getWaypointNumber(cellEl);
      if (wp !== null) waypoints.set(`${row},${col}`, wp);
    }

    // Every position has to be accounted for. A gap means data-cell-idx skipped
    // or repeated a value mid-render, and reading walls off a hole would throw
    // partway through the solve instead of failing cleanly here.
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!cellElements[r][c]) {
          return { ok: false, error: `The grid is still loading — no cell rendered at row ${r + 1}, column ${c + 1}.` };
        }
      }
    }

    if (![...waypoints.values()].includes(1)) {
      return { ok: false, error: 'Could not find the starting cell (numbered 1).' };
    }
    if (waypoints.size < 2) {
      return { ok: false, error: 'Too few numbered waypoints found on this board.' };
    }

    return { ok: true, size: n, waypoints, cellElements, wallsGeometric, wallsByClass };
  }

  function isCellDrawn(cellEl) {
    return cellEl.getAttribute('aria-pressed') === 'true';
  }

  function countWalls(walls) {
    let total = 0;
    for (const row of walls) {
      for (const w of row) {
        for (const side of SIDES) if (w[side]) total++;
      }
    }
    return total;
  }

  function run() {
    const gridRoot = findGrid();
    if (!gridRoot) {
      return { ok: false, error: 'Could not find the Zip puzzle grid on this page.' };
    }

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape;

    // Try the reading that found more walls first. A *missed* wall is what
    // makes the solver cut through a barrier - it still finds a Hamiltonian
    // path, just the wrong one - so the more constrained board is the one more
    // likely to be right. Neither reading invents walls that aren't drawn, but
    // if the leading one turns out to have no solution at all we fall back
    // rather than giving up.
    const readings = [scrape.wallsGeometric, scrape.wallsByClass].sort(
      (a, b) => countWalls(b) - countWalls(a)
    );

    let path = null;
    for (const walls of readings) {
      path = solveZip({ size: scrape.size, waypoints: scrape.waypoints, walls }); // from games/zip/solver.js
      if (path) break;
    }
    if (!path) {
      return { ok: false, error: 'No solution exists for the scraped board (solver returned null).' };
    }

    const cells = path.map((cell) => scrape.cellElements[cell.r][cell.c]);
    window.LockedInOverlay.show({
      anchorEl: gridRoot,
      markers: [],
      // showEnds rings cell 1 and puts an arrowhead on the last cell. Without it
      // the solution is one unbroken green line and there is nothing to say
      // which end of it you're meant to start from - and the line was thick
      // enough to bury the "1" printed in the cell. The ring frames that number
      // instead of covering it. As you draw, the ring advances to the head of
      // the undrawn remainder, so it keeps pointing at where to carry on from.
      linePath: {
        cells,
        color: '#22c55e',
        isDrawn: isCellDrawn,
        showEnds: true,
        startColor: '#f5c542',
      },
    });
    return { ok: true };
  }

  // Prints the scraped board as ASCII with both wall readings, so a mismatch
  // between what's on screen and what we scraped is visible in one glance.
  // Run `LockedInDebug.zip()` in the console on the Zip page.
  function debugDump() {
    const gridRoot = findGrid();
    if (!gridRoot) return 'No Zip grid on this page.';
    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape.error;

    const render = (walls) => {
      const { size: n, waypoints } = scrape;
      const lines = [];
      for (let r = 0; r < n; r++) {
        let mid = '';
        let below = '';
        for (let c = 0; c < n; c++) {
          const w = walls[r][c];
          const blockedLeft = w.left || (c > 0 && walls[r][c - 1].right);
          const label = waypoints.get(`${r},${c}`);
          mid += (c === 0 ? '|' : blockedLeft ? '|' : ' ') + String(label ?? '·').padStart(2, ' ') + ' ';
          const blockedBelow = w.bottom || (r + 1 < n && walls[r + 1][c].top);
          below += r + 1 < n && blockedBelow ? ' ---' : '    ';
        }
        lines.push(mid + '|');
        if (below.trim()) lines.push(below);
      }
      return lines.join('\n');
    };

    return [
      `Zip ${scrape.size}x${scrape.size} — ${scrape.waypoints.size} waypoints`,
      `\nGeometry (${countWalls(scrape.wallsGeometric)} walls, used first):`,
      render(scrape.wallsGeometric),
      `\nHashed classes (${countWalls(scrape.wallsByClass)} walls, fallback):`,
      render(scrape.wallsByClass),
    ].join('\n');
  }

  window.LockedInDebug = window.LockedInDebug || {};
  window.LockedInDebug.zip = () => console.log(debugDump());

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id: 'zip',
    label: 'Zip',
    detect: () => window.LockedInDetect.gameDetector('zip')(),
    run,
  });
})();
