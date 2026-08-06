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

  return { gameDetector };
})();
