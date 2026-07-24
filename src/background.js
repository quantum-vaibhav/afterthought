// AfterThought — background service worker
// ASK: opens an inactive temporary-chat tab, runs the prompt via the worker
// content script (#slm-worker), relays streaming progress back, returns answer.

const WORKER_URL = "https://chatgpt.com/?temporary-chat=true#slm-worker";
const OVERALL_TIMEOUT_MS = 240000;

// requestId -> source tab id (for streaming progress relay)
const askSources = new Map();
// requestId -> last progress text (for error diagnostics)
const lastProgress = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ASK") {
    if (sender.tab?.id != null && msg.requestId)
      askSources.set(msg.requestId, sender.tab.id);
    askInWorkerTab(msg.prompt, msg.requestId)
      .then((answer) => sendResponse({ ok: true, answer }))
      .catch((err) => {
        const lp = lastProgress.get(msg.requestId);
        sendResponse({
          ok: false,
          error: String(err) + (lp ? " | last stage: " + lp.slice(0, 80) : ""),
        });
      })
      .finally(() => {
        askSources.delete(msg.requestId);
        lastProgress.delete(msg.requestId);
      });
    return true;
  }
  if (msg.type === "ASK_PROGRESS") {
    // from worker tab -> record + forward to the tab that asked
    lastProgress.set(msg.requestId, msg.text);
    const target = askSources.get(msg.requestId);
    if (target != null)
      chrome.tabs.sendMessage(target, msg).catch(() => {});
    return;
  }
});

async function askInWorkerTab(prompt, requestId) {
  const tab = await chrome.tabs.create({ url: WORKER_URL, active: false });
  // Stop the browser from auto-discarding this background tab under memory
  // pressure (many open tabs). Freezing is further blocked by a Web Lock the
  // worker holds — see keepWorkerAwake() in content.js.
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  try {
    return await withTimeout(
      (async () => {
        await waitForTabComplete(tab.id, 45000);
        // confirm the worker content script is ready before the real request
        const ping = await sendWithRetry(tab.id, { type: "SLM_PING" }, 20, 1000);
        if (!ping?.pong)
          throw new Error("worker content script never became ready");
        const start = await chrome.tabs.sendMessage(tab.id, {
          type: "RUN_ASK",
          prompt,
          requestId,
        });
        if (!start?.started) throw new Error("worker did not start the ask");
        console.log("[AfterThought bg v0.2.0] ask started, polling every 2s…");
        let polls = 0;

        // Poll the worker every 2s. The worker tab's own timers are throttled
        // while it's in the background (which used to leave finished answers
        // stranded until the tab was focused), but extension message delivery
        // is NOT throttled — each SLM_CHECK inspects the DOM immediately.
        for (;;) {
          await delay(2000);
          let st = null;
          try {
            st = await chrome.tabs.sendMessage(tab.id, { type: "SLM_CHECK" });
          } catch (_) {
            console.log("[AfterThought bg] worker tab not responding (asleep?)");
            continue; // tab busy/navigating/frozen — try again next tick
          }
          if (!st) continue;
          polls++;
          console.log(
            `[AfterThought bg] poll #${polls}: done=${!!st.done} text=${(st.text || st.answer || "").slice(0, 40)}`
          );
          if (st.samples && st.samples.length)
            console.log("[AfterThought bg] stream sample:", st.samples);
          if (st.text) relayProgress(requestId, st.text);
          if (st.done) {
            if (st.error) throw new Error(st.error);
            return st.answer;
          }
        }
      })(),
      OVERALL_TIMEOUT_MS,
      "overall ask timed out"
    );
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function relayProgress(requestId, text) {
  lastProgress.set(requestId, text);
  const target = askSources.get(requestId);
  if (target != null)
    chrome.tabs
      .sendMessage(target, { type: "ASK_PROGRESS", requestId, text })
      .catch(() => {});
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForTabComplete(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("worker tab never finished loading"));
    }, timeout);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        cleanup();
        resolve();
      }
    }
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        cleanup();
        resolve();
      }
    });
  });
}

async function sendWithRetry(tabId, message, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

// slm
function withTimeout(promise, ms, why) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("Timeout: " + why)), ms)
    ),
  ]);
}
