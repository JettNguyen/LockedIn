// popup.js

const solveBtn = document.getElementById('solve-btn');
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendSolveMessage(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'QUEENS_SOLVE' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(response);
    });
  });
}

solveBtn.addEventListener('click', async () => {
  setStatus('Solving...');
  solveBtn.disabled = true;

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('Error: no active tab.');
      return;
    }

    let response;
    try {
      response = await sendSolveMessage(tab.id);
    } catch {
      // The content script likely wasn't injected yet - e.g. the extension
      // was installed/reloaded while this tab was already open, so the
      // declarative content_scripts entry in manifest.json never ran here.
      // Inject it on demand; this is the one place the "scripting"
      // permission earns its keep.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['solver.js', 'content.js'],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['overlay.css'],
      });
      response = await sendSolveMessage(tab.id);
    }

    if (!response) {
      setStatus('Error: no response from the page.');
    } else if (response.ok) {
      setStatus('Solved!');
    } else {
      setStatus(`Error: ${response.error || 'unknown failure.'}`);
    }
  } catch (err) {
    setStatus(`Error: ${err && err.message ? err.message : err}`);
  } finally {
    solveBtn.disabled = false;
  }
});
