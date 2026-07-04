// background.js (service worker)
//
// Handles AI-powered solving that requires access to window.ai (Chrome's
// built-in Gemini Nano Prompt API). window.ai is only available in the page's
// main JavaScript world, but content scripts run in an isolated world where
// chrome.* APIs work. This service worker bridges the two: the content script
// sends a LOCKEDIN_SOLVE_AI message here, and we use chrome.scripting to run
// the actual AI call inside the page's main world, then return the result.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'LOCKEDIN_SOLVE_AI') return false;

  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ error: 'Could not determine the active tab.' });
    return false;
  }

  // This function runs inside the page's main world where window.ai is exposed.
  // It must be self-contained (no closure over outer variables).
  async function solveInMainWorld(clues) {
    // Diagnostic: surface exactly what's available so we can give precise errors.
    if (typeof window.ai === 'undefined') {
      return { error: 'NO_AI', debug: 'window.ai is undefined' };
    }
    const aiKeys = Object.keys(window.ai).join(', ') || '(no keys)';
    const api = window.ai.languageModel || window.ai.assistant;
    if (!api) return { error: 'NO_AI', debug: `window.ai exists but has no languageModel or assistant. Keys: ${aiKeys}` };

    try {
      const cap = await api.capabilities();
      if (cap && cap.available === 'no') return { error: 'MODEL_NOT_READY' };
    } catch (_) {
      // capabilities() may not exist on all builds — proceed anyway.
    }

    let session;
    try {
      session = await api.create();
    } catch (e) {
      return { error: e && e.message ? e.message : 'Failed to start AI session.' };
    }

    const words = [];
    try {
      for (const clue of clues) {
        const raw = await session.prompt(
          'Answer this word puzzle clue with exactly one 4-letter English word. ' +
          'Reply with ONLY the word in UPPERCASE, nothing else.\n\nClue: ' + clue + '\nAnswer:'
        );
        const match = raw.trim().toUpperCase().match(/[A-Z]{4}/);
        words.push(match ? match[0] : null);
      }
    } finally {
      try { session.destroy(); } catch (_) {}
    }

    return { words };
  }

  chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'MAIN',
      func: solveInMainWorld,
      args: [message.clues],
    })
    .then((results) => {
      const result = results && results[0] && results[0].result;
      sendResponse(result || { error: 'AI execution returned no result.' });
    })
    .catch((err) => {
      sendResponse({ error: err && err.message ? err.message : 'Script execution failed.' });
    });

  return true; // keep message channel open for async sendResponse
});
