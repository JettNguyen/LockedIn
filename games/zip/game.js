// games/zip/game.js
//
// Scraping strategy confirmed against the live LinkedIn Zip DOM. The grid root
// is [data-testid="interactive-grid"][data-trail-grid]; cells are direct
// children with data-testid="cell-N" and data-cell-idx for their position.
//
// WALLS are read by GEOMETRY - measuring the bars LinkedIn actually paints
// against the grid's own cell rects - because both of the alternatives failed
// in the same way, by silently under-reporting walls and letting the solver
// walk through them:
//
//   • The hashed CSS-module class names rotate on every deploy, and the mapping
//     here once had TWO hashes pointing at "bottom" and none at "top", so a
//     wall encoded on the lower cell landed a row too low.
//   • Measuring each cell's own children missed more: LinkedIn draws a run of
//     wall as ONE element spanning several cells, so only whichever cell
//     happened to own it got a wall, and the path crossed the rest of the run.
//
// So the scan is grid-wide (detectWallsAcrossGrid): find every thin bar drawn
// anywhere inside the grid and block each cell boundary it actually covers,
// however many cells it spans. The class names remain as a fallback for markup
// that stops looking like a bar at all (see run()).
//
// TIMING MATTERS: Zip only draws its walls while the puzzle is unsolved. Scrape
// a finished board and you get a board with no walls - which still solves, just
// to a different route, since without walls the waypoints alone don't pin down
// a unique path. run() therefore checks for a SECOND solution and refuses to
// draw when it finds one, rather than presenting an arbitrary path as the
// answer. It also means a wall count read off a completed board proves nothing
// about whether wall detection works; the debug dump labels the board state for
// exactly that reason.

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

  // Per-cell reading: hashed class names, plus a wall drawn as a one-sided
  // border on an element filling the cell (which has no bar to measure).
  function parseCellWalls(cellEl) {
    const geometric = emptyWalls();
    const byClass = emptyWalls();

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

      const side = detectWallSideByBorder(child);
      if (side) geometric[side] = true;
    }

    return { geometric, byClass };
  }

  const isCellEl = (el) => /^cell-\d+$/.test((el.dataset && el.dataset.testid) || '');

  // Walls painted on a ::before / ::after.
  //
  // This is how LinkedIn actually draws them, and it defeated every reading
  // above for the same reason: a pseudo-element is not in the DOM. It cannot be
  // returned by querySelectorAll, it has no getBoundingClientRect, and it hangs
  // off a div that only exists on cells that have a wall - so the bar scan
  // measured an empty grid and reported, honestly and uselessly, no walls at
  // all. getComputedStyle's second argument is the only way to see one.
  //
  // Confirmed against a 7x7 board where the twelve cells carrying a 12px
  // ::after border-right were exactly the twelve whose right-hand boundary was
  // walled, with border-left naming the same twelve boundaries from the far
  // side. The hashed class the pseudo hangs off is deliberately not matched on;
  // those rotate, and the border is the thing that means "wall".
  function detectPseudoWalls(cellEl, walls, minPx) {
    for (const el of [cellEl, ...cellEl.querySelectorAll('*')]) {
      for (const pseudo of ['::before', '::after']) {
        let cs;
        try {
          cs = getComputedStyle(el, pseudo);
        } catch (_) {
          continue;
        }
        // No content box means the pseudo isn't rendered, whatever it declares.
        if (!cs || !cs.content || cs.content === 'none') continue;

        const sides = [];
        for (const side of SIDES) {
          if ((parseFloat(cs[BORDER_WIDTH_PROP[side]]) || 0) >= minPx) sides.push(side);
        }
        // All four thick is a box outline rather than a wall - and a cell walled
        // in on every side could not be part of any path, so nothing is lost by
        // declining to believe it.
        if (!sides.length || sides.length === 4) continue;
        for (const side of sides) walls[side] = true;
      }
    }
  }

  // Grid-wide wall scan.
  //
  // This used to run per cell, over each cell's own children, and that is what
  // let the solver keep cutting through walls: LinkedIn draws a run of wall as
  // ONE element spanning several cells, so only whichever cell happened to own
  // that element got a wall recorded and every other cell along the run was
  // left open. A long barrier would be honoured at one point and walked
  // straight through everywhere else.
  //
  // So measure every bar drawn anywhere inside the grid against the grid's own
  // geometry, and block each cell boundary the bar actually covers - however
  // many cells it spans and whichever cell it happens to hang off.
  // Describes an element compactly enough to re-anchor a scraper against, and
  // short enough to paste: tag plus its first couple of class tokens.
  function describeEl(el) {
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
  }

  function detectWallsAcrossGrid(gridRoot, cellElements, n, walls) {
    // Returned purely for the debug dump. A bare wall COUNT can't distinguish
    // "the page draws no bars" from "it draws them and we threw them away", and
    // those need opposite fixes, so the census records every candidate and what
    // became of it.
    const report = { cellW: 0, cellH: 0, bars: [], minThickness: null, painting: [] };

    const rects = cellElements.map((row) => row.map((el) => el.getBoundingClientRect()));
    const cellW = rects[0][0].width;
    const cellH = rects[0][0].height;
    if (!(cellW > 0) || !(cellH > 0)) return report;
    const cellMin = Math.min(cellW, cellH);
    report.cellW = cellW;
    report.cellH = cellH;

    // If the page stops painting walls as their own elements - a border or a
    // shadow on the cell, a ::before - there is nothing here to measure and no
    // amount of tuning helps. Worth knowing outright rather than inferring.
    let borderCells = 0;
    let shadowCells = 0;
    for (const row of cellElements) {
      for (const el of row) {
        if (detectWallSideByBorder(el)) borderCells++;
        const shadow = getComputedStyle(el).boxShadow;
        if (shadow && shadow !== 'none') shadowCells++;
      }
    }
    if (borderCells) report.painting.push(`${borderCells} cell(s) carry a one-sided thick border of their own`);
    if (shadowCells) report.painting.push(`${shadowCells} cell(s) carry a box-shadow`);

    // Candidate bars: thin on one axis, long on the other.
    const bars = [];
    for (const el of gridRoot.querySelectorAll('*')) {
      if (isCellEl(el)) continue;
      if (el.dataset && (el.dataset.testid === 'filled-cell' || el.dataset.cellContent)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.width < cellW * 0.5 && r.height >= cellH * 0.5) bars.push({ r, el, vertical: true, thickness: r.width });
      else if (r.height < cellH * 0.5 && r.width >= cellW * 0.5) bars.push({ r, el, vertical: false, thickness: r.height });
    }
    if (!bars.length) return report;

    // Grid rules are hairlines and walls are substantial, so keep the thick
    // ones. Both an absolute floor and a share of the thickest bar, so this
    // doesn't start calling 1px rules walls on a board that has none.
    const thickest = Math.max(...bars.map((b) => b.thickness));
    const minThickness = Math.max(MIN_WALL_PX, cellMin * 0.05, thickest * 0.5);
    report.minThickness = minThickness;

    for (const bar of bars) {
      const note = {
        what: describeEl(bar.el),
        vertical: bar.vertical,
        thickness: bar.thickness,
        cells: bar.vertical ? bar.r.height / cellH : bar.r.width / cellW,
        kept: bar.thickness >= minThickness,
        blocked: 0,
      };
      report.bars.push(note);
      if (!note.kept) continue;

      if (bar.vertical) {
        const x = bar.r.left + bar.r.width / 2;
        for (let c = 0; c < n - 1; c++) {
          const boundary = (rects[0][c].right + rects[0][c + 1].left) / 2;
          if (Math.abs(x - boundary) > cellW * 0.3) continue;
          for (let r = 0; r < n; r++) {
            const overlap = Math.min(bar.r.bottom, rects[r][c].bottom) - Math.max(bar.r.top, rects[r][c].top);
            if (overlap < cellH * 0.5) continue;
            walls[r][c].right = true;
            walls[r][c + 1].left = true;
            note.blocked++;
          }
        }
      } else {
        const y = bar.r.top + bar.r.height / 2;
        for (let r = 0; r < n - 1; r++) {
          const boundary = (rects[r][0].bottom + rects[r + 1][0].top) / 2;
          if (Math.abs(y - boundary) > cellH * 0.3) continue;
          for (let c = 0; c < n; c++) {
            const overlap = Math.min(bar.r.right, rects[r][c].right) - Math.max(bar.r.left, rects[r][c].left);
            if (overlap < cellW * 0.5) continue;
            walls[r][c].bottom = true;
            walls[r + 1][c].top = true;
            note.blocked++;
          }
        }
      }
    }

    return report;
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

      const { geometric, byClass } = parseCellWalls(cellEl);
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

    // Now that every cell is known, sweep the grid for wall bars spanning more
    // than one cell — the per-cell pass above can't see those.
    // Pseudo-element borders first — this is how the walls are actually drawn.
    // The bar scan afterwards still earns its place: it catches a run of wall
    // drawn as one real element spanning several cells, which the per-cell pass
    // can't see, and the two only ever add walls, so reading both is safe.
    const cell0 = cellElements[0][0].getBoundingClientRect();
    const minWallPx = Math.max(MIN_WALL_PX, Math.min(cell0.width, cell0.height) * 0.05);
    let pseudoWalls = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        detectPseudoWalls(cellElements[r][c], wallsGeometric[r][c], minWallPx);
      }
    }
    // Mirror each wall onto the cell across the boundary. Zip paints both sides
    // of most boundaries, but not all, and a wall known from one side only is
    // still a wall.
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const w = wallsGeometric[r][c];
        for (const side of SIDES) if (w[side]) pseudoWalls++;
        if (w.right && c + 1 < n) wallsGeometric[r][c + 1].left = true;
        if (w.left && c > 0) wallsGeometric[r][c - 1].right = true;
        if (w.bottom && r + 1 < n) wallsGeometric[r + 1][c].top = true;
        if (w.top && r > 0) wallsGeometric[r - 1][c].bottom = true;
      }
    }

    const wallScan = detectWallsAcrossGrid(gridRoot, cellElements, n, wallsGeometric);
    wallScan.pseudoWalls = pseudoWalls;
    wallScan.minWallPx = minWallPx;

    if (![...waypoints.values()].includes(1)) {
      return { ok: false, error: 'Could not find the starting cell (numbered 1).' };
    }
    if (waypoints.size < 2) {
      return { ok: false, error: 'Too few numbered waypoints found on this board.' };
    }

    return { ok: true, size: n, waypoints, cellElements, wallsGeometric, wallsByClass, wallScan };
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

    // Ask for two solutions, not one. A real Zip board has exactly one, so more
    // than one means the board we scraped is missing walls that the real board
    // has - and a solver handed too few walls doesn't fail, it cheerfully
    // returns some other Hamiltonian path. That is precisely the "it goes
    // through walls" bug, and it is worth catching for a reason the board makes
    // unavoidable: the walls are only drawn while the puzzle is unsolved, so
    // any scrape taken after it's finished sees a board with no walls at all.
    // from games/zip/solver.js
    let path = null;
    let underConstrained = false;
    for (const walls of readings) {
      const { solutions, exhaustedBudget } = solveZipSolutions(
        { size: scrape.size, waypoints: scrape.waypoints, walls },
        2
      );
      if (!solutions.length) continue;
      // Running out of budget means we never finished proving uniqueness, not
      // that we found a second answer - so take the solution rather than
      // refusing over a search that was merely slow.
      if (solutions.length > 1 && !exhaustedBudget) {
        underConstrained = true;
        continue;
      }
      path = solutions[0];
      underConstrained = false;
      break;
    }

    if (!path) {
      return {
        ok: false,
        error: underConstrained
          ? 'The board as scraped has more than one solution, so some walls are missing — ' +
            "Zip only draws its walls while the puzzle is unsolved, so this is expected on a finished board."
          : 'No solution exists for the scraped board (solver returned null).',
      };
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
  // The census of bar-shaped elements behind the geometry reading. When walls
  // go missing this is the line that says which of the two very different
  // causes it is: the page never drew a bar we could see, or it did and the
  // thickness filter discarded it.
  function renderWallScan(scan) {
    if (!scan) return 'wall scan: (not run)';
    const lines = [`wall scan: cell ${scan.cellW.toFixed(0)}x${scan.cellH.toFixed(0)}px`];
    lines.push(
      `  ::before/::after borders at least ${(scan.minWallPx || 0).toFixed(1)}px: ` +
      `${scan.pseudoWalls || 0} wall side(s) — this is how the page draws them`
    );
    for (const note of scan.painting) lines.push(`  also: ${note}`);
    if (!scan.bars.length) {
      lines.push('  NO bar-shaped elements anywhere in the grid — the page is not painting walls as');
      lines.push('  elements we can measure (a pseudo-element or a gradient would look like this).');
      return lines.join('\n');
    }

    lines.push(`  kept anything at least ${scan.minThickness.toFixed(1)}px thick:`);
    const groups = new Map();
    for (const b of scan.bars) {
      const key = [b.what, b.vertical, b.thickness.toFixed(1), Math.round(b.cells), b.kept].join('|');
      const g = groups.get(key) || { ...b, count: 0, blocked: 0 };
      g.count++;
      g.blocked += b.blocked;
      groups.set(key, g);
    }
    for (const g of [...groups.values()].sort((a, b) => b.thickness - a.thickness)) {
      lines.push(
        `    ${g.thickness.toFixed(1).padStart(6)}px  ${g.vertical ? 'vertical  ' : 'horizontal'}` +
        `  spans ~${Math.round(g.cells)} cell(s)  x${g.count}  ${g.what}` +
        `  ${g.kept ? `-> blocked ${g.blocked} boundaries` : '-> DISCARDED as too thin'}`
      );
    }
    return lines.join('\n');
  }

  // Last resort, for when the bar scan finds nothing: work out how the page is
  // painting walls by looking for what makes a walled cell different.
  //
  // No assumption about the mechanism - it reads every paint-ish property, on
  // the cell, on its descendants, and on their ::before/::after (which are
  // invisible to querySelectorAll and are the obvious way to draw a wall
  // without adding an element). Whatever paints a wall must appear on the
  // handful of cells that have one and not on the rest, so anything present on
  // a MINORITY of cells is a candidate and everything universal is chrome.
  //
  // The cell list against each candidate is the proof: compare it to the walls
  // actually drawn on the board and the right property is the one that matches.
  function probeWallPainting(cellElements, n) {
    const PSEUDOS = [null, '::before', '::after'];
    const PROPS = [
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'backgroundImage', 'boxShadow', 'outlineWidth', 'width', 'height',
    ];
    const total = n * n;
    const seen = new Map(); // description → Set of "r,c"
    let svgCount = 0;
    let zeroSized = 0;

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const cell = cellElements[r][c];
        for (const el of [cell, ...cell.querySelectorAll('*')]) {
          if (el.tagName && el.tagName.toLowerCase() === 'svg') svgCount++;
          if (el !== cell) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) zeroSized++;
          }
          for (const pseudo of PSEUDOS) {
            let cs;
            try { cs = getComputedStyle(el, pseudo); } catch (_) { continue; }
            if (!cs) continue;
            // A pseudo-element with no content box isn't rendered at all.
            if (pseudo && (cs.content === 'none' || !cs.content)) continue;
            for (const prop of PROPS) {
              const value = cs[prop];
              if (!value || value === 'none' || value === '0px' || value === 'auto') continue;
              // width/height only matter when they look like a bar.
              if ((prop === 'width' || prop === 'height') && !pseudo) continue;
              const where = el === cell ? 'cell' : describeEl(el);
              const short = value.length > 48 ? `${value.slice(0, 45)}...` : value;
              const key = `${where}${pseudo || ''}  ${prop}: ${short}`;
              if (!seen.has(key)) seen.set(key, new Set());
              seen.get(key).add(`${r},${c}`);
            }
          }
        }
      }
    }

    const candidates = [...seen.entries()]
      .filter(([, cells]) => cells.size > 0 && cells.size < total * 0.6)
      .sort((a, b) => a[1].size - b[1].size);

    const lines = [
      'wall paint probe (what makes a walled cell different from a plain one):',
      `  ${seen.size} distinct paint properties across ${total} cells; ` +
      `${svgCount} <svg> inside cells; ${zeroSized} zero-sized descendants`,
    ];
    if (!candidates.length) {
      lines.push('  nothing appears on only some cells — every cell paints identically, so the');
      lines.push('  walls are not being drawn by CSS on the cells at all (canvas, or an overlay');
      lines.push('  layer outside the grid element).');
      return lines.join('\n');
    }
    lines.push('  properties present on only SOME cells (a wall must be one of these):');
    for (const [key, cells] of candidates.slice(0, 14)) {
      lines.push(`    [${String(cells.size).padStart(2)} cells] ${key}`);
      lines.push(`               at ${[...cells].slice(0, 14).join('  ')}${cells.size > 14 ? '  ...' : ''}`);
    }
    return lines.join('\n');
  }

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

    // How much of the board is already drawn on. This matters more than it
    // looks: Zip removes its walls once the puzzle is finished, so a wall count
    // taken from a completed board describes nothing and must not be read as
    // confirmation that wall detection works.
    const drawn = [].concat(...scrape.cellElements).filter(isCellDrawn).length;
    const total = scrape.size * scrape.size;
    const stateNote =
      drawn === 0 ? 'untouched — this is the reading that matters'
      : drawn >= total ? 'COMPLETED — the walls are gone from the board, so the counts below mean nothing'
      : `partly drawn (${drawn}/${total} cells)`;

    return [
      `Zip ${scrape.size}x${scrape.size} — ${scrape.waypoints.size} waypoints`,
      `board state: ${stateNote}`,
      '',
      renderWallScan(scrape.wallScan),
      // Only worth the noise when the normal reading came up empty.
      countWalls(scrape.wallsGeometric) === 0 && countWalls(scrape.wallsByClass) === 0
        ? `\n${probeWallPainting(scrape.cellElements, scrape.size)}`
        : '',
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
    diagnose: debugDump,
  });
})();
