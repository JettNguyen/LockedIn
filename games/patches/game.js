// games/patches/game.js
//
// Scraping strategy confirmed against the live LinkedIn Patches DOM. The board
// container is [data-testid="patches-game-board"]; inside it is the standard
// [data-testid="interactive-grid"] shared with other games.
//
// Patches is a region-coloring puzzle: each region has one clue cell (colored,
// showing its size and a shape hint) and the player must determine which other
// cells belong to it.
//
// KEY INSIGHT: LinkedIn encodes the complete region assignment in every cell's
// aria-label for accessibility. Non-clue cells say "in region with clue at row
// R, column C" - which is exactly the information we need. Clue cells say
// "in drawn region". No backtracking or search required; we just read labels.
//
// Color is read from the CSS custom property --_16b442ba on the clue cell's
// inline style (e.g. style="--_16b442ba: #C49000;"). If that property is
// absent (obfuscated name changed), we fall back to parsing border-color from
// the inner clue div's inline style, which carries the same value.
//
// Overlay: we use the overlay's `regions` API (shared/overlay.js) which draws
// each region as a single connected shape - translucent fill on every cell plus
// a stroke only on the outer boundary (sides facing a different region or the
// grid edge). Internal edges between cells of the same region are never drawn,
// so each region looks like one cohesive blob rather than a grid of boxes.
//
// Adaptive behavior: per-cell fills fade as the user assigns cells (LinkedIn
// sets --_16b442ba on a cell when the user places it). The outline stays visible
// until the entire region is solved, then fades out.

(function () {
  function findGrid() {
    return document.querySelector('[data-testid="patches-game-board"] [data-testid="interactive-grid"]');
  }

  // Extract the hex color from a clue cell's inline style.
  function extractClueColor(cellEl) {
    // Primary: CSS custom property on the cell element itself.
    const fromVar = cellEl.style.getPropertyValue('--_16b442ba').trim();
    if (fromVar) return fromVar;

    // Fallback: border-color on the inner number span's parent div, which is
    // always set as a solid rgb(...) value matching the region color.
    const numberSpan = cellEl.querySelector('[data-testid^="patches-clue-number"]');
    if (numberSpan) {
      const parentDiv = numberSpan.parentElement;
      if (parentDiv) {
        const bc = parentDiv.style.borderColor;
        const m = bc && bc.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/);
        if (m) {
          return '#' + [m[1], m[2], m[3]]
            .map((v) => Number(v).toString(16).padStart(2, '0'))
            .join('');
        }
      }
    }
    return '#f5c542'; // gold fallback - should never happen on a real board
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
      return { ok: false, error: `Cell count (${cellEls.length}) is not a perfect square.` };
    }

    const cellElements = Array.from({ length: n }, () => new Array(n).fill(null));
    // "r,c" → { color: string, cellEl: Element }
    const clueCells = new Map();
    // "r,c" → "clueR,clueC"
    const cellRegion = new Map();

    // First pass: build the grid and identify clue cells.
    for (const cellEl of cellEls) {
      const idx = Number(cellEl.dataset.cellIdx);
      if (!Number.isInteger(idx)) {
        return { ok: false, error: 'A cell is missing a numeric data-cell-idx.' };
      }
      const row = Math.floor(idx / n);
      const col = idx % n;
      cellElements[row][col] = cellEl;

      const label = cellEl.getAttribute('aria-label') || '';
      if (/,\s*in drawn region$/.test(label)) {
        const color = extractClueColor(cellEl);
        const key = `${row},${col}`;
        clueCells.set(key, { color, cellEl });
        cellRegion.set(key, key);
      }
    }

    if (clueCells.size === 0) {
      return { ok: false, error: 'No region clue cells found. Are you on the Patches puzzle page?' };
    }

    // Second pass: assign non-clue cells to their regions via aria-label.
    for (const cellEl of cellEls) {
      const idx = Number(cellEl.dataset.cellIdx);
      const row = Math.floor(idx / n);
      const col = idx % n;
      const key = `${row},${col}`;
      if (cellRegion.has(key)) continue;

      const label = cellEl.getAttribute('aria-label') || '';
      const m = label.match(/in region with clue at row (\d+), column (\d+)/);
      if (!m) {
        return {
          ok: false,
          error: `Cell (row ${row + 1}, col ${col + 1}) has an unrecognized aria-label: "${label}"`,
        };
      }
      cellRegion.set(key, `${Number(m[1]) - 1},${Number(m[2]) - 1}`);
    }

    return { ok: true, size: n, cellElements, clueCells, cellRegion };
  }

  // Build the `regions` array expected by window.LockedInOverlay.show().
  // For each region: group its cells, compute which sides of each cell are on
  // the outer boundary (facing a different region or out of bounds), and
  // provide the isCellFilled check.
  function buildRegions(scrape) {
    // Group all cells by their clue key.
    const regionMap = new Map(); // clueKey → { color, rawCells: [{r,c}] }
    for (let r = 0; r < scrape.size; r++) {
      for (let c = 0; c < scrape.size; c++) {
        const key = `${r},${c}`;
        const clueKey = scrape.cellRegion.get(key);
        const clueInfo = clueKey && scrape.clueCells.get(clueKey);
        if (!clueInfo) continue;
        if (!regionMap.has(clueKey)) {
          regionMap.set(clueKey, { color: clueInfo.color, rawCells: [] });
        }
        regionMap.get(clueKey).rawCells.push({ r, c });
      }
    }

    return Array.from(regionMap.values()).map(({ color, rawCells }) => {
      // Set of "r,c" keys for quick adjacency lookup.
      const cellSet = new Set(rawCells.map(({ r, c }) => `${r},${c}`));

      const cells = rawCells.map(({ r, c }) => {
        // A side is a boundary edge when the neighbor on that side is in a
        // different region (or outside the grid altogether).
        const edges = [];
        if (!cellSet.has(`${r - 1},${c}`)) edges.push('top');
        if (!cellSet.has(`${r + 1},${c}`)) edges.push('bottom');
        if (!cellSet.has(`${r},${c - 1}`)) edges.push('left');
        if (!cellSet.has(`${r},${c + 1}`)) edges.push('right');
        return { cellEl: scrape.cellElements[r][c], edges };
      });

      // When the user assigns a cell to this region, LinkedIn sets the same
      // --_16b442ba CSS custom property on it that it uses on the clue cell.
      const expectedColor = color;
      return {
        color,
        cells,
        isCellFilled: (cellEl) =>
          cellEl.style.getPropertyValue('--_16b442ba').trim() === expectedColor,
      };
    });
  }

  function run() {
    const gridRoot = findGrid();
    if (!gridRoot) {
      return { ok: false, error: 'Could not find the Patches puzzle grid on this page.' };
    }

    const scrape = scrapeBoard(gridRoot);
    if (!scrape.ok) return scrape;

    window.LockedInOverlay.show({
      anchorEl: gridRoot,
      markers: [],
      regions: buildRegions(scrape),
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
