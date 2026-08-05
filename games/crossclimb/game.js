// games/crossclimb/game.js
//
// Scraping strategy for the LinkedIn CrossClimb DOM.
//
// BOARD: `.crossclimb__grid` contains rungs with data-guess-id 0-6.
//   id=0: locked top rung (has disabled inputs on a solved board, otherwise just an icon)
//   id=1-5: middle fillable rungs (data-sortable-item="true"), draggable
//   id=6: locked bottom rung
//
// SOLVING: purely deterministic - no AI, no clue interpretation.
//
// The clues can't be solved from the page: reading "Chowder ingredient" and
// producing CLAM needs world knowledge that isn't anywhere in the DOM. What IS
// on the page is the ladder rule, and it constrains things hard: the five rungs
// have to reorder into a chain where each neighbour differs by exactly one
// letter, every rung is a real word, and the locked top/bottom rungs extend the
// chain at each end.
//
// So this works from whatever you've typed in and reports only what those
// constraints *force*:
//   • the order of the rungs you've filled (always determined once all five are in)
//   • any rung you haven't filled whose word the chain pins down - one blank
//     is uniquely determined about 2/3 of the time (measured over random
//     ladders drawn from common words), two blanks about 1/4
//   • candidates for the locked top and bottom rungs
//
// Where the constraints leave a genuine choice, it says so rather than picking
// one. An arbitrary pick that happens to form a valid ladder is exactly the
// kind of confidently-wrong answer that's worse than no answer.
//
// OVERLAY: each middle rung's drag handle gets a numbered badge showing its
// target position (1=top) and its word. Badges fade once you drag that row into
// the right slot.

