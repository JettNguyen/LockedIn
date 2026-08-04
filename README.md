# LockedIn

A Chrome extension that solves LinkedIn's daily puzzle games and overlays the
solution directly on the page — no clicking through the puzzle for you, no
modifying the page's DOM, just a transparent layer showing you the answer.

The overlay appears automatically when you open a supported game. You can also
click the extension icon and hit **Solve** to trigger it manually. A **✕**
button dismisses it. As you fill in cells yourself, each solved piece fades
out of the overlay so you always know what's left.

## Supported games

| Game | How the overlay helps |
|---|---|
| **Queens** | Black square marker on each cell where a queen goes |
| **Tango** | Sun/moon icon on each cell that needs a symbol |
| **Mini Sudoku** | Digit on each empty cell |
| **Zip** | Green line tracing the full path from start to finish |
| **Patches** | Colored region outlines, with the cells you haven't placed yet hatched |
| **Wend** | White path line per word with a filled start square and hollow end square |
| **CrossClimb** | Numbered position badges on each row showing the correct drag order |

## Usage

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Navigate to a supported LinkedIn game — the overlay appears automatically

Or click the extension icon and hit **Solve** if you want to trigger it
manually (e.g. after dismissing a previous overlay).

## How it works

Every game follows the same four-step shape:

1. **Detect** — `content.js` checks the URL against every registered game's
   `detect()` and calls whichever one matches. Adding a new game never
   requires touching this file.

2. **Scrape** — each game reads the puzzle from the live page using stable
   attributes (`data-testid`, `aria-label`, `data-cell-idx`, inline CSS custom
   properties, etc.) rather than LinkedIn's hashed/minified class names, so it
   keeps working across LinkedIn deploys. Where there's no stable attribute at
   all — Zip's walls — the board is measured instead: a wall is identified by
   being a thin bar lying along one edge of its cell. Run
   `LockedInDebug.zip()` in the console on the Zip page to print the scraped
   board and check the walls against what's on screen.

3. **Solve** — a pure function (no DOM access) computes the answer from the
   scraped data. Deterministic games (Queens, Tango, Sudoku, Zip, Patches) are
   solved algorithmically. Non-deterministic games where LinkedIn embeds the
   answer in the DOM (Wend) read it directly from inline style properties.

4. **Overlay** — `shared/overlay.js` draws a fixed-position layer over the
   page. The puzzle's own DOM is never touched. The overlay tracks the grid's
   position every frame (so it stays aligned on scroll/resize) and fades out
   individual pieces as you fill them in.

   Suggestions are always drawn in a form the page itself never uses — Patches
   regions are hatched rather than washed with a flat tint, because a flat tint
   is exactly what LinkedIn paints a *placed* cell with, and an overlay you
   can't tell apart from your own progress makes an untouched board look
   finished.

The auto-solve in `content.js` runs on a heartbeat, not purely on DOM
mutations. LinkedIn regularly lands its final render — or swaps the grid out
from under a just-drawn overlay — in the last mutation batch a page ever emits,
leaving a mutation-only trigger with nothing left to fire on. Mutations are
still used, but only to retry sooner; the heartbeat is what guarantees a retry
at all.

## Project structure

```
manifest.json           Manifest V3, scoped to linkedin.com/games/*
content.js              Thin dispatcher: detects the active game, calls its run()
popup.html / popup.js   Extension popup (Solve button + status message)
overlay.css             Shared styles (marker highlight, breathing animation, fade-on-complete)
shared/
  overlay.js            Game-agnostic overlay renderer used by every game module
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
    game.js             Reads word order from LinkedIn's embedded position data and renders paths
  crossclimb/
    game.js             Finds a valid word-ladder ordering and shows numbered drag-position markers
```

## Adding a new game

1. Create `games/<name>/solver.js` — a pure function that takes plain data
   (no DOM) and returns the answer, or `null` if unsolvable.

2. Create `games/<name>/game.js` — scrapes the live page, calls the solver,
   then calls `window.LockedInOverlay.show(...)`. End the file by registering:

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

`content.js` and `popup.js` are already game-agnostic — no changes needed there.

## Testing a solver in isolation

Solvers have zero DOM dependencies, so they can be tested directly in Node:

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

**Tango** — `given` is a `Map` of `"row,col" → 0|1` (Sun/Moon), `constraints`
is a list of `{ r1, c1, r2, c2, type: 'eq'|'neq' }` pairs:
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

**Zip** — `waypoints` is a `Map` of `"row,col" → number` (ordered visit
points), `walls` is a 2D array of `{ top, bottom, left, right }` booleans:
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
