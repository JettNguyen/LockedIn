// games/crossclimb/game.js
//
// Scraping strategy for the LinkedIn CrossClimb DOM.
//
// BOARD: `.crossclimb__grid` contains rungs with data-guess-id 0-6.
//   id=0: locked top rung (has disabled inputs on a solved board, otherwise just an icon)
//   id=1-5: middle fillable rungs (data-sortable-item="true"), draggable
//   id=6: locked bottom rung
//
// CLUES: each rung's clue lives in a <p id="crossclimb-clue-section-N"> where N
// matches data-guess-id. LinkedIn renders all of these in the DOM simultaneously;
// the nav arrows in the sticky clue section just scroll between them.
//
// SOLVING: uses Chrome's built-in Prompt API (Gemini Nano) to interpret each
// clue as a 4-letter word, then finds the permutation of those words that forms
// a valid word ladder (each adjacent pair differs by exactly 1 letter, and the
// first/last word each differ by 1 from the locked top/bottom rungs when known).
//
// OVERLAY: each middle rung's left drag handle gets a numbered badge showing
// its target position (1=top) and the AI-solved word. Badges fade once the
// user drags that row into the correct slot.

(function () {
  // ── DOM helpers ────────────────────────────────────────────────────────────

  function findGrid() {
    return document.querySelector('.crossclimb__grid');
  }

  // Read the 4-letter word from a rung's inputs. Returns null if any are empty.
  function readWord(rowEl) {
    const inputs = rowEl.querySelectorAll('input[data-crossclimb-guess-input-idx]');
    if (inputs.length !== 4) return null;
    let word = '';
    for (const input of inputs) {
      const ch = (input.value || '').trim().toUpperCase();
      if (!ch) return null;
      word += ch;
    }
    return word;
  }

  function scrapeBoard(grid) {
    const allRows = Array.from(grid.querySelectorAll('[data-guess-id]'));
    if (!allRows.length) {
      return { ok: false, error: 'Found the CrossClimb grid but no rungs inside it.' };
    }

    const rows = allRows.map((rowEl) => {
      const id = Number(rowEl.dataset.guessId);
      const boxes = Array.from(rowEl.querySelectorAll('.crossclimb__guess_box'));
      const dragger =
        rowEl.querySelector('.crossclimb__guess-dragger.crossclimb__guess-dragger__left') ||
        rowEl.querySelector('.crossclimb__guess-dragger');
      const word = readWord(rowEl);
      return { id, word, rowEl, boxes, dragger };
    });

    rows.sort((a, b) => a.id - b.id);
    return { ok: true, rows };
  }

  // Collect the clue text for each middle rung (ids 1-5).
  // LinkedIn only renders one clue at a time via a carousel. We click each
  // rung row directly to focus it (which updates the clue display), then fall
  // back to nav-button navigation if clicking rows doesn't work.
  async function gatherClues(middleRows) {
    // Fast path: all clue elements happen to already be in the DOM.
    const directClues = middleRows.map((row) => {
      const el = document.getElementById(`crossclimb-clue-section-${row.id}`);
      return el ? el.textContent.trim() : null;
    });
    if (directClues.every((c) => c)) return directClues;

    const clueMap = new Map(); // rung id (number) → clue text

    function getClueEl() { return document.querySelector('.crossclimb__clue'); }

    function readCurrentClue() {
      const p = getClueEl();
      if (!p) return null;
      const m = (p.id || '').match(/crossclimb-clue-section-(\d+)/);
      if (!m) return null;
      clueMap.set(Number(m[1]), p.textContent.trim());
      return Number(m[1]);
    }

    // Wait until the displayed clue ID changes from `fromId` (or until timeout).
    async function waitForChange(fromId, timeout = 600) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
        const p = getClueEl();
        if (p) {
          const m = (p.id || '').match(/crossclimb-clue-section-(\d+)/);
          if (m && Number(m[1]) !== fromId) return;
        }
      }
    }

    // Primary strategy: click each rung row to focus it, which should update
    // the clue display to show that rung's clue.
    for (const row of middleRows) {
      const prevId = readCurrentClue();
      row.rowEl.click();
      await waitForChange(prevId);
      readCurrentClue();
    }

    // If clicking rows didn't get everything, fall back to nav buttons.
    if (!middleRows.every((row) => clueMap.has(row.id))) {
      const getPrev = () => document.querySelector('[aria-label="Go to previous row"]');
      const getNext = () => document.querySelector('[aria-label="Go to next row"]');

      // Step back to the first rung.
      for (let i = 0; i < 10; i++) {
        const btn = getPrev();
        if (!btn || btn.disabled) break;
        const prevId = readCurrentClue();
        btn.click();
        await waitForChange(prevId);
        readCurrentClue();
      }

      // Sweep forward through all rungs.
      for (let i = 0; i < 10; i++) {
        const btn = getNext();
        if (!btn || btn.disabled) break;
        const prevId = readCurrentClue();
        btn.click();
        await waitForChange(prevId);
        readCurrentClue();
      }
    }

    return middleRows.map((row) => clueMap.get(row.id) || null);
  }

  // ── Word ladder logic ──────────────────────────────────────────────────────

  function hammingDiff(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diff++;
    }
    return diff;
  }

  // Backtracking: find all permutations of `words` where each adjacent pair
  // differs by exactly 1 letter, optionally constrained by topWord / bottomWord.
  function findValidOrderings(words, topWord, bottomWord) {
    const n = words.length;
    const results = [];

    const dist = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => hammingDiff(words[i], words[j]))
    );

    const used = new Array(n).fill(false);
    const perm = [];

    function bt() {
      const pos = perm.length;
      if (pos === n) {
        if (bottomWord && hammingDiff(words[perm[n - 1]], bottomWord) !== 1) return;
        results.push(perm.slice());
        return;
      }
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        if (pos > 0 && dist[perm[pos - 1]][i] !== 1) continue;
        if (pos === 0 && topWord && hammingDiff(topWord, words[i]) !== 1) continue;
        used[i] = true;
        perm.push(i);
        bt();
        perm.pop();
        used[i] = false;
      }
    }

    bt();
    return results;
  }

  // ── Position tracking ──────────────────────────────────────────────────────

  function currentPositionOf(rowEl) {
    const list = rowEl.closest('ol.crossclimb__guess__container');
    if (!list) return -1;
    const items = Array.from(list.querySelectorAll('[data-sortable-item="true"]'));
    const idx = items.indexOf(rowEl);
    return idx === -1 ? -1 : idx + 1;
  }

  // ── Marker appearance ──────────────────────────────────────────────────────

  const POSITION_COLORS = ['#f5c542', '#4caf50', '#2196f3', '#e91e63', '#9c27b0'];

  function badgeHtml(pos, word) {
    const bg = POSITION_COLORS[(pos - 1) % POSITION_COLORS.length];
    return (
      `<span style="display:flex;flex-direction:column;align-items:center;justify-content:center;` +
      `width:100%;height:100%;background:${bg};border-radius:4px;color:#fff;font-weight:700;line-height:1.2;">` +
      `<span style="font-size:0.8em;">${pos}</span>` +
      `<span style="font-size:0.55em;opacity:0.9;letter-spacing:0.04em;">${word}</span>` +
      `</span>`
    );
  }

  // ── Chrome AI bridge ──────────────────────────────────────────────────────

  // Sends clues to background.js, which runs window.ai in the page's main
  // world (where the Prompt API is available) and returns the solved words.
  function solveCluesViaBackground(clues) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'LOCKEDIN_SOLVE_AI', clues }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  // ── Entry point ────────────────────────────────────────────────────────────

  async function run() {
    const grid = findGrid();
    if (!grid) {
      return { ok: false, error: 'Could not find the CrossClimb puzzle grid on this page.' };
    }

    const scrape = scrapeBoard(grid);
    if (!scrape.ok) return scrape;

    const { rows } = scrape;
    const topRow = rows.find((r) => r.id === 0) || null;
    const bottomRow = rows.find((r) => r.id === 6) || null;
    const middleRows = rows.filter((r) => r.id > 0 && r.id < 6);

    if (middleRows.length !== 5) {
      return {
        ok: false,
        error: `Expected 5 fillable rungs but found ${middleRows.length}. Is the CrossClimb puzzle fully loaded?`,
      };
    }

    const clues = await gatherClues(middleRows);
    const missingCount = clues.filter((c) => !c).length;
    if (missingCount > 0) {
      return {
        ok: false,
        error: `Could not read ${missingCount} clue(s) from the page. Try scrolling through the rungs and solving again.`,
      };
    }

    const topWord = topRow ? topRow.word : null;
    const bottomWord = bottomRow ? bottomRow.word : null;

    // Send clues to background.js to solve via Gemini Nano in the main world.
    let aiResult;
    try {
      aiResult = await solveCluesViaBackground(clues);
    } catch (err) {
      return { ok: false, error: `Could not reach background service: ${err.message}` };
    }

    if (aiResult.error === 'NO_AI') {
      const debug = aiResult.debug ? `\n\nDiagnostic: ${aiResult.debug}` : '';
      return {
        ok: false,
        error:
          "Chrome's built-in AI (Gemini Nano) isn't available yet.\n\n" +
          'Full setup (all steps required):\n' +
          '1. chrome://flags/#prompt-api-for-gemini-nano → Enabled\n' +
          '2. chrome://flags/#optimization-guide-on-device-model → Enabled BypassPerfRequirement\n' +
          '3. Relaunch Chrome\n' +
          '4. Go to chrome://components → find "Optimization Guide On Device Model" → click Check for update\n' +
          '5. Wait for the model to download (may take several minutes)\n' +
          '6. Try Solve again' +
          debug,
      };
    }

    if (aiResult.error === 'MODEL_NOT_READY') {
      return {
        ok: false,
        error:
          "Gemini Nano is enabled but the model hasn't finished downloading yet.\n\n" +
          'To check: go to chrome://components and look for\n' +
          '"Optimization Guide On Device Model" — it should show a version number.\n\n' +
          'Try again in a few minutes.',
      };
    }

    if (aiResult.error) {
      return { ok: false, error: `Chrome AI error: ${aiResult.error}` };
    }

    const words = aiResult.words;

    const failedIdx = words.findIndex((w) => !w);
    if (failedIdx !== -1) {
      return {
        ok: false,
        error: `Chrome AI couldn't determine a 4-letter word for clue ${failedIdx + 1}:\n"${clues[failedIdx]}"`,
      };
    }

    // Find a valid word-ladder ordering.
    let orderings = findValidOrderings(words, topWord, bottomWord);
    if (orderings.length === 0 && (topWord || bottomWord)) {
      orderings = findValidOrderings(words, null, null);
    }

    if (orderings.length === 0) {
      const wordList = clues.map((c, i) => `${i + 1}. "${c}" → ${words[i]}`).join('\n');
      return {
        ok: false,
        error: `The AI's answers don't form a valid word ladder. It may have guessed one wrong:\n\n${wordList}`,
      };
    }

    const ordering = orderings[0];

    const targetPos = new Array(5).fill(0);
    for (let slot = 0; slot < 5; slot++) {
      targetPos[ordering[slot]] = slot + 1;
    }

    const markers = middleRows.map((row, rowIdx) => {
      const pos = targetPos[rowIdx];
      const anchorEl = row.dragger || (row.boxes.length > 0 ? row.boxes[0] : row.rowEl);
      return {
        cellEl: anchorEl,
        html: badgeHtml(pos, words[rowIdx]),
        color: POSITION_COLORS[(pos - 1) % POSITION_COLORS.length],
        isFilled: () => currentPositionOf(row.rowEl) === pos,
      };
    });

    window.LockedInOverlay.show({ anchorEl: grid, markers });
    return { ok: true };
  }

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id: 'crossclimb',
    label: 'CrossClimb',
    detect: () => /\/games\/crossclimb(\/|$)/.test(location.pathname),
    run,
  });
})();
