// content.js
//
// Thin dispatcher, loaded last (see manifest.json). Every game module
// (games/<name>/game.js) self-registers into window.LockedInGames by
// pushing { id, label, detect, run }. This file just finds whichever
// registered game's detect() matches the current URL and calls its run() -
// it has no game-specific knowledge so adding a new game never requires
// touching this file.

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
})();
