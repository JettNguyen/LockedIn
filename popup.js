// popup.js

const solveBtn = document.getElementById('solve-btn');
const diagBtn = document.getElementById('diag-btn');
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendMessage(tabId, type) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type }, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(response);
    });
  });
}

const sendSolveMessage = (tabId) => sendMessage(tabId, 'LOCKEDIN_SOLVE');

// The debug helpers live in the content script's isolated world, so typing
// LockedInDebug into the page console just reports "not defined" unless you
// first switch the console's context to the extension. This button skips all
// that: it runs the report where it actually lives and puts it on the
// clipboard, ready to paste.
diagBtn.addEventListener('click', async () => {
  setStatus('Collecting…');
  diagBtn.disabled = true;
  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('Error: no active tab.');
      return;
    }

    let response;
    // Whether the content script was already running is the single most useful
    // fact about a "the overlay only appears after a hard refresh" report, and
    // injecting on demand destroys the evidence - by the time the report is
    // generated the script is there, and the report looks healthy. So record
    // which of the two happened and say so at the top.
    let hadToInject = false;
    try {
      response = await sendMessage(tab.id, 'LOCKEDIN_DIAGNOSTICS');
    } catch {
      hadToInject = true;
      const [{ js, css }] = chrome.runtime.getManifest().content_scripts;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: js });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: css });
      response = await sendMessage(tab.id, 'LOCKEDIN_DIAGNOSTICS');
    }

    const banner = hadToInject
      ? 'content script: WAS NOT RUNNING on this tab — the popup injected it just now.\n' +
        '                (so everything below describes a script that started seconds ago,\n' +
        '                 not one that was there when the page loaded)\n'
      : 'content script: already running before this report was taken.\n';
    const report = banner + ((response && response.report) || 'No report came back from the page.');
    await navigator.clipboard.writeText(report);
    setStatus(`Copied ${report.split('\n').length} lines to the clipboard.`);
  } catch (err) {
    setStatus(`Error: ${err && err.message ? err.message : err}`);
  } finally {
    diagBtn.disabled = false;
  }
});

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
      // permission earns its keep. Reading the file list straight off the
      // manifest (rather than hardcoding it here) means adding a new game's
      // files to content_scripts.js is the only place that needs updating.
      const [{ js, css }] = chrome.runtime.getManifest().content_scripts;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: js });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: css });
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
