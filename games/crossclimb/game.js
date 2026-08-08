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
// PRIMARY: read the answer off the page. LinkedIn hydrates its SPA from JSON
// parked in <code> elements, and the CrossClimb payload carries the whole
// puzzle - every rung's `word`, its `clue`, and a `solutionRungIndex` giving
// its place in the ladder. That solves a completely blank board outright, with
// nothing typed in.
//
// Matching a payload rung to a row on screen goes by clue text where it can,
// but the board shows its clues one at a time in a carousel, so usually only
// the focused rung's clue is in the DOM at all - which is why the first attempt
// at this quietly did nothing and left you looking at "too many ladders still
// fit". The fallback is the order LinkedIn lists the rungs in, cross-checked
// against whatever clue IS on screen.
//
// That is only trusted once the words independently chain into a single valid
// ladder, because the key names are LinkedIn's and will eventually move. When
// they do, this falls back to the deduction below rather than misreporting.
//
// FALLBACK: the ladder rule alone. Reading "Chowder ingredient" and producing
// CLAM needs world knowledge the DOM hasn't got, but the rungs must still
// reorder into a chain where each neighbour differs by one letter, every rung
// is a real word, and the locked top/bottom rungs extend it at each end. So
// this works from whatever you've typed in and reports only what those
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
// target position (1=top), and the rung's answer is spelled out one letter per
// letter slot - the same boxes you type into, so it reads at the size of the
// board rather than the size of the drag handle. Letters clear as you type
// them; a badge clears once its rung is both filled in and in the right slot.

