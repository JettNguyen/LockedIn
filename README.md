# LockedIn

A Chrome extension that solves LinkedIn's daily puzzle games and overlays the
solution directly on the page - no clicking through the puzzle for you, no
modifying the page's DOM, just a transparent layer showing you the answer.

Click the extension icon and hit **Solve** on any supported LinkedIn game -
the extension auto-detects which game you're on from the page URL and runs
the matching solver. No per-game setup.

## Status: Queens, Tango (more on the way)

The plan is to keep adding every LinkedIn game that's deterministic (i.e.
has a single computable solution, as opposed to something like Pinpoint or
word-guessing games that rely on fuzzy/semantic input) - so expect this repo
to grow over time.

### How it works (every game follows this shape)

1. **Detect** - `content.js` checks the current URL against every registered
   game's `detect()` and runs whichever one matches. Adding a new game never
   requires touching this file.
2. **Scrape** - each game reads its puzzle straight from the page's
   accessibility labels and `data-testid`s (e.g. Queens cells expose
   `aria-label="...color <Name>, row <R>, column <C>"`; Tango cells expose
   `data-testid="cell-zero" | "cell-one" | "cell-empty"`), so it doesn't
   depend on LinkedIn's hashed/minified CSS class names where possible. When
   a detail genuinely isn't recoverable from markup alone (e.g. Tango's edge
   constraints don't say whether they apply to the cell to the right or
   below), the scraper measures actual on-screen position with
   `getBoundingClientRect()` at solve time instead of guessing.
3. **Solve** - a pure algorithm (no DOM access at all) computes the answer
   from the scraped data alone, so it's unit-testable in isolation.
4. **Overlay** - the shared renderer (`shared/overlay.js`) draws the answer
   as a separate, absolutely-positioned layer on top of the puzzle. The
   puzzle's own DOM is never read-written or clicked; the overlay just
   tracks element positions on screen and can be dismissed with the ✕
   button. As you fill in cells yourself, each game can supply an `isFilled`
   check so its marker fades out once it detects you've placed the matching
   piece on the real board - visual confirmation instead of a static overlay.

## Usage

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Open a supported LinkedIn game, click the extension icon, then **Solve**

## Project structure

```text
manifest.json           Manifest V3 config, scoped to linkedin.com/games/*
content.js               Thin dispatcher: detects the active game, calls its run()
popup.html / popup.js    Extension popup UI (Solve button + status)
overlay.css              Shared cosmetic styles (pulse animation, dismiss button, confirmed-cell fade)
shared/
  overlay.js             Game-agnostic overlay renderer used by every game
games/
  queens/
    solver.js            Pure backtracking solver, zero DOM dependencies
    game.js              Scrapes the Queens grid, detects the Queens URL, renders the result
  tango/
    solver.js            Pure backtracking solver, zero DOM dependencies
    game.js              Scrapes the Tango grid, detects the Tango URL, renders the result
```

## Adding a new game

1. Create `games/<name>/solver.js` - a pure function that takes plain data
   (no DOM) and returns the answer, or `null` if unsolvable. Keep it
   unit-testable in isolation (see "Testing a solver" below).
2. Create `games/<name>/game.js` - scrapes the live page into the plain data
   structure your solver expects, then on success calls
   `window.LockedInOverlay.show({ anchorEl, markers })` with the cell
   elements to highlight. End the file by self-registering:

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

That's it - `content.js` and `popup.js` are already game-agnostic and need
no changes.

### Testing a solver in isolation

Since solvers have zero DOM dependencies, they can be tested directly in
Node without a browser:

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

Same idea for Tango - `given` is a `Map` of `"row,col" -> 0|1` (0 = Sun, 1 =
Moon) and `constraints` is a list of `{ r1, c1, r2, c2, type: 'eq'|'neq' }`
pairs between adjacent cells:

```js
const fs = require('fs');
eval(fs.readFileSync('./games/tango/solver.js', 'utf8'));
console.log(solveTango({
  size: 4,
  given: new Map([['0,0', 0]]),
  constraints: [{ r1: 0, c1: 1, r2: 0, c2: 2, type: 'neq' }],
}));
```
