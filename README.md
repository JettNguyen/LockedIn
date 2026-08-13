# LockedIn

**Solves LinkedIn's daily puzzle games and shows you the answer, right on the board.**

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![Games](https://img.shields.io/badge/games-7-2ea44f)
![Page DOM](https://img.shields.io/badge/page%20DOM-never%20touched-8957e5)
![External requests](https://img.shields.io/badge/external%20requests-none-0969da)

Open a supported game and the solution fades in over it — a floating layer, not
a single change to the page underneath. Fill a cell in yourself and that piece
of the overlay disappears, so what's still glowing is exactly what's still to do.

---

## The games

|     | Game | What you see |
|:---:|------|--------------|
| 👑 | **Queens** | A marker on every cell where a queen goes |
| ☀️ | **Tango** | The sun or moon each empty cell needs |
| 🔢 | **Mini Sudoku** | The digit for every empty cell |
| 🔗 | **Zip** | One green line tracing the whole path, a pulsing ring at the start, an arrowhead at the finish |
| 🧩 | **Patches** | Each region outlined in its own colour, with the cells you haven't placed yet hatched |
| 🔤 | **Wend** | A thin coloured path per word, ringed at its first letter and arrowed toward its last — drawn *around* the letters so the board stays readable |
| 🪜 | **CrossClimb** | Every rung's answer spelled across its own letter slots, plus a numbered badge showing the order to drag them into |

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder
4. Go to a LinkedIn game — the overlay appears on its own

## Using it

- **It just shows up.** Opening a supported game is all it takes, whether you
  land there directly or click through from the feed.
- **✕ dismisses it** if you'd rather work unaided.
- **Solve** in the extension popup brings it back, or forces a fresh attempt on
  a board that's changed shape.
- **It keeps up as you play.** Pieces fade out as you place them, and the whole
  overlay re-solves itself when the board changes underneath it.

## When something goes wrong

> [!TIP]
> Click the extension icon and hit **Copy diagnostics**. You get a report on
> your clipboard: which game matched the URL, why the last attempt ended the
> way it did, and — for Zip, Wend and CrossClimb — what the scraper actually
> read off the board. That's usually enough to pin down the problem with no
> back-and-forth.

The same reports live on `window.LockedInDebug` (`status()`, `zip()`, `wend()`,
`wendBoard()`, `crossclimb()`). They run in the content script's isolated world,
so the console won't see them until you switch its JavaScript context from `top`
to **LockedIn** — the button avoids that entirely.

## What it doesn't do

- **Nothing leaves your browser.** The only thing it ever loads is its own two
  word lists, bundled inside the extension. There is no server, and no request
  goes anywhere off your machine.
- **No writes to LinkedIn's DOM.** The overlay is a separate fixed-position layer
  appended to `document.body`. Your progress is always your own — the extension
  never fills a square in for you.
- **No accounts, no analytics, no storage.** Permissions are `activeTab` and
  `scripting`, and it does nothing at all outside a game page.

---

<details>
<summary><b>How a solve works</b></summary>

<br>

Every game follows the same four steps:

**1. Detect** — `content.js` checks the URL against every registered game's
`detect()` and calls whichever matches. Adding a game never means touching it.

**2. Scrape** — each game reads the board from the live page using stable
attributes (`data-testid`, `aria-label`, `data-cell-idx`, inline CSS custom
properties) rather than LinkedIn's hashed class names, so it survives their
deploys. Where there's no stable attribute at all — Zip's walls — the board is
*measured* instead: a wall is a thin bar lying along one edge of its cell.

**3. Solve** — a pure function with no DOM access computes the answer.
Queens, Tango, Sudoku, Zip and Patches are solved algorithmically. Wend and
CrossClimb first try to read the answer out of the page's own data, and fall
back to search when that data shifts (see below).

**4. Overlay** — `shared/overlay.js` draws a fixed-position layer over the page,
tracks the grid's position every frame so it stays aligned through scrolling and
resizing, and fades each piece out as you place it.

Suggestions are always drawn in a form the page itself never uses. Patches
regions are hatched rather than washed with a flat tint, because a flat tint is
exactly what LinkedIn paints a *placed* cell with — an overlay you can't tell
apart from your own progress makes an untouched board look finished.

</details>

<details>
<summary><b>Two decisions that look odd until they don't</b></summary>

<br>

**The auto-solve runs on a heartbeat, not just on DOM mutations.** LinkedIn
regularly lands its final render — or swaps the grid out from under a
just-drawn overlay — in the last mutation batch a page ever emits, which leaves
a mutation-only trigger with nothing left to fire on. Mutations are still
watched, but only to retry *sooner*; the heartbeat is what guarantees a retry
at all.

**The content script matches all of `linkedin.com`**, not just `/games/*`, even
though it does nothing anywhere else. Chrome only injects a content script on a
real document load, so matching `/games/*` meant that reaching a puzzle the
normal way — clicking through from the feed, which LinkedIn routes client-side —
left no script in the page at all, and the overlay only appeared after a hard
refresh. Matching every LinkedIn page means the script is already there when the
SPA routes into a game.

</details>

<details>
<summary><b>Project structure</b></summary>

<br>

```
manifest.json           Manifest V3, matches linkedin.com/*
content.js              Thin dispatcher: detects the active game, calls its run()
popup.html / popup.js   Extension popup (Solve button + status message)
overlay.css             Shared styles (marker highlight, breathing animation, fade-on-complete)
shared/
  detect.js             Maps a URL to a game; loose about where the slug sits in the path
  overlay.js            Game-agnostic overlay renderer used by every game module
  wordlist.js           Lazy loader for the two word lists below
  words.txt             ~359k words (Webster's Second + dwyl/english-words) — is this a real word?
  common-words.txt      ~9.4k most frequent English words — which real word is meant?
games/
  queens/
    solver.js           Backtracking constraint solver (pure, no DOM)
    game.js             Scrapes the Queens grid and renders the result
  tango/
    solver.js           Backtracking constraint solver (pure, no DOM)
    game.js             Scrapes the Tango grid and renders the result
  sudoku/
    solver.js           Backtracking constraint solver (pure, no DOM)
    game.js             Scrapes the Sudoku grid and renders the result
  zip/
    solver.js           Hamiltonian-path solver with wall-aware flood-fill pruning (pure, no DOM)
    game.js             Scrapes the Zip grid (letters, walls) and renders the path
  patches/
    game.js             Constraint-propagation + backtracking solver and scraper combined
  wend/
    game.js             Reads the word paths off the board, falling back to fitting real words onto the grid
  crossclimb/
    game.js             Reads the ladder out of the page's own puzzle data, falling back to a word-ladder constraint solver (no AI)
```

</details>

<details>
<summary><b>Adding a game</b></summary>

<br>

1. Create `games/<name>/solver.js` — a pure function that takes plain data (no
   DOM) and returns the answer, or `null` if unsolvable.

2. Create `games/<name>/game.js` — scrapes the live page, calls the solver, then
   calls `window.LockedInOverlay.show(...)`. End the file by registering:

   ```js
   window.LockedInGames = window.LockedInGames || [];
   window.LockedInGames.push({
     id: 'your-game',
     label: 'Your Game',
     detect: () => /\/games\/your-game(\/|$)/.test(location.pathname),
     run, // () => { ok: true } | { ok: false, error: string }
   });
   ```

3. Add both files to `manifest.json`'s `content_scripts[0].js` array, after
   `shared/overlay.js` and before `content.js`.

`content.js` and `popup.js` are already game-agnostic — nothing to change there.

</details>

<details>
<summary><b>Testing a solver in Node</b></summary>

<br>

Solvers have zero DOM dependencies, so they run directly in Node.

**Queens**
```js
const fs = require('fs');
eval(fs.readFileSync('./games/queens/solver.js', 'utf8'));
console.log(solveQueens([
  [0,0,0,0,0,0,1],
  [0,0,2,2,2,0,1],
  [0,3,3,2,4,4,5],
  [0,3,3,3,3,4,5],
  [0,3,3,3,3,3,5],
  [0,6,6,3,6,6,5],
  [0,0,6,6,6,5,5],
]));
```

**Tango** — `given` is a `Map` of `"row,col" → 0|1` (Sun/Moon), `constraints` is
a list of `{ r1, c1, r2, c2, type: 'eq'|'neq' }` pairs:
```js
const fs = require('fs');
eval(fs.readFileSync('./games/tango/solver.js', 'utf8'));
console.log(solveTango({
  size: 4,
  given: new Map([['0,0', 0]]),
  constraints: [{ r1: 0, c1: 1, r2: 0, c2: 2, type: 'neq' }],
}));
```

**Sudoku** — `given` is a `Map` of `"row,col" → digit`, `boxOf` is a 2D array
mapping each cell to its box index:
```js
const fs = require('fs');
eval(fs.readFileSync('./games/sudoku/solver.js', 'utf8'));
const n = 6;
const boxOf = Array.from({ length: n }, (_, r) =>
  Array.from({ length: n }, (_, c) => Math.floor(r / 2) * 2 + Math.floor(c / 3))
);
console.log(solveSudoku({
  size: n,
  boxOf,
  given: new Map([['0,2', 6], ['0,3', 5], ['5,0', 1], ['5,5', 3]]),
}));
```

**Zip** — `waypoints` is a `Map` of `"row,col" → number` (ordered visit points),
`walls` is a 2D array of `{ top, bottom, left, right }` booleans:
```js
const fs = require('fs');
eval(fs.readFileSync('./games/zip/solver.js', 'utf8'));
console.log(solveZip({
  size: 4,
  waypoints: new Map([['0,0', 1], ['3,3', 2]]),
  walls: Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => ({ top: false, bottom: false, left: false, right: false }))
  ),
}));
```

</details>

<details>
<summary><b>The two word games, and why they're hard</b></summary>

<br>

### Wend

Wend hides several words in a grid, each one a path of neighbouring letters. The
board says how long each word is, and its own markup often says which letters
belong together — but reading that markup describes the board you *have*, not
the one you want. On a board you've already filled in wrongly it would hand your
mistake straight back to you as the answer.

So whatever proposed a grouping — the board's colours, its position numbering,
or a search — it only reaches the screen if every path in it spells a real word.
When nothing on the board can be trusted, real words are laid onto the grid
instead and the one arrangement that covers every letter wins. The everyday
9.4k-word list is searched first: a grid built out of DIME and MULCH can
otherwise be "solved" with CARK and SLUT, both of which are, technically, in a
359k-word dictionary.

`LockedInDebug.wend()` prints the words it landed on; `wendBoard()` prints what
fits the grid at each length.

### CrossClimb

CrossClimb looked like it wouldn't be solvable at all. Solving it *as a puzzle*
turns on reading a clue — "Chowder ingredient" → `CLAM` — and that knowledge is
nowhere in the DOM. It turned out not to matter: LinkedIn hydrates its SPA from
JSON parked in `<code>` elements, and the CrossClimb payload carries every
rung's word plus a `solutionRungIndex` giving its place in the ladder. A
completely blank board solves outright, with nothing typed and no clue read.

Those key names are LinkedIn's and will eventually move, so the payload is only
believed once the words it yields independently chain into a single valid
ladder. When they don't, it falls through to deduction from the ladder rule
alone: the rungs must reorder into a chain where neighbours differ by exactly
one letter and every rung is a real word. That works from whatever you've typed
in and reports only what the constraints *force* — the drag order, any blank
rung the chain pins down, and the candidates for the locked end rungs. Over
random ladders drawn from common words, one blank rung is uniquely determined
about two thirds of the time and two blanks about a quarter. A blank board isn't
solvable that way at all, and it says so rather than inventing an answer.

One thing neither route can settle on its own: a ladder read top-to-bottom and
the same ladder read bottom-to-top are both valid, and LinkedIn accepts either.
So the direction is taken from the board — whichever way up is closer to how
your rungs are already arranged, and settled outright by a locked end rung once
you've filled one in.

</details>

<details>
<summary><b>Why Pinpoint isn't supported</b></summary>

<br>

Pinpoint gives you five items and asks for the category, which is pure semantic
knowledge. Matching against WordNet handles clean taxonomic sets — five string
instruments really do share the ancestor "stringed instrument" — but real
Pinpoint categories are mostly proper nouns and wordplay, and those fall
straight through: of five Marvel actors, only one appears in WordNet at all, and
a category like "___ Ball" shares no ancestor beyond "entity". A solver built on
that would be wrong more often than right.

</details>
