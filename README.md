# LockedIn

A Chrome extension that solves LinkedIn's daily puzzle games and overlays the
solution directly on the page - no clicking through the puzzle for you, no
modifying the page's DOM, just a transparent layer showing you the answer.

## Status: Queens only (for now)

The first game implemented is **Queens**. The plan is to keep adding every
LinkedIn game that's deterministic (i.e. has a single computable solution,
as opposed to something like Pinpoint or word-guessing games that rely on
fuzzy/semantic input) - so expect this repo to grow over time.

### How Queens solving works

1. **Scrape** - reads the puzzle grid straight from the page's accessibility
   labels (`aria-label="...color <Name>, row <R>, column <C>"`), so it
   doesn't depend on LinkedIn's hashed/minified CSS class names.
2. **Solve** - a pure backtracking algorithm (no DOM access at all) places
   one queen per row/column/region with no two queens touching, including
   diagonally.
3. **Overlay** - draws the solution as a separate, absolutely-positioned
   layer on top of the grid. The puzzle's own DOM is never read-written or
   clicked; the overlay just tracks the grid's position on screen and can be
   dismissed with the ✕ button.

## Usage

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Open a LinkedIn Queens puzzle, click the extension icon, then **Solve**

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 config, scoped to `linkedin.com/games/queens/*` |
| `solver.js` | Pure backtracking solver, zero DOM dependencies |
| `content.js` | Scrapes the puzzle grid and renders the solution overlay |
| `overlay.css` | Cosmetic styles (pulse animation, dismiss button) for the overlay |
| `popup.html` / `popup.js` | Extension popup UI (Solve button + status) |

## Adding a new game

Each game should follow the same shape as Queens: a DOM-free solver module,
a content script that scrapes the live page into a plain data structure and
renders results via a non-destructive overlay, and a `manifest.json` entry
scoped to that game's URL.
