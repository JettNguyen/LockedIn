// shared/detect.js
//
// Decides which game (if any) the current URL is. Every game module calls
// gameDetector('slug', ...) instead of writing its own regex.
//
// The rule is deliberately loose about WHERE the slug sits in the path. Each
// game used to require its slug immediately after /games/ - `/games/zip/`. But
// LinkedIn reaches a puzzle by more than one route, and the URL you land on
// when you click through from the games hub is not always the canonical one you
// get after a refresh (`/games/view/<slug>/` vs `/games/<slug>/`). A detector
// anchored to /games/<slug> silently answers "not a game" for the entire click-
// through route, which looks exactly like the extension being broken and is
// only ever "fixed" by reloading onto the canonical URL.
//
// So: the path has to be under /games/, and the slug has to appear somewhere in
// it as a whole segment. Anything under /games/ containing the segment "zip" is
// the Zip puzzle; there is nothing else it could be.

window.LockedInDetect = (function () {
  // Escape anything regex-special so a slug is matched literally.
  function escapeSlug(slug) {
    return slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * @param {...string} slugs - path segments identifying this game; the first
   *   is the canonical name, the rest are aliases (e.g. 'mini-sudoku', 'sudoku').
   * @returns {() => boolean} a detect() for window.LockedInGames.
   */
  function gameDetector(...slugs) {
    const pattern = new RegExp(`(^|/)(${slugs.map(escapeSlug).join('|')})(/|$)`, 'i');
    return () => /(^|\/)games(\/|$)/i.test(location.pathname) && pattern.test(location.pathname);
  }

  // The smallest element containing every match for `selector`. Lets a scraper
  // find a grid by the cells inside it, which carry data attributes, rather
  // than by the container's own class name, which is a rotating hash.
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

  /**
   * Fingerprint the page for a game whose grid couldn't be found.
   *
   * "No grid" on its own is a dead end - it says the markup changed without
   * saying what to. This says what the page DOES have: the data-* attributes it
   * uses and any class or id names that sound like this game. That's what's
   * needed to re-anchor a scraper, and it's far smaller than dumping the DOM.
   *
   * @param {RegExp} pattern - matches class/id names worth reporting.
   */
  function describePage(pattern) {
    const dataAttrs = new Map();
    const nameHits = new Set();
    let elements = 0;

    for (const el of document.querySelectorAll('*')) {
      elements++;
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-')) {
          dataAttrs.set(attr.name, (dataAttrs.get(attr.name) || 0) + 1);
        }
      }
      const cls = el.getAttribute('class') || '';
      if (pattern.test(cls)) {
        for (const token of cls.split(/\s+/)) if (pattern.test(token)) nameHits.add(token);
      }
      if (el.id && pattern.test(el.id)) nameHits.add(`#${el.id}`);
    }

    const inputs = Array.from(document.querySelectorAll('input'));
    const inputAttrs = new Set();
    for (const input of inputs.slice(0, 40)) {
      for (const attr of input.attributes) if (attr.name !== 'value') inputAttrs.add(attr.name);
    }

    const topData = [...dataAttrs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([name, count]) => `${name} (${count})`);

    return [
      `elements on page: ${elements}`,
      `text inputs: ${inputs.length}   their attributes: ${[...inputAttrs].join(', ') || '(none)'}`,
      `class/id names matching ${pattern}:`,
      `  ${[...nameHits].slice(0, 30).join(', ') || '(NONE — this game may be rendered in an iframe)'}`,
      'most common data-* attributes:',
      `  ${topData.join(', ') || '(none)'}`,
    ].join('\n');
  }

  return { gameDetector, commonAncestorOf, describePage };
})();