(function () {
  // A ladder longer than this would make the permutation sweep silly; LinkedIn
  // has only ever shipped 5 middle rungs.
  const MAX_SOLUTIONS = 4000;

  // ── DOM helpers ────────────────────────────────────────────────────────────

  function findGrid() {
    return document.querySelector('.crossclimb__grid');
  }

  function guessInputs(rowEl) {
    return rowEl.querySelectorAll('input[data-crossclimb-guess-input-idx]');
  }

  // Read the word from a rung's inputs. Returns null unless every box is filled.
  function readWord(rowEl) {
    const inputs = guessInputs(rowEl);
    if (!inputs.length) return null;
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
      return { id, word: readWord(rowEl), slots: guessInputs(rowEl).length, rowEl, boxes, dragger };
    });

    rows.sort((a, b) => a.id - b.id);
    return { ok: true, rows };
  }

  // ── Ladder logic ───────────────────────────────────────────────────────────

  function hammingDiff(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff;
  }

  // Adjacency over the candidate vocabulary: word → every word one letter away.
  function buildLadderGraph(vocabulary) {
    const present = new Set(vocabulary);
    const graph = new Map();
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    for (const word of vocabulary) {
      const neighbours = [];
      for (let i = 0; i < word.length; i++) {
        for (const ch of alphabet) {
          if (ch === word[i]) continue;
          const candidate = word.slice(0, i) + ch + word.slice(i + 1);
          if (present.has(candidate)) neighbours.push(candidate);
        }
      }
      graph.set(word, neighbours);
    }
    return graph;
  }

  /**
   * Enumerate every way the rungs can be ordered and filled so the result is a
   * valid ladder. `known[i]` is rung i's typed word (uppercase) or null.
   *
   * Returns { solutions, truncated }. Each solution is an array of rung indices
   * in ladder order plus the word each one holds.
   */
  function findLadders(known, graph, topWord, bottomWord) {
    const n = known.length;
    const vocabulary = [...graph.keys()];
    const solutions = [];
    let truncated = false;

    const used = new Array(n).fill(false);
    const orderIdx = [];
    const orderWord = [];

    function extend() {
      if (solutions.length >= MAX_SOLUTIONS) { truncated = true; return; }

      const pos = orderIdx.length;
      if (pos === n) {
        if (bottomWord && hammingDiff(orderWord[n - 1].toUpperCase(), bottomWord) !== 1) return;
        solutions.push({ order: orderIdx.slice(), words: orderWord.slice() });
        return;
      }

      // Which words could sit at this position? After the first rung it must be
      // a neighbour of the previous one, which is what keeps this tractable.
      const prev = pos > 0 ? orderWord[pos - 1] : null;
      const candidates = prev ? graph.get(prev) || [] : vocabulary;

      for (let rung = 0; rung < n; rung++) {
        if (used[rung]) continue;
        const fixed = known[rung] ? known[rung].toLowerCase() : null;

        for (const word of candidates) {
          if (fixed && word !== fixed) continue;
          if (orderWord.includes(word)) continue;
          if (pos === 0 && topWord && hammingDiff(word.toUpperCase(), topWord) !== 1) continue;

          used[rung] = true;
          orderIdx.push(rung);
          orderWord.push(word);
          extend();
          orderWord.pop();
          orderIdx.pop();
          used[rung] = false;

          if (solutions.length >= MAX_SOLUTIONS) { truncated = true; return; }
        }
      }
    }

    extend();
    return { solutions, truncated };
  }

  // A ladder read top-to-bottom and the same ladder read bottom-to-top are both
  // valid chains, so unless a locked end rung pins the direction down, every
  // ladder is found twice. Left alone that reads as "two possibilities" and
  // wipes out every rung's position except the middle one, which is why this
  // groups a ladder with its mirror image and treats the pair as one answer.
  function groupByReversal(solutions) {
    const groups = new Map();
    for (const solution of solutions) {
      const forward = solution.words.join(' ');
      const backward = [...solution.words].reverse().join(' ');
      const key = forward < backward ? forward : backward;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(solution);
    }
    return [...groups.values()];
  }

  // Of a ladder's two orientations, take the one closer to how the rungs are
  // already arranged on screen - fewest drags to get there, and no worse than a
  // coin flip when the board can't say.
  function pickOrientation(variants, middleRows) {
    let best = variants[0];
    let bestCost = Infinity;
    for (const variant of variants) {
      let cost = 0;
      for (let slot = 0; slot < variant.order.length; slot++) {
        const current = currentPositionOf(middleRows[variant.order[slot]].rowEl);
        cost += current === -1 ? 0 : Math.abs(current - (slot + 1));
      }
      if (cost < bestCost) { bestCost = cost; best = variant; }
    }
    return best;
  }

  // Collapse the solution set down to what every solution agrees on. A rung's
  // position or word is only reported when nothing else was possible.
  function consensusOf(solutions, rungCount) {
    const position = new Array(rungCount).fill(null);
    const word = new Array(rungCount).fill(null);

    for (let rung = 0; rung < rungCount; rung++) {
      const positions = new Set();
      const words = new Set();
      for (const solution of solutions) {
        const slot = solution.order.indexOf(rung);
        positions.add(slot);
        words.add(solution.words[slot]);
      }
      if (positions.size === 1) position[rung] = [...positions][0] + 1;
      if (words.size === 1) word[rung] = [...words][0].toUpperCase();
    }

    return { position, word };
  }

  // The distinct answers the board allows, mirror images already merged.
  function distinctLadders(solutions, middleRows) {
    const groups = groupByReversal(solutions);
    return groups.map((variants) => pickOrientation(variants, middleRows));
  }

  // Real words one letter off the end of the ladder that aren't already in it -
  // the candidates for a locked rung.
  function endCandidates(endWord, ladderWords, graph) {
    // The graph is lowercase throughout and the ladder is displayed uppercase;
    // compare in one case or the filter silently never matches and every
    // candidate list comes back including words already used in the ladder.
    const inLadder = new Set(ladderWords.map((w) => w.toLowerCase()));
    return (graph.get(endWord.toLowerCase()) || [])
      .filter((w) => !inLadder.has(w))
      .map((w) => w.toUpperCase());
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
      `<span style="font-size:0.55em;opacity:0.9;letter-spacing:0.04em;">${word || ''}</span>` +
      `</span>`
    );
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
    const bottomRow = rows.find((r) => r.id === rows[rows.length - 1].id) || null;
    const middleRows = rows.filter((r) => r !== topRow && r !== bottomRow);

    if (middleRows.length < 2) {
      return { ok: false, error: 'The CrossClimb board looks half-loaded — found fewer than two fillable rungs.' };
    }

    const known = middleRows.map((r) => r.word);
    const filledCount = known.filter(Boolean).length;
    const wordLength = middleRows.map((r) => r.slots).find((n) => n > 0) || (known.find(Boolean) || '').length;
    if (!wordLength) {
      return { ok: false, error: 'Could not tell how long the CrossClimb answers are.' };
    }

    // Search common words first: the intended answers live there, and the
    // smaller graph is what makes a blank rung resolvable at all. Only widen to
    // the full dictionary if that finds nothing.
    let result = null;
    let graph = null;
    for (const commonOnly of [true, false]) {
      const vocabulary = await window.LockedInWords.ofLength(wordLength, { commonOnly });
      if (!vocabulary) continue;
      // Anything already typed has to be in the graph even if it's an unusual word.
      for (const w of known) if (w) vocabulary.push(w.toLowerCase());
      graph = buildLadderGraph([...new Set(vocabulary)]);
      const attempt = findLadders(known, graph, topRow && topRow.word, bottomRow && bottomRow.word);
      if (attempt.solutions.length) { result = attempt; break; }
    }

    if (!graph) {
      return { ok: false, error: 'Could not load the word list.' };
    }
    if (!result || !result.solutions.length) {
      return {
        ok: false,
        error: filledCount === middleRows.length
          ? "The words on the board don't form a valid ladder — one of them may be wrong."
          : 'No valid ladder fits what\'s on the board yet.',
      };
    }
    if (result.truncated) {
      return {
        ok: false,
        error: `Too many ladders still fit (${filledCount} of ${middleRows.length} rungs filled in). ` +
               'Solve a clue or two and this will work out the rest.',
      };
    }

    const ladders = distinctLadders(result.solutions, middleRows);
    const { position, word } = consensusOf(ladders, middleRows.length);
    const determined = position.filter(Boolean).length;
    if (!determined) {
      return {
        ok: false,
        error: `${ladders.length} different ladders still fit what's on the board. ` +
               'Fill in another clue and the rest should follow.',
      };
    }

    const markers = [];
    for (let i = 0; i < middleRows.length; i++) {
      if (!position[i]) continue; // genuinely ambiguous - say nothing rather than guess
      const row = middleRows[i];
      const pos = position[i];
      const anchorEl = row.dragger || (row.boxes.length > 0 ? row.boxes[0] : row.rowEl);
      markers.push({
        cellEl: anchorEl,
        html: badgeHtml(pos, known[i] ? '' : word[i]),
        color: POSITION_COLORS[(pos - 1) % POSITION_COLORS.length],
        isFilled: () => currentPositionOf(row.rowEl) === pos,
      });
    }

    window.LockedInOverlay.show({ anchorEl: grid, markers });
    return { ok: true };
  }

  // Prints what the board constrains and what it doesn't - including the top and
  // bottom rung candidates, which have no sensible place in the overlay itself.
  // Run `LockedInDebug.crossclimb()` in the console on the CrossClimb page.
  async function debugDump() {
    const grid = findGrid();
    if (!grid) return 'No CrossClimb grid on this page.';
    const scrape = scrapeBoard(grid);
    if (!scrape.ok) return scrape.error;

    const rows = scrape.rows;
    const topRow = rows[0];
    const bottomRow = rows[rows.length - 1];
    const middleRows = rows.slice(1, -1);
    const known = middleRows.map((r) => r.word);
    const wordLength = middleRows.map((r) => r.slots).find((n) => n > 0);
    if (!wordLength) return 'Could not tell how long the answers are.';

    const lines = [`typed so far: ${known.map((w) => w || '????').join(' ')}`];
    for (const commonOnly of [true, false]) {
      const vocabulary = await window.LockedInWords.ofLength(wordLength, { commonOnly });
      if (!vocabulary) { lines.push('word list failed to load'); break; }
      for (const w of known) if (w) vocabulary.push(w.toLowerCase());
      const graph = buildLadderGraph([...new Set(vocabulary)]);
      const { solutions, truncated } = findLadders(known, graph, topRow.word, bottomRow.word);
      const label = commonOnly ? 'common words' : 'full dictionary';
      const ladders = truncated ? [] : distinctLadders(solutions, middleRows);
      lines.push(`${label}: ${vocabulary.length} candidates, ${truncated ? `${solutions.length}+` : ladders.length} distinct ladder(s)`);
      if (solutions.length && !truncated) {
        const { position, word } = consensusOf(ladders, middleRows.length);
        lines.push(`  forced positions: ${position.map((p) => p || '?').join(' ')}`);
        lines.push(`  forced words:     ${word.map((w, i) => known[i] || w || '????').join(' ')}`);
        if (ladders.length === 1) {
          const ladder = ladders[0].words.map((w) => w.toUpperCase());
          lines.push(`  ladder: ${ladder.join(' -> ')}`);
          if (!topRow.word && !bottomRow.word) {
            lines.push('  (nothing locked at either end, so this ladder could equally run the other way —');
            lines.push('   the orientation shown is whichever is closer to the current arrangement)');
          }
          if (!topRow.word) lines.push(`  top rung candidates:    ${endCandidates(ladder[0], ladder, graph).join(', ') || '(none)'}`);
          if (!bottomRow.word) lines.push(`  bottom rung candidates: ${endCandidates(ladder[ladder.length - 1], ladder, graph).join(', ') || '(none)'}`);
        }
        break;
      }
    }
    return lines.join('\n');
  }

  window.LockedInDebug = window.LockedInDebug || {};
  window.LockedInDebug.crossclimb = () => debugDump().then((text) => console.log(text));

  window.LockedInGames = window.LockedInGames || [];
  window.LockedInGames.push({
    id: 'crossclimb',
    label: 'CrossClimb',
    detect: () => /\/games\/crossclimb(\/|$)/.test(location.pathname),
    run,
  });
})();
