// content.js
//
// Thin dispatcher, loaded last (see manifest.json). Every game module
// (games/<name>/game.js) self-registers into window.LockedInGames by
// pushing { id, label, detect, run }. This file just finds whichever
// registered game's detect() matches the current URL and calls its run() -
// it has no game-specific knowledge so adding a new game never requires
// touching this file.
//
// Auto-solve: a MutationObserver watches for DOM changes so the overlay
// appears automatically once the game grid finishes loading, without the user
// needing to open the popup. The same observer resets on URL changes so
// navigating between game pages (LinkedIn is a SPA) re-triggers the solve.

(function () {
  function findActiveGame() {
    return (window.LockedInGames || []).find((game) => game.detect());
  }

  function solveAndRender() {
    if (window.LockedInOverlay.isActive()) {
      return { ok: false, error: 'A solution overlay is already showing. Dismiss it (✕) before solving again.' };
    }

    const game = findActiveGame();
    if (!game) {
      return { ok: false, error: "This LinkedIn game isn't supported yet." };
    }

    return game.run();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'LOCKEDIN_SOLVE') return;

    try {
      sendResponse(solveAndRender());
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : 'Unknown error.' });
    }
  });

  // Auto-solve logic. Fires on every DOM mutation (covers the game grid
  // appearing after LinkedIn's async rendering) and on URL changes (SPA
  // navigation to a new game page). Once the overlay is up it stops trying;
  // once the URL changes it resets so the next game gets solved fresh.
  let lastUrl = location.href;
  let solvedOnThisPage = false;

  function tryAutoSolve() {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      solvedOnThisPage = false;
    }
    // If the overlay was dismissed because its anchor element left the DOM (SPA
    // navigation or React re-render replacing the grid), reset so we solve again
    // once the new grid renders. This is distinct from the user clicking ✕.
    if (window.LockedInOverlay.takeAutoDismissed()) {
      solvedOnThisPage = false;
    }
    if (solvedOnThisPage || window.LockedInOverlay.isActive()) return;

    const game = findActiveGame();
    if (!game) return;

    try {
      const result = game.run();
      if (result && result.ok) solvedOnThisPage = true;
    } catch (_) {
      // Grid not ready yet - the observer will retry on the next DOM change.
    }
  }

  new MutationObserver(tryAutoSolve).observe(document.body, {
    childList: true,
    subtree: true,
  });

  tryAutoSolve(); // also try immediately if the page is already loaded
})();
