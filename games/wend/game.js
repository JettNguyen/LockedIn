// games/wend/game.js
//
// LinkedIn Wend DOM (current):
//   GRID:  [data-testid="interactive-grid"][data-trail-grid]
//          direct-child divs with data-testid="cell-N", data-cell-idx="N"
//          hole cells: data-cell-is-hole="true"
//          letter cells: single A-Z char in a descendant element
//
//   WORD COLOR: no data attribute; may be accessible via getComputedStyle
//          on the inner wrapper div (depends on LinkedIn's CSS). Treated as
//          optional — if unavailable, we fall back to the path solver below.
//
//   WORD LIST: [data-testid="wend-word-list-row-N"]
//          slot count  = [data-testid*="-slot-"] children  → word length
//          locked state: data-locked="true" when the word is solved
//
// PRIMARY STRATEGY: group cells by computed background-color.
// FALLBACK STRATEGY: backtracking path solver using word lengths when
//   computed colors are unavailable or produce the wrong group sizes.

(function () {
  // ─── DOM helpers ─────────────────────────────────────────────────────────

  function findGrid() {
    const g = document.querySelector('[data-testid="interactive-grid"][data-trail-grid]');
    if (g) return g;
    const any = document.querySelector('[data-testid="interactive-grid"]');
    if (any && document.querySelector('[data-testid^="wend-word-list-row-"]')) return any;
    return null;
  }

  function isHoleCell(el) {
    return el.dataset.cellIsHole === 'true';
  }

  function getLetter(el) {
    for (const child of el.querySelectorAll('*')) {
      const t = child.textContent.trim();
      if (/^[A-Za-z]$/.test(t)) return t.toUpperCase();
    }
    return null;
  }

  function getWordPosition(el) {
    for (const prop of el.style) {
      if (!prop.startsWith('--')) continue;
      const v = el.style.getPropertyValue(prop).trim();
      if (/^\d+$/.test(v)) return parseInt(v, 10);
    }
    return 0;
  }

  function isStartCell(el, idx) {
    return !!el.querySelector(`[data-testid="cell-${idx}-start-indicator"]`);
  }

  // ─── Color detection (best-effort) ───────────────────────────────────────

  const TRANSPARENT = 'rgba(0, 0, 0, 0)';

  function colorVal(cs, prop) {
    const v = cs[prop];
    return (v && v !== TRANSPARENT && v !== 'transparent' && v !== 'none') ? v : null;
  }

  function extractBg(el, pseudo) {
    if (!el) return null;
    const cs = window.getComputedStyle(el, pseudo || null);
    return colorVal(cs, 'backgroundColor') || colorVal(cs, 'backgroundImage') || null;
  }

  // Scan all CSS custom properties on el and return those whose value looks like
  // a colour (hex, rgb, hsl). Returns a Map of propName → value.
  function colorCustomProps(el) {
    if (!el) return new Map();
    const cs = window.getComputedStyle(el);
    const out = new Map();
    for (const prop of cs) {
      if (!prop.startsWith('--')) continue;
      const v = cs.getPropertyValue(prop).trim();
      if (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/.test(v) || /^hsl/.test(v)) {
        out.set(prop, v);
      }
    }
    return out;
  }

  // Given all letter cells, find a CSS custom property (on the cell or its
  // first child) whose value groups cells into sets matching expectedLengths.
  // Returns { propName, elType } or null.
  function findWordColorProp(cells, expectedLengths) {
    if (cells.length < 2) return null;
    const sorted = [...expectedLengths].sort((a, b) => a - b);

    for (const elType of ['self', 'inner']) {
      const getEl = (cell) => elType === 'self' ? cell.el : cell.el.firstElementChild;

      // Collect all candidate color custom props from the first few cells.
      const propSet = new Set();
      for (const cell of cells.slice(0, 3)) {
        for (const p of colorCustomProps(getEl(cell)).keys()) propSet.add(p);
      }

      for (const prop of propSet) {
        const groups = new Map();
        for (const cell of cells) {
          const el = getEl(cell);
          if (!el) continue;
          const v = window.getComputedStyle(el).getPropertyValue(prop).trim();
          if (!groups.has(v)) groups.set(v, []);
          groups.get(v).push(cell);
        }
        const lens = [...groups.values()].map((g) => g.length).sort((a, b) => a - b);
        if (JSON.stringify(lens) === JSON.stringify(sorted)) {
          return { prop, elType };
        }
      }
    }
    return null;
  }

  function getCellColorKey(cellEl) {
    // Old DOM: explicit data attribute.
    if (cellEl.dataset.cellWordColor) return cellEl.dataset.cellWordColor.toLowerCase();
    // Old DOM: inline style with a hex CSS custom property.
    for (const p of cellEl.style) {
      if (!p.startsWith('--')) continue;
      const v = cellEl.style.getPropertyValue(p).trim();
      if (/^#[0-9a-f]{3,8}$/i.test(v)) return v.toUpperCase();
    }
    // New DOM: try background-color / background-image on inner div, cell,
    // and their ::before pseudo-elements.
    return (
      extractBg(cellEl.firstElementChild) ||
      extractBg(cellEl) ||
      extractBg(cellEl.firstElementChild, '::before') ||
      extractBg(cellEl, '::before') ||
      extractBg(cellEl.firstElementChild, '::after') ||
      extractBg(cellEl, '::after') ||
      null
    );
  }

  // ─── Path utilities ───────────────────────────────────────────────────────

  function hasDistinctPositions(group) {
    const pos = group.map((c) => c.position).filter((p) => p > 0);
    return pos.length === group.length && new Set(pos).size === group.length;
  }

  // Walk the unique orthogonal chain through cells in the same group.
  // sameGroup(a, b) defaults to comparing colorKey; Strategy 1b passes a custom predicate.
  function followPath(startCell, cellsByIdx, n, sameGroup) {
    const same = sameGroup || ((a, b) => a.colorKey === b.colorKey);
    const path = [startCell];
    const visited = new Set([startCell.idx]);
    let cur = startCell;
    while (true) {
      const r = Math.floor(cur.idx / n), c = cur.idx % n;
      let next = null;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
        const ni = nr * n + nc;
        if (visited.has(ni)) continue;
        const nb = cellsByIdx.get(ni);
        if (!nb || !same(nb, cur)) continue;
        next = nb;
        break;
      }
      if (!next) break;
      visited.add(next.idx);
      path.push(next);
    }
    return path;
  }

  // ─── Word-list utilities ──────────────────────────────────────────────────

  // The word list is the only place the board says how long each word is, and
  // every length-based strategy is switched off without it - which leaves the
  // weakest guesswork in charge. So try progressively looser selectors rather
  // than giving up on the exact testid.
  const WORD_LIST_ROW_SELECTORS = [
    '[data-testid^="wend-word-list-row-"]',
    '[data-testid*="word-list-row"]',
    '[data-testid*="wend"][data-testid*="row"]',
  ];
  const SLOT_SELECTORS = ['[data-testid*="-slot-"]', '[data-testid*="slot"]'];

  function slotCount(row) {
    for (const sel of SLOT_SELECTORS) {
      const n = row.querySelectorAll(sel).length;
      if (n > 0) return n;
    }
    return 0;
  }

  function findWordListRows() {
    for (const sel of WORD_LIST_ROW_SELECTORS) {
      const rows = Array.from(document.querySelectorAll(sel)).filter((r) => slotCount(r) > 0);
      if (rows.length) return rows;
    }
    return [];
  }

  // Returns [6, 7, 9, ...] — slot count per word-list row.
  function getExpectedWordLengths() {
    return findWordListRows().map(slotCount);
  }

  // Map word length → available row elements (multiple words may share a length).
  function buildWordListRowsByLength() {
    const map = new Map();
    for (const row of findWordListRows()) {
      const len = slotCount(row);
      if (!map.has(len)) map.set(len, []);
      map.get(len).push(row);
    }
    return map;
  }

  // ─── Dictionary (lazy, optional) ──────────────────────────────────────────
  //
  // Partitioning the board into connected paths of the right *lengths* has
  // enormous numbers of solutions, and all but one of them spell gibberish -
  // which is exactly what the length-only solver below used to hand back. The
  // word list turns "any partition that fits" into "the partition where every
  // path is a word", which is very nearly always unique.
  //
  // The list itself lives in shared/wordlist.js, which caches it and resolves to
  // null if it can't be fetched - every caller here treats a missing dictionary
  // as "skip that constraint", so a failed load degrades to the old behaviour
  // instead of breaking the solve.

  function loadDictionary() {
    return window.LockedInWords.all();
  }

  // ─── Position-based reconstruction ────────────────────────────────────────
  //
  // The board does its own bookkeeping: each letter cell carries its position
  // within its word, and each word's first cell carries a start indicator. When
  // both are present this reads the answer off the page rather than inferring
  // it, so it runs before every heuristic below. Every step is verified (chain
  // of consecutive positions, orthogonally adjacent, covering each cell exactly
  // once, lengths matching the word list) because getWordPosition() picks the
  // first numeric CSS custom property it finds and that may well be something
  // else entirely - in which case a check fails and we fall through.

  function solveByPositions(cells, cellsByIdx, n, expectedLengths) {
    if (!expectedLengths.length) return null;

    const starts = cells.filter((c) => c.isStart);
    if (starts.length !== expectedLengths.length) return null;
    if (!cells.every((c) => c.position > 0)) return null;
    if (!starts.every((c) => c.position === 1)) return null;

    const used = new Set();
    const words = [];

    for (const start of starts) {
      const path = [start];
      if (used.has(start.idx)) return null;
      used.add(start.idx);

      let cur = start;
      for (;;) {
        const r = Math.floor(cur.idx / n), c = cur.idx % n;
        let next = null;
        for (const [dr, dc] of DIRS) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
          const nb = cellsByIdx.get(nr * n + nc);
          if (!nb || used.has(nb.idx) || nb.position !== cur.position + 1) continue;
          if (next) return null; // ambiguous continuation - don't guess
          next = nb;
        }
        if (!next) break;
        used.add(next.idx);
        path.push(next);
        cur = next;
      }
      words.push(path);
    }

    if (used.size !== cells.length) return null;
    const got = words.map((w) => w.length).sort((a, b) => a - b);
    const want = [...expectedLengths].sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(want)) return null;

    return words;
  }

  // ─── Backtracking path solver ─────────────────────────────────────────────
  //
  // Partitions all letter cells into connected orthogonal paths whose lengths
  // exactly match wordLengths. Works regardless of colour information.
  //
  // opts.startIdxs   - Set of cell indices the board marks as word starts. A
  //                    path must begin on one and may not pass through another.
  // opts.dictionary  - Set of real words; a completed path must spell one,
  //                    forwards or backwards (an unmarked path can be walked
  //                    from either end, so the match decides its direction).
  // opts.budget      - max path extensions before giving up, so a board these
  //                    constraints don't fit can't wedge the page.

  const PALETTE = ['#E53935', '#43A047', '#1E88E5', '#FB8C00', '#8E24AA', '#00ACC1', '#F4511E', '#6D4C41'];
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const DEFAULT_BUDGET = 2000000;

  function solveByWordLengths(allCells, cellsByIdx, n, wordLengths, opts = {}) {
    if (!wordLengths.length) return null;

    const { startIdxs = null, dictionary = null, budget = DEFAULT_BUDGET } = opts;
    // Only trust the start markers if there's exactly one per word; a partial
    // set would rule out the real answer.
    const starts = startIdxs && startIdxs.size === wordLengths.length ? startIdxs : null;
    let steps = 0;

    function availNeighbors(idx, avail) {
      const r = Math.floor(idx / n), c = idx % n;
      const out = [];
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
        const ni = nr * n + nc;
        if (avail.has(ni)) out.push(ni);
      }
      return out;
    }

    // Returns the path oriented so it reads as a word, or null if it isn't one.
    function orientAsWord(path) {
      if (!dictionary) return path;
      const letters = path.map((idx) => cellsByIdx.get(idx).letter.toLowerCase());
      if (dictionary.has(letters.join(''))) return path;
      if (dictionary.has(letters.reverse().join(''))) return [...path].reverse();
      return null;
    }

    // Sort longest word first — longest paths have the fewest valid start
    // positions, pruning the search tree most aggressively.
    const sortedLengths = [...wordLengths].sort((a, b) => b - a);
    const results = [];
    const avail = new Set(allCells.map((c) => c.idx));

    function solve(depthIdx) {
      if (depthIdx === sortedLengths.length) return avail.size === 0;

      const targetLen = sortedLengths[depthIdx];

      // Prefer starting from cells with fewest available neighbours
      // (likely path endpoints — degree-1 cells MUST be path endpoints).
      let candidates = [...avail].sort(
        (a, b) => availNeighbors(a, avail).length - availNeighbors(b, avail).length
      );
      if (starts) candidates = candidates.filter((idx) => starts.has(idx));

      for (const startIdx of candidates) {
        const path = [startIdx];
        avail.delete(startIdx);

        function extend() {
          if (++steps > budget) throw new RangeError('wend-budget');
          if (path.length === targetLen) {
            const oriented = orientAsWord(path);
            if (!oriented) return false;
            results.push(oriented);
            if (solve(depthIdx + 1)) return true;
            results.pop();
            return false;
          }
          const last = path[path.length - 1];
          for (const next of availNeighbors(last, avail)) {
            if (starts && starts.has(next)) continue; // a start cell only ever begins a word
            path.push(next);
            avail.delete(next);
            if (extend()) return true;
            path.pop();
            avail.add(next);
          }
          return false;
        }

        if (extend()) return true;
        avail.add(startIdx);
      }

      return false;
    }

    try {
      if (!solve(0)) return null;
    } catch (err) {
      if (err instanceof RangeError && err.message === 'wend-budget') return null;
      throw err;
    }
    return results.map((idxList) => idxList.map((idx) => cellsByIdx.get(idx)));
  }

  // ─── Board scraping ───────────────────────────────────────────────────────

  function scrapeBoard(gridRoot, dictionary) {
    let cellEls = Array.from(gridRoot.children).filter(
      (el) => /^cell-\d+$/.test(el.dataset.testid || '')
    );
    if (!cellEls.length) {
      cellEls = Array.from(gridRoot.querySelectorAll('[data-testid]')).filter(
        (el) => /^cell-\d+$/.test(el.dataset.testid || '')
      );
    }
    if (!cellEls.length) return { ok: false, error: 'Found the Wend grid but no cells inside it.' };

    const n = Math.round(Math.sqrt(cellEls.length));
    if (n * n !== cellEls.length) {
      return { ok: false, error: `Cell count (${cellEls.length}) is not a perfect square.` };
    }

    const cells = [];
    const cellsByIdx = new Map();

    for (const cellEl of cellEls) {
      const idx = Number(cellEl.dataset.cellIdx);
      if (isHoleCell(cellEl)) continue;
      const letter = getLetter(cellEl);
      if (!letter) continue;                     // skip non-letter cells only

      const colorKey  = getCellColorKey(cellEl); // null is OK — handled below
      const position  = getWordPosition(cellEl);
      const start     = isStartCell(cellEl, idx);
      const cell      = { idx, el: cellEl, letter, colorKey, position, isStart: start };
      cells.push(cell);
      cellsByIdx.set(idx, cell);
    }

    if (!cells.length) return { ok: false, error: 'No letter cells found on this Wend board.' };

    const expectedLengths = getExpectedWordLengths();
    let words = null;

    // Whatever produced a grouping, it only counts if it could actually be a set
    // of Wend words: each one a chain of orthogonally-adjacent cells, together
    // covering every letter exactly once. Checking the shape of the answer
    // rather than trusting the strategy that made it is what stops a plausible-
    // looking-but-impossible grouping reaching the screen - a path that teleports
    // across the board is not a word, whichever code path proposed it.
    const isUsable = (candidate) => {
      if (!candidate || !candidate.length) return false;

      const seen = new Set();
      for (const { cells: group } of candidate) {
        if (group.length < 2) return false;
        for (let i = 0; i < group.length; i++) {
          if (seen.has(group[i].idx)) return false; // two words claiming one cell
          seen.add(group[i].idx);
          if (i === 0) continue;
          const a = group[i - 1].idx;
          const b = group[i].idx;
          const step = Math.abs(Math.floor(a / n) - Math.floor(b / n)) + Math.abs((a % n) - (b % n));
          if (step !== 1) return false; // not a step to a neighbouring cell
        }
      }
      if (seen.size !== cells.length) return false; // letters left over

      if (expectedLengths.length) {
        const got = candidate.map((w) => w.cells.length).sort((x, y) => x - y);
        const want = [...expectedLengths].sort((x, y) => x - y);
        if (JSON.stringify(got) !== JSON.stringify(want)) return false;
      }
      return true;
    };

    // ── Strategy 0: the board's own position numbering ───────────────────
    // Exact when it applies, so it goes first.
    {
      const byPosition = solveByPositions(cells, cellsByIdx, n, expectedLengths);
      if (byPosition) {
        words = byPosition.map((group, i) => ({ color: PALETTE[i % PALETTE.length], cells: group }));
      }
    }

    if (!isUsable(words)) words = null;

    // ── Strategy 1: colour grouping ──────────────────────────────────────
    if (!words && cells.some((c) => c.colorKey !== null)) {
      const groups = new Map();
      for (const cell of cells) {
        const key = cell.colorKey ?? '__none__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(cell);
      }

      // Validate group sizes match expected word lengths.
      const groupLens    = [...groups.values()].map((g) => g.length).sort((a, b) => a - b);
      const expectedSort = [...expectedLengths].sort((a, b) => a - b);
      const valid = !expectedLengths.length ||
                    JSON.stringify(groupLens) === JSON.stringify(expectedSort);

      if (valid) {
        words = [];
        let pi = 0;
        for (const [colorKey, group] of groups) {
          let ordered;
          if (hasDistinctPositions(group)) {
            ordered = [...group].sort((a, b) => a.position - b.position);
          } else {
            const startCell = group.find((c) => c.isStart)
              || group.reduce((m, c) => c.idx < m.idx ? c : m, group[0]);
            ordered = followPath(startCell, cellsByIdx, n);
            if (ordered.length !== group.length) ordered = [...group].sort((a, b) => a.idx - b.idx);
          }
          // If the key looks like an rgb() string, use it directly; else use palette.
          const color = (colorKey.startsWith('rgb') || colorKey.startsWith('#'))
            ? colorKey : PALETTE[pi % PALETTE.length];
          words.push({ color, cells: ordered });
          pi++;
        }
      }
    }

    if (!isUsable(words)) words = null;

    // ── Strategy 1b: CSS custom property scan ────────────────────────────
    // The word colour may be encoded in a CSS custom property (--xxxx: #color)
    // set by the cell's class and inherited by child elements. We scan all
    // colour-like custom props on the first few cells, then check which one
    // produces the right group sizes across all cells.
    if (!words && expectedLengths.length) {
      const found = findWordColorProp(cells, expectedLengths);
      if (found) {
        const { prop, elType } = found;
        const groups = new Map();
        for (const cell of cells) {
          const el = elType === 'self' ? cell.el : cell.el.firstElementChild;
          const v = el ? window.getComputedStyle(el).getPropertyValue(prop).trim() : '__none__';
          if (!groups.has(v)) groups.set(v, []);
          groups.get(v).push(cell);
        }
        words = [];
        let pi = 0;
        for (const [colorVal, group] of groups) {
          const startCell = group.find((c) => c.isStart)
            || group.reduce((m, c) => c.idx < m.idx ? c : m, group[0]);
          let ordered = followPath(startCell, cellsByIdx, n, (a, b) => {
            const elA = elType === 'self' ? a.el : a.el.firstElementChild;
            const elB = elType === 'self' ? b.el : b.el.firstElementChild;
            if (!elA || !elB) return false;
            return window.getComputedStyle(elA).getPropertyValue(prop).trim() ===
                   window.getComputedStyle(elB).getPropertyValue(prop).trim();
          });
          if (ordered.length !== group.length) ordered = [...group].sort((a, b) => a.idx - b.idx);
          const color = /^#[0-9a-f]{3,8}$/i.test(colorVal) || /^rgba?\(/.test(colorVal)
            ? colorVal : PALETTE[pi % PALETTE.length];
          words.push({ color, cells: ordered });
          pi++;
        }
      }
    }

    if (!isUsable(words)) words = null;

    // ── Strategy 2: backtracking solver ──────────────────────────────────
    // Length alone leaves a huge number of valid partitions and picks an
    // arbitrary one, which is how this ended up drawing paths that spelled
    // nothing. So try the constrained forms first and only fall back to the
    // bare length partition - still the best guess available - if the board
    // gives us nothing to constrain it with.
    if (!words && expectedLengths.length) {
      const startIdxs = new Set(cells.filter((c) => c.isStart).map((c) => c.idx));
      const attempts = [];
      if (dictionary && startIdxs.size) attempts.push({ startIdxs, dictionary });
      if (dictionary) attempts.push({ dictionary });
      if (startIdxs.size) attempts.push({ startIdxs });
      attempts.push({}); // last resort: any partition with the right lengths

      for (const opts of attempts) {
        const solved = solveByWordLengths(cells, cellsByIdx, n, expectedLengths, opts);
        if (solved) {
          words = solved.map((group, i) => ({ color: PALETTE[i % PALETTE.length], cells: group }));
          break;
        }
      }
    }

    if (!isUsable(words)) words = null;

    // There used to be a "last resort" here that lumped every letter on the
    // board into one group. It didn't show the grid, it drew a single line
    // through all 30-odd letters in scrape order - jumping diagonally across
    // the board wherever the row index wrapped, since cells in index order
    // aren't neighbours. Better to admit we couldn't read the board.
    if (!words) {
      return {
        ok: false,
        error: 'Could not work out which letters belong to which word on this board.',
      };
    }

    return { ok: true, words };
  }

  // ─── Overlay rendering ────────────────────────────────────────────────────

  async function run() {
    const gridRoot = findGrid();
    if (!gridRoot) return { ok: false, error: 'Could not find the Wend puzzle grid on this page.' };

    // Optional: null just means the word-shape constraint gets skipped.
    const dictionary = await loadDictionary();

    const scrape = scrapeBoard(gridRoot, dictionary);
    if (!scrape.ok) return scrape;

    const rowsByLength   = buildWordListRowsByLength();
    const wordRowEls     = scrape.words.map(({ cells }) => {
      const avail = rowsByLength.get(cells.length);
      return (avail && avail.length) ? avail.shift() : null;
    });
    const boardSolved    = wordRowEls.every((r) => r && r.dataset.locked === 'true');

    const linePaths = [];

    for (let wi = 0; wi < scrape.words.length; wi++) {
      const { color, cells } = scrape.words[wi];
      const rowEl = wordRowEls[wi];
      const isWordSolved = boardSolved
        ? () => false
        : () => rowEl ? rowEl.dataset.locked === 'true' : false;

      // No cell markers. This used to drop a solid block of colour on the first
      // cell and a wash on the last, which marked the ends by covering up the
      // two letters you most need to read. The ring and arrowhead on the line
      // carry the same information around the letters instead of over them, and
      // the line itself is thin and in the word's own colour rather than a fat
      // white bar - so you can still read the board through the solution.
      linePaths.push({
        cells:      cells.map((c) => c.el),
        color,
        isDrawn:    isWordSolved,
        widthRatio: 0.14,
        opacity:    0.8,
        showEnds:   true,
      });
    }

    window.LockedInOverlay.show({ anchorEl: gridRoot, markers: [], linePaths });
    return { ok: true };
  }

  // Reports which of the board's signals are actually present and what each
  // strategy makes of them, so a wrong answer can be traced to the layer that
  // produced it. Run `LockedInDebug.wend()` in the console on the Wend page.
  async function debugDump() {
    const gridRoot = findGrid();
    if (!gridRoot) return 'No Wend grid on this page.';
    const dictionary = await loadDictionary();
    const lengths = getExpectedWordLengths();
    const scrape = scrapeBoard(gridRoot, dictionary);
    if (!scrape.ok) {
      return [
        `word-list rows found: ${findWordListRows().length}`,
        `expected word lengths: [${lengths.join(', ')}]  ${lengths.length ? '' : '<- EMPTY: every length-based strategy is disabled'}`,
        `scrape failed: ${scrape.error}`,
      ].join('\n');
    }

    const words = scrape.words.map(({ cells }) => cells.map((c) => c.letter).join(''));
    return [
      `word-list rows found: ${findWordListRows().length}`,
      `expected word lengths: [${lengths.join(', ')}]`,
      `dictionary: ${dictionary ? `${dictionary.size} words` : 'FAILED TO LOAD'}`,
      `words found: ${words.join(', ')}`,
      `all in dictionary: ${dictionary ? words.every((w) => dictionary.has(w.toLowerCase())) : 'n/a'}`,
    ].join('\n');
  }

  window.LockedInDebug = window.LockedInDebug || {};
  window.LockedInDebug.wend = () => debugDump().then((text) => console.log(text));

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id:     'wend',
    label:  'Wend',
    detect: () => window.LockedInDetect.gameDetector('wend')(),
    run,
  });
})();