(function () {
  // A ladder longer than this would make the permutation sweep silly; LinkedIn
  // has only ever shipped 5 middle rungs.
  const MAX_SOLUTIONS = 4000;

  // ── DOM helpers ────────────────────────────────────────────────────────────

  // The smallest element containing every match for `selector`.
  function commonAncestorOf(selector) {
    const found = document.querySelectorAll(selector);
    if (!found.length) return null;
    let node = found[0].parentElement;
    while (node && node !== document.body) {
      if (node.querySelectorAll(selector).length === found.length) return node;
      node = node.parentElement;
    }
    return found[0].parentElement || null;
  }

  function findGrid() {
    // `.crossclimb__grid` is one of LinkedIn's own class names and it has gone
    // missing at least once, which takes the whole game down with a "could not
    // find the grid" that has nothing to do with the puzzle. The rungs
    // themselves are marked with data attributes, so fall back to whatever
    // element contains all of them.
    return (
      document.querySelector('.crossclimb__grid') ||
      document.querySelector('[class*="crossclimb"][class*="grid"]') ||
      commonAncestorOf('[data-guess-id]') ||
      commonAncestorOf('[data-crossclimb-guess-input-idx]') ||
      document.querySelector('[class*="crossclimb"]')
    );
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

  // Five hues that stay legible as both a white-on-solid badge digit and as the
  // letter glyphs, which are drawn in the hue itself over a light board. The
  // extension's usual gold sat here first and failed at both: white on gold is
  // barely a contrast at all, and gold letters on LinkedIn's off-white board
  // were the faintest thing on screen. Same reason the green is a shade down
  // from the Material 500 it started as.
  const POSITION_COLORS = ['#e8590c', '#2e7d32', '#1565c0', '#c2185b', '#6a1b9a'];

  function badgeHtml(pos, word) {
    const bg = POSITION_COLORS[(pos - 1) % POSITION_COLORS.length];
    const box =
      `display:flex;flex-direction:column;align-items:center;justify-content:center;` +
      `width:100%;height:100%;background:${bg};border-radius:4px;color:#fff;font-weight:800;line-height:1.15;`;
    // With the answer spelled out across the rung's own letter slots there's
    // nothing left to cram in beside the number, so it gets the whole badge.
    if (!word) return `<span style="${box}font-size:1.15em;">${pos}</span>`;
    return (
      `<span style="${box}">` +
      `<span style="font-size:0.8em;">${pos}</span>` +
      `<span style="font-size:0.55em;opacity:0.9;letter-spacing:0.04em;">${word}</span>` +
      `</span>`
    );
  }

  // ── Overlay ────────────────────────────────────────────────────────────────

  // Where to draw each letter of a rung's answer: one element per letter slot.
  // The word used to be printed inside the position badge, but that badge sits
  // on the drag handle - a box roughly 30px across - so a four-letter word came
  // out around 7px tall and was, fairly, unreadable. A rung's own letter slots
  // are sized for exactly one letter each, which is the whole problem solved.
  //
  // Returns null if the slots can't be lined up with the letters, and the
  // caller falls back to the cramped-but-present badge text rather than
  // silently dropping the word.
  function letterCellsOf(row, word) {
    const inputs = Array.from(guessInputs(row.rowEl));
    if (!word || inputs.length !== word.length) return null;
    // `.crossclimb__guess_box` is LinkedIn's own class name and those have gone
    // missing before; the input carries a data attribute, so it is the durable
    // anchor when the prettier one isn't there.
    const cells = row.boxes.length === inputs.length ? row.boxes : inputs;
    const sized = cells.every((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return sized ? cells : null;
  }

  function letterTyped(row, idx) {
    const input = guessInputs(row.rowEl)[idx];
    return !!(input && (input.value || '').trim());
  }

  // A rung is done when its answer is in *and* it sits in the right slot.
  //
  // Position alone is not enough, and getting that wrong hid the one thing the
  // badge exists to say. On a board you haven't touched, a rung being in its
  // target slot already is just luck - it happens to about one rung in five -
  // and treating it as finished faded the badge out, taking the answer with it.
  // What you saw was a board with a hole in it: positions 1, 3, 4, 5 marked and
  // nothing at all on the row that needed no dragging.
  function rowSettled(row, expected) {
    const current = readWord(row.rowEl);
    if (!current) return false;
    return !expected || current === expected.toUpperCase();
  }

  function showBadges(grid, middleRows, position, word, typed) {
    const markers = [];
    for (let i = 0; i < middleRows.length; i++) {
      const pos = position[i];
      if (!pos) continue; // genuinely ambiguous - say nothing rather than guess
      const row = middleRows[i];
      const color = POSITION_COLORS[(pos - 1) % POSITION_COLORS.length];
      // Nothing to spell out on a rung you've already filled in yourself.
      const answer = typed[i] ? null : word[i];
      const letterCells = letterCellsOf(row, answer);

      markers.push({
        cellEl: row.dragger || (row.boxes.length > 0 ? row.boxes[0] : row.rowEl),
        html: badgeHtml(pos, letterCells ? '' : (answer || '')),
        color,
        isFilled: () => currentPositionOf(row.rowEl) === pos && rowSettled(row, word[i]),
      });

      if (!letterCells) continue;
      for (let j = 0; j < letterCells.length; j++) {
        markers.push({
          cellEl: letterCells[j],
          glyph: answer[j],
          color,
          // Clears letter by letter as you type, so what's still showing is
          // exactly what's still to type.
          isFilled: () => letterTyped(row, j),
        });
      }
    }
    window.LockedInOverlay.show({ anchorEl: grid, markers });
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

    const typed = middleRows.map((r) => r.word);
    const wordLength = middleRows.map((r) => r.slots).find((n) => n > 0) || (typed.find(Boolean) || '').length;
    if (!wordLength) {
      return { ok: false, error: 'Could not tell how long the CrossClimb answers are.' };
    }

    // The page ships the answer. Prefer reading it over deducing it - deduction
    // can't get anywhere from a blank board, because the clues carry the
    // information and solving those needs world knowledge the DOM hasn't got.
    // Only trust it once the words independently form a single valid ladder,
    // so a payload shape that shifts under us falls back rather than misleads.
    const embedded = scrapeEmbeddedRungs(wordLength);
    let known = typed;
    let payloadTop = null;
    let payloadBottom = null;
    let payloadPositions = null;
    let fromPayload = false;
    {
      const chain = embedded.length >= middleRows.length ? chainWords(embedded.map((e) => e.word)) : null;
      const matched = chain ? rungsToRows(rows, middleRows, embedded, chain) : null;
      if (matched) {
        known = matched;
        fromPayload = true;
        const indexOf = new Map(embedded.map((e) => [e.word, e.index]));

        // solutionRungIndex is the payload saying outright where each rung
        // belongs, so rank the matched words by it and the drag order is done -
        // no ladder search, no orientation guess, nothing left to deduce.
        const indices = matched.map((w) => indexOf.get(w));
        if (indices.every(Number.isInteger) && new Set(indices).size === indices.length) {
          const ranked = [...indices].sort((a, b) => a - b);
          payloadPositions = indices.map((i) => ranked.indexOf(i) + 1);
        }

        // If it didn't, the chain's two ends are still the locked top and
        // bottom rungs, and naming them settles the one thing the ladder rule
        // can never settle on its own: which way up it goes.
        const first = indexOf.get(chain[0]);
        const last = indexOf.get(chain[chain.length - 1]);
        if (Number.isInteger(first) && Number.isInteger(last) && first !== last &&
            chain.length === middleRows.length + 2) {
          const oriented = first < last ? chain : [...chain].reverse();
          payloadTop = oriented[0];
          payloadBottom = oriented[oriented.length - 1];
        }
      }
    }

    // The page told us both the words and where they go: draw it.
    if (payloadPositions) {
      showBadges(grid, middleRows, payloadPositions, known, typed);
      return { ok: true };
    }
    const filledCount = known.filter(Boolean).length;

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
      const attempt = findLadders(
        known,
        graph,
        (topRow && topRow.word) || payloadTop,
        (bottomRow && bottomRow.word) || payloadBottom
      );
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

    showBadges(grid, middleRows, position, word, typed);
    return { ok: true };
  }

  // Prints what the board constrains and what it doesn't - including the top and
  // bottom rung candidates, which have no sensible place in the overlay itself.
  // Run `LockedInDebug.crossclimb()` in the console on the CrossClimb page.
  // When none of findGrid()'s selectors match, "no grid" is a dead end - it says
  // the markup changed without saying what to. So describe what the page does
  // have: the data-* attributes it uses, any class names that sound like this
  // game, and its text inputs. That's the fingerprint needed to re-anchor the
  // scraper, and it's far smaller than dumping the whole DOM.
  function describePage() {
    const dataAttrs = new Map();
    const classHits = new Set();
    const INTERESTING = /climb|guess|rung|ladder|drag|sortable/i;
    let elements = 0;

    for (const el of document.querySelectorAll('*')) {
      elements++;
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-')) {
          dataAttrs.set(attr.name, (dataAttrs.get(attr.name) || 0) + 1);
        }
      }
      const cls = el.getAttribute('class') || '';
      if (INTERESTING.test(cls)) {
        for (const token of cls.split(/\s+/)) if (INTERESTING.test(token)) classHits.add(token);
      }
      if (el.id && INTERESTING.test(el.id)) classHits.add(`#${el.id}`);
    }

    const inputs = Array.from(document.querySelectorAll('input'));
    const inputAttrs = new Set();
    for (const input of inputs.slice(0, 40)) {
      for (const attr of input.attributes) {
        if (attr.name !== 'value') inputAttrs.add(attr.name);
      }
    }

    const topData = [...dataAttrs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([name, count]) => `${name} (${count})`);

    return [
      'No CrossClimb grid on this page — none of the selectors matched.',
      `elements on page: ${elements}`,
      `text inputs: ${inputs.length}   their attributes: ${[...inputAttrs].join(', ') || '(none)'}`,
      `class/id names mentioning climb|guess|rung|ladder|drag|sortable:`,
      `  ${[...classHits].slice(0, 30).join(', ') || '(NONE — this game may be rendered in an iframe)'}`,
      'most common data-* attributes:',
      `  ${topData.join(', ') || '(none)'}`,
    ].join('\n');
  }

  // A blank CrossClimb board can't be solved from the ladder rule alone - the
  // clues carry the information and they need world knowledge. The one thing
  // that would change that is LinkedIn shipping the answers to the page, which
  // it plausibly does: the SPA hydrates from JSON payloads parked in <code>
  // elements, and Wend already turns out to embed its solution. So look, rather
  // than assume either way.
  //
  // This reports the SHAPE of what it finds - which payloads mention the game
  // and what keys they use - not the contents, so it stays small enough to
  // paste and doesn't spray puzzle data around.
  function findEmbeddedPuzzleData(wordLength) {
    const MENTIONS = /crossclimb|clue|ladder|rung/i;
    const ANSWERY = /answer|solution|word|clue|guess/i;
    const reports = [];

    const blobs = document.querySelectorAll('code, script[type="application/json"], script[type="application/ld+json"]');
    for (const node of blobs) {
      const text = node.textContent || '';
      if (text.length < 40 || !MENTIONS.test(text)) continue;

      const report = [`  payload ${node.id || node.tagName.toLowerCase()} (${text.length} chars)`];
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        report.push('    (not valid JSON on its own)');
      }

      const keys = new Set();
      const candidates = new Set();
      const wordShaped = wordLength ? new RegExp(`^[A-Za-z]{${wordLength}}$`) : null;

      (function walk(value, keyName, depth) {
        if (depth > 8 || keys.size > 400) return;
        if (Array.isArray(value)) {
          for (const item of value) walk(item, keyName, depth + 1);
          return;
        }
        if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            keys.add(k);
            walk(v, k, depth + 1);
          }
          return;
        }
        if (typeof value === 'string' && wordShaped && wordShaped.test(value) && ANSWERY.test(keyName || '')) {
          candidates.add(`${keyName}=${value}`);
        }
      })(parsed, '', 0);

      const interesting = [...keys].filter((k) => ANSWERY.test(k) || MENTIONS.test(k));
      report.push(`    keys mentioning answer/word/clue: ${interesting.slice(0, 25).join(', ') || '(none)'}`);
      if (candidates.size) {
        report.push(`    ${wordLength}-letter strings under those keys: ${[...candidates].slice(0, 12).join(', ')}`);
      }
      reports.push(report.join('\n'));
      if (reports.length >= 6) break;
    }

    if (!reports.length) return 'embedded puzzle data: none of the page payloads mention this game';
    return ['embedded puzzle data — payloads mentioning this game:', ...reports].join('\n');
  }

  // ── Reading the answer out of the page ────────────────────────────────────
  //
  // LinkedIn hydrates the SPA from JSON parked in <code> elements, and the
  // CrossClimb payload carries the whole puzzle: every rung's `word`, its
  // `clue`, and a `solutionRungIndex` saying where that rung belongs. So the
  // clues don't have to be *solved* at all - the answer is already on the page,
  // the same way Wend's is.
  //
  // Everything below is written to be suspicious of what it finds: the key
  // names are LinkedIn's and can change, so the words are only used once they
  // independently form a valid ladder (see run()). If the shape shifts, this
  // returns nothing and the constraint solver takes over as before.

  function payloadNodes() {
    return document.querySelectorAll(
      'code, script[type="application/json"], script[type="application/ld+json"]'
    );
  }

  // Pull the first plausible clue string out of a rung object.
  function clueTextOf(obj) {
    let found = null;
    (function walk(value, keyName, depth) {
      if (found || depth > 4) return;
      if (typeof value === 'string') {
        if (/clue|text|hint/i.test(keyName || '') && value.trim().length > 3) found = value.trim();
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item, keyName, depth + 1);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, k, depth + 1);
      }
    })(obj, '', 0);
    return found;
  }

  /**
   * Every rung the page's own payload describes: its word, where the payload
   * says it belongs, and its clue text (used to match a payload rung to the row
   * on screen). Returns [] if nothing recognisable is there.
   */
  function scrapeEmbeddedRungs(wordLength) {
    if (!wordLength) return [];
    const shaped = new RegExp(`^[A-Za-z]{${wordLength}}$`);
    // Insertion-ordered, and the walk is depth-first over the payload, so this
    // preserves the order LinkedIn lists the rungs in - which is the order they
    // appear on screen. That ordering is the mapping of last resort when the
    // clues aren't all readable (see rungsToRows).
    const byWord = new Map();

    for (const node of payloadNodes()) {
      const text = node.textContent || '';
      if (text.length < 40 || !/crossclimb/i.test(text)) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        continue;
      }

      (function walk(value, depth) {
        if (depth > 10) return;
        if (Array.isArray(value)) {
          for (const item of value) walk(item, depth + 1);
          return;
        }
        if (!value || typeof value !== 'object') return;

        if (typeof value.word === 'string' && shaped.test(value.word)) {
          const word = value.word.toUpperCase();
          const index = Number.isInteger(value.solutionRungIndex) ? value.solutionRungIndex : null;
          const existing = byWord.get(word);
          if (!existing) {
            byWord.set(word, { word, index, clue: clueTextOf(value) });
          } else {
            if (existing.index === null && index !== null) existing.index = index;
            if (!existing.clue) existing.clue = clueTextOf(value);
          }
        }
        for (const v of Object.values(value)) walk(v, depth + 1);
      })(parsed, 0);
    }

    return [...byWord.values()];
  }

  // Order an unordered set of words into the single chain where each neighbour
  // differs by one letter. Returns null unless exactly one such chain exists
  // (mirror images aside) - a set that doesn't chain isn't a CrossClimb answer,
  // whatever the payload called it.
  function chainWords(words) {
    const n = words.length;
    if (n < 3) return null;
    const chains = [];
    const used = new Array(n).fill(false);
    const order = [];

    function extend() {
      if (chains.length > 2) return;
      if (order.length === n) { chains.push(order.map((i) => words[i])); return; }
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        if (order.length && hammingDiff(words[order[order.length - 1]], words[i]) !== 1) continue;
        used[i] = true;
        order.push(i);
        extend();
        order.pop();
        used[i] = false;
      }
    }
    extend();

    // A chain and its reverse both turn up; anything more means it isn't unique.
    if (chains.length !== 2) return chains.length === 1 ? chains[0] : null;
    const [a, b] = chains;
    return a.join() === [...b].reverse().join() ? a : null;
  }

  function normalizeClue(text) {
    return (text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
  }

  function domClueFor(rungId) {
    const direct = document.getElementById(`crossclimb-clue-section-${rungId}`);
    if (direct) return direct.textContent;
    for (const el of document.querySelectorAll('[id*="clue"]')) {
      if (new RegExp(`(^|[^0-9])${rungId}([^0-9]|$)`).test(el.id || '')) return el.textContent;
    }
    return null;
  }

  /**
   * Match each middle rung on screen to its word from the payload, via clue
   * text. Returns an array parallel to middleRows, or null if the match isn't
   * clean - a partial match would silently mislabel rows, which is worse than
   * falling back to the constraint solver.
   */
  function wordsForMiddleRows(middleRows, entries) {
    const byClue = new Map();
    for (const entry of entries) {
      const key = normalizeClue(entry.clue);
      if (key) byClue.set(key, entry);
    }
    if (byClue.size < middleRows.length) return null;

    const words = [];
    const claimed = new Set();
    for (const row of middleRows) {
      const key = normalizeClue(domClueFor(row.id));
      const entry = key ? byClue.get(key) : null;
      if (!entry || claimed.has(entry.word)) return null;
      claimed.add(entry.word);
      words.push(entry.word);
    }
    return words;
  }

  /**
   * Match by what's already on the board. A word you've typed names its own
   * rung outright - no ordering assumption, no clue needed - and the payload's
   * words are distinct, so this is exact wherever it applies. The chain's two
   * ends are the locked rungs, so the middle words are known too: if exactly
   * one rung is still blank, the leftover word is forced.
   *
   * @returns {string[]|null} one word per middle row, or null if two or more
   *   rungs are blank (nothing on the board distinguishes them).
   */
  function rowsByTypedWord(middleRows, chain) {
    if (!chain || chain.length !== middleRows.length + 2) return null;
    const remaining = new Set(chain.slice(1, -1));

    const words = [];
    for (const row of middleRows) {
      if (!row.word) { words.push(null); continue; }
      // Typed a word the ladder doesn't contain: it's wrong, or the payload
      // isn't this puzzle. Either way this can't map anything.
      if (!remaining.delete(row.word)) return null;
      words.push(row.word);
    }

    const blanks = words.filter((w) => w === null).length;
    if (blanks === 0) return words;
    if (blanks > 1) return null;
    const [spare] = [...remaining];
    return words.map((w) => w || spare);
  }

  /**
   * Match payload rungs to the rows on screen, strongest evidence first.
   *
   * Clue text is the honest link, but CrossClimb shows its clues one at a time
   * in a carousel, so usually only the focused rung's clue is in the DOM at all
   * and matching all five is impossible without clicking through the board.
   *
   * The last resort is order: LinkedIn lists the rungs in the order it first
   * renders them, which is why each carries a separate solutionRungIndex saying
   * where it actually belongs. That order describes the board you were *dealt*,
   * though - drag a rung and it stops describing the board you have. So it is
   * only accepted when nothing already on screen contradicts it: every clue the
   * page is showing, and every word you have typed in, has to agree.
   *
   * Skipping that second check is what mislabelled a finished DUNES->OASIS
   * board, handing three correctly-placed rungs the positions of each other and
   * leaving badges lit on a puzzle that was already solved. The board was
   * spelling out the right answer the whole time; nothing had asked it.
   *
   * @returns {string[]|null} one word per middle row, or null.
   */
  function rungsToRows(allRows, middleRows, entries, chain) {
    const byWord = rowsByTypedWord(middleRows, chain);
    if (byWord) return byWord;

    const byClue = wordsForMiddleRows(middleRows, entries);
    if (byClue) return byClue;

    let slice = null;
    if (entries.length === allRows.length) {
      const start = allRows.indexOf(middleRows[0]);
      slice = entries.slice(start, start + middleRows.length);
    } else if (entries.length === middleRows.length) {
      slice = entries;
    }
    if (!slice || slice.length !== middleRows.length) return null;

    for (let i = 0; i < middleRows.length; i++) {
      const row = middleRows[i];
      if (row.word && row.word !== slice[i].word) return null;
      const shown = normalizeClue(domClueFor(row.id));
      if (!shown) continue;
      const expected = normalizeClue(slice[i].clue);
      if (expected && shown !== expected) return null;
    }

    return slice.map((entry) => entry.word);
  }

  async function debugDump() {
    const grid = findGrid();
    if (!grid) return describePage();
    const scrape = scrapeBoard(grid);
    if (!scrape.ok) return scrape.error;

    const rows = scrape.rows;
    const topRow = rows[0];
    const bottomRow = rows[rows.length - 1];
    const middleRows = rows.slice(1, -1);
    const known = middleRows.map((r) => r.word);
    const wordLength = middleRows.map((r) => r.slots).find((n) => n > 0);
    if (!wordLength) return 'Could not tell how long the answers are.';

    const embedded = scrapeEmbeddedRungs(wordLength);
    const chain = chainWords(embedded.map((e) => e.word));
    // Which strategy claimed the mapping matters as much as the mapping does -
    // the first two are exact, the third is an assumption about the board's
    // original layout that a dragged rung invalidates.
    const matched = chain ? rungsToRows(rows, middleRows, embedded, chain) : null;
    const how = !matched ? 'not matched'
      : rowsByTypedWord(middleRows, chain) ? 'by the words already typed in'
      : wordsForMiddleRows(middleRows, embedded) ? 'by clue text'
      : 'by payload order (unverified — no typed word or visible clue contradicted it)';
    const lines = [
      `typed so far: ${known.map((w) => w || '????').join(' ')}`,
      `answers read from the page: ${embedded.length ? embedded.map((e) => e.word).join(', ') : '(none found)'}`,
      `they chain into a ladder: ${chain ? chain.join(' -> ') : 'no'}`,
      `matched to rows on screen: ${matched ? matched.join(', ') : 'no'}  (${how})`,
      findEmbeddedPuzzleData(wordLength),
    ];
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
    detect: () => window.LockedInDetect.gameDetector('crossclimb')(),
    run,
    diagnose: debugDump,
  });
})();
