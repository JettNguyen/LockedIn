// content.js
//
// Thin dispatcher, loaded last (see manifest.json). Every game module
// (games/<name>/game.js) self-registers into window.LockedInGames by
// pushing { id, label, detect, run }. This file just finds whichever
// registered game's detect() matches the current URL and calls its run() -
// it has no game-specific knowledge so adding a new game never requires
// touching this file.
//
// game.run() may be synchronous (most games) or async (CrossClimb, which
// calls Chrome's built-in AI). Both are handled transparently via
// Promise.resolve().
//
// Auto-solve: driven by a steady heartbeat, with DOM mutations only used as a
// hint that it's worth trying again *now*. A mutation-only trigger (what this
// used to be) has a hole you fall into constantly on LinkedIn: React commits
// the finished grid - or swaps the grid out from under a just-drawn overlay -
// in the very last mutation batch the page ever emits, and then there is
// nothing left to fire on. That's why Patches needed a manual Solve and Mini
// Sudoku needed a hard refresh. The heartbeat always gets another chance.

(function () {
  // Safety-net heartbeat, for the cases nothing else fires on: the page going
  // permanently quiet mid-load, or the overlay dropping itself with no
  // mutation to follow. Cheap when there's nothing to do - a URL compare and
  // two boolean checks. The primary trigger is the settle timer below.
  const TICK_MS = 300;
  // How long the DOM has to stay quiet before we scrape, so we read a finished
  // render instead of a half-committed one.
  const SETTLE_MS = 100;
  // ...but LinkedIn pages are never reliably quiet - a ticker, a lazy image, an
  // animation - and waiting for a silence that never comes would mean never
  // scraping at all. Past this much waiting, take what's on the page.
  const MAX_SETTLE_MS = 1000;
  // Backoff bounds for repeated failures (grid not ready, unsolvable scrape).
  // The first few failures don't back off at all - they're almost always just
  // "the board hasn't finished rendering", and that resolves in well under a
  // second, so there's no reason to make you wait out a doubling delay for it.
  const RETRY_MIN_MS = 400;
  const RETRY_MAX_MS = 5000;
  const RETRY_GRACE_ATTEMPTS = 3;

  function findActiveGame() {
    return (window.LockedInGames || []).find((game) => game.detect());
  }

  async function solveAndRender({ force = false } = {}) {
    if (window.LockedInOverlay.isActive()) {
      // Manual solves replace whatever is on screen - if you pressed Solve you
      // want a solution, not a complaint that you already have one. Auto-solves
      // never force, so they can't stomp an overlay you're using.
      if (!force) {
        return { ok: false, error: 'A solution overlay is already showing. Dismiss it (✕) before solving again.' };
      }
      window.LockedInOverlay.dismiss();
    }

    const game = findActiveGame();
    if (!game) {
      return { ok: false, error: "This LinkedIn game isn't supported yet." };
    }

    return await Promise.resolve(game.run());
  }

  // --- Auto-solve state ---------------------------------------------------

  let lastUrl = location.href;
  let solvedOnThisPage = false;
  let autoSolving = false; // prevents concurrent auto-solve calls
  let consecutiveFailures = 0;
  let nextAttemptAt = 0; // epoch ms; don't attempt again before this
  let domRevision = 0; // bumped once per DOM mutation batch
  let domTouchedAt = 0; // epoch ms of the most recent DOM mutation
  let domDirtySince = 0; // epoch ms the DOM first changed after our last attempt
  let scrapedRevision = -1; // domRevision as of our last attempt

  // Has the page changed since the last time we scraped it? A counter rather
  // than a timestamp comparison: mutations land in the same millisecond as the
  // scrape they should invalidate often enough that "newer than" silently reads
  // as "unchanged", stranding us on the retry backoff for no reason.
  function domChangedSinceLastAttempt() {
    return domRevision !== scrapedRevision;
  }

  let attempts = 0;
  let lastOutcome = 'no attempt yet';

  // Structure the live overlay depends on, as of the last solve. See tick().
  let lastSignature = null;

  function markSolved() {
    solvedOnThisPage = true;
    consecutiveFailures = 0;
    const game = findActiveGame();
    lastSignature = game && game.signature ? game.signature() : null;
  }

  // Called when we're looking at a board we haven't solved yet: a new URL, or
  // the overlay dropping itself because its grid was replaced.
  function resetForFreshBoard() {
    solvedOnThisPage = false;
    consecutiveFailures = 0;
    nextAttemptAt = 0;
  }

  function noteFailure() {
    // A failure is nearly always "the grid hasn't finished rendering", so we
    // keep trying - but with backoff, so a page we genuinely can't solve
    // doesn't re-run an expensive solver three times a second forever. Any DOM
    // change short-circuits the backoff (see the observer below).
    consecutiveFailures++;
    const doublings = Math.max(0, consecutiveFailures - RETRY_GRACE_ATTEMPTS);
    nextAttemptAt = Date.now() + Math.min(RETRY_MIN_MS * 2 ** doublings, RETRY_MAX_MS);
  }

  async function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      resetForFreshBoard();
    }

    // The overlay dismissed itself because the grid it was drawn over left the
    // DOM (SPA navigation, React re-mounting the board). Solve the new one.
    // Distinct from the user clicking ✕, which is meant to stay dismissed.
    if (window.LockedInOverlay.takeAutoDismissed()) resetForFreshBoard();

    // A board can change SHAPE under a live overlay, and an overlay only tracks
    // the cells it was built with. CrossClimb is the case that showed this up:
    // its locked top and bottom rungs have no letter slots until the ladder is
    // ordered, so the overlay drawn on arrival has no markers for them and the
    // last two answers never appear, however long you wait.
    //
    // Games that can do this expose signature() over whatever structure the
    // overlay is pinned to; when it moves, redraw against the new board. Only
    // while our own overlay is up - dismissing it with ✕ means you want it
    // gone, and it stays gone.
    if (solvedOnThisPage && !autoSolving && window.LockedInOverlay.isActive()) {
      const active = findActiveGame();
      const signature = active && active.signature ? active.signature() : null;
      if (signature !== null && signature !== lastSignature) {
        window.LockedInOverlay.dismiss();
        resetForFreshBoard();
      }
    }

    if (autoSolving || solvedOnThisPage || window.LockedInOverlay.isActive()) return;

    const now = Date.now();
    if (domChangedSinceLastAttempt()) {
      // The page changed since we last looked: retry as soon as it settles,
      // ignoring whatever backoff the previous failure set - but don't hold out
      // forever for a quiet moment that may never come.
      const settled = now - domTouchedAt >= SETTLE_MS;
      const waitedLongEnough = now - domDirtySince >= MAX_SETTLE_MS;
      if (!settled && !waitedLongEnough) return;
    } else if (now < nextAttemptAt) {
      return;
    }

    const game = findActiveGame();
    if (!game) {
      lastOutcome = `no registered game matches ${location.pathname}`;
      return;
    }

    autoSolving = true;
    scrapedRevision = domRevision;
    attempts++;
    try {
      const result = await Promise.resolve(game.run());
      if (result && result.ok) {
        lastOutcome = `${game.label}: solved`;
        markSolved();
      } else {
        lastOutcome = `${game.label}: ${(result && result.error) || 'failed with no reason given'}`;
        noteFailure();
      }
    } catch (err) {
      lastOutcome = `${game.label} threw: ${err && err.message ? err.message : err}`;
      noteFailure();
    } finally {
      autoSolving = false;
    }
  }

  // Everything worth knowing when a game misbehaves, in one block of text:
  // which game matched, why the last solve attempt ended the way it did, and
  // whatever that game can say about the board it scraped.
  const isTopFrame = (() => {
    try {
      return window.top === window;
    } catch (_) {
      return false; // cross-origin parent; we're definitely in a frame
    }
  })();

  // Which frame this is, and what frames sit inside it. This is the fact that
  // explained "the game only works after a hard refresh": reached by client-side
  // navigation the puzzle renders in an iframe, and a script confined to the top
  // document truthfully reports no grid while the board is plainly on screen.
  function describeFrames() {
    const frames = Array.from(document.querySelectorAll('iframe'));
    const srcs = frames
      .map((f) => {
        const src = f.getAttribute('src') || '(no src)';
        return src.length > 70 ? `${src.slice(0, 67)}...` : src;
      })
      .slice(0, 6);
    return [
      `frame:             ${isTopFrame ? 'top document' : 'INSIDE AN IFRAME'}`,
      `iframes in here:   ${frames.length}${srcs.length ? `  → ${srcs.join('  ')}` : ''}`,
    ];
  }

  async function buildDiagnostics() {
    const games = window.LockedInGames || [];
    const active = games.filter((g) => g.detect());
    const lines = [
      `url:               ${location.href}`,
      ...describeFrames(),
      `extension version: ${chrome.runtime.getManifest().version}`,
      `games registered:  ${games.map((g) => g.id).join(', ') || '(none — the content scripts did not all load)'}`,
      `detect() matches:  ${active.map((g) => g.id).join(', ') || '(NONE — this is why nothing happens)'}`,
      `overlay showing:   ${window.LockedInOverlay.isActive()}`,
      `marked solved:     ${solvedOnThisPage}`,
      `solve attempts:    ${attempts}`,
      `last outcome:      ${lastOutcome}`,
      `dom revision:      ${domRevision} (last scraped at ${scrapedRevision})`,
      `consecutive fails: ${consecutiveFailures}`,
    ];

    for (const game of active) {
      lines.push('', `--- ${game.label} ---`);
      if (typeof game.diagnose !== 'function') {
        lines.push('(this game has no board report)');
        continue;
      }
      try {
        lines.push(await Promise.resolve(game.diagnose()));
      } catch (err) {
        lines.push(`report threw: ${err && err.message ? err.message : err}`);
      }
    }
    return lines.join('\n');
  }

  // The script now runs in every frame, so one message reaches all of them and
  // Chrome delivers only the FIRST reply. A frame with no puzzle in it must not
  // win that race, or the popup reports "not supported" from an empty shell
  // while the frame actually holding the board is still working. So:
  //
  //   Solve       - only a frame with a game answers at all. Silence means no
  //                 frame has one, which popup.js reports as such.
  //   Diagnostics - a frame with a game answers at once; the others hang back,
  //                 nearest-to-the-user first, because a report from an empty
  //                 page is still worth having when nothing matched anywhere.
  // Generous, because it is only ever paid when NO frame has a puzzle: a real
  // diagnose() runs a solver and can take the better part of a second, and a
  // shell frame answering first would replace the one report worth reading.
  const QUIET_FRAME_DELAY_MS = isTopFrame ? 1500 : 2000;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'LOCKEDIN_DIAGNOSTICS') {
      const delay = findActiveGame() ? 0 : QUIET_FRAME_DELAY_MS;
      const reply = (report) => setTimeout(() => sendResponse({ report }), delay);
      buildDiagnostics()
        .then(reply)
        .catch((err) => reply(`Diagnostics failed: ${err && err.message ? err.message : err}`));
      return true;
    }

    if (!message || message.type !== 'LOCKEDIN_SOLVE') return;
    if (!findActiveGame()) return; // let whichever frame holds the board answer

    solveAndRender({ force: true })
      .then((result) => {
        // Record the manual solve so the heartbeat treats this board as handled
        // instead of racing to draw a second overlay over it. A failed one is
        // the opposite case: forcing already dismissed whatever was showing, so
        // hand the board back to the heartbeat rather than leaving you staring
        // at a bare grid until you navigate away.
        if (result && result.ok) markSolved();
        else resetForFreshBoard();
        sendResponse(result);
      })
      .catch((err) => {
        resetForFreshBoard();
        sendResponse({ ok: false, error: err && err.message ? err.message : 'Unknown error.' });
      });

    return true; // keep the message channel open for the async response
  });

  // Scrape as soon as the DOM goes quiet rather than on the next heartbeat.
  // Waiting for the heartbeat put up to a full TICK_MS between "the board
  // finished rendering" and "the overlay appears", on top of the settle
  // window - which is most of the delay before the overlay shows up. The +16ms
  // keeps the timer from landing a hair early and being bounced by tick()'s own
  // settle check, costing another whole heartbeat.
  let settleTimer = null;
  function scheduleSettledTick() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(tick, SETTLE_MS + 16);
  }

  new MutationObserver(() => {
    if (!domChangedSinceLastAttempt()) domDirtySince = Date.now();
    domRevision++;
    domTouchedAt = Date.now();
    if (solvedOnThisPage || window.LockedInOverlay.isActive()) return;
    scheduleSettledTick();
    // documentElement, not body: a SPA route change can replace <body> outright,
    // and an observer bound to the old one goes quiet forever - taking the
    // prompt trigger with it and leaving only the heartbeat's slow backoff.
  }).observe(document.documentElement, { childList: true, subtree: true });

  setInterval(tick, TICK_MS);
  tick(); // the board may already be on the page
  scheduleSettledTick(); // ...and if it isn't, look again the moment it settles

  // Why isn't the overlay up? Every reason auto-solve declines to act shows up
  // in one of these lines, so `LockedInDebug.status()` in the console answers
  // that directly instead of by elimination.
  window.LockedInDebug = window.LockedInDebug || {};
  window.LockedInDebug.status = () => {
    const games = window.LockedInGames || [];
    const matched = games.filter((g) => g.detect()).map((g) => g.id);
    console.log([
      `url:               ${location.href}`,
      `games registered:  ${games.map((g) => g.id).join(', ') || '(none — the content scripts did not all load)'}`,
      `detect() matches:  ${matched.join(', ') || '(NONE — this is why nothing happens)'}`,
      `overlay showing:   ${window.LockedInOverlay.isActive()}`,
      `marked solved:     ${solvedOnThisPage}`,
      `solve attempts:    ${attempts}`,
      `last outcome:      ${lastOutcome}`,
      `dom revision:      ${domRevision} (last scraped at ${scrapedRevision})`,
      `consecutive fails: ${consecutiveFailures}`,
    ].join('\n'));
  };
})();
