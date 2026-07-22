// StudyLM — content script
// Normal tabs: notes UI. Worker tabs (#slm-worker): automation only.

(function () {
  "use strict";
  const A = window.StudyLMAdapter;
  const Store = window.StudyLMStore;
  const HL = window.StudyLMHighlights;
  if (!A) return;

  /* ================= worker mode ================= */

  if (location.hash.includes("slm-worker")) {
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg.type === "SLM_PING") {
        sendResponse({ pong: true });
        return;
      }
      if (msg.type !== "RUN_ASK") return;
      runAsk(msg.prompt, msg.requestId)
        .then((answer) => sendResponse({ ok: true, answer }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    });

    async function runAsk(prompt, requestId) {
      const report = (text) => {
        console.log("[StudyLM worker]", text.slice(0, 80));
        chrome.runtime
          .sendMessage({ type: "ASK_PROGRESS", requestId, text })
          .catch(() => {});
      };

      report("⏳ waiting for composer…");
      await waitFor(() => A.getComposer(), 20000, "composer never appeared");
      await sleep(500);

      report("⏳ typing prompt…");
      if (!A.setComposerText(prompt)) throw new Error("could not set prompt");
      await sleep(400);
      const c = A.getComposer();
      const typed = (c.innerText || c.value || "").trim();
      if (!typed) throw new Error("composer text did not register");

      report("⏳ sending…");
      if (!A.clickSend()) throw new Error("could not send");

      report("⏳ waiting for reply…");
      await waitFor(
        () => A.isGenerating() || A.getLastAssistantText().length > 0,
        15000,
        "generation never started"
      );

      // Poll until the reply is really finished. Primary signal: ChatGPT shows
      // the action bar (copy button) under a completed turn. Fallback: text
      // unchanged for a full 8s (streaming pauses are shorter than that).
      let last = "",
        stable = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 150000) {
        const now = A.getLastAssistantText();
        if (now && now === last) stable++;
        else stable = 0;
        if (now) {
          last = now;
          report(now);
        }
        if (
          last &&
          ((A.lastTurnComplete() && !A.isGenerating() && stable >= 2) ||
            stable >= 16)
        )
          return last;
        await sleep(500);
      }
      if (last) return last; // best effort
      throw new Error("no answer text appeared within 150s");
    }

    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }
    async function waitFor(fn, timeout, why) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try {
          if (fn()) return;
        } catch (_) {}
        await sleep(250);
      }
      throw new Error("Timeout: " + why);
    }
    return;
  }

  /* ================= normal mode ================= */

  const TYPES = Store.TYPES;

  // inline SVG icon set (stroke = currentColor)
  const _svg = (inner, s = 15) =>
    `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const I = {
    note: _svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    target: _svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>', 14),
    reply: _svg('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>', 14),
    trash: _svg('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>', 14),
    close: _svg('<path d="M18 6 6 18M6 6l12 12"/>', 14),
    grad: _svg('<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/>', 14),
    retry: _svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', 13),
    dl: _svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/>', 13),
    ul: _svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 8 12 3 17 8"/><line x1="12" y1="3" x2="12" y2="15"/>', 13),
  };

  let floatBtn = null;
  let popupEl = null;
  let sidebarEl = null;
  let quizEl = null;
  let pendingSel = null; // {text, messageId, fullText}
  const liveAsks = {}; // requestId -> noteId

  const cid = () => A.getConversationId();
  const title = () =>
    (document.title || "").replace(/ \| ChatGPT.*/i, "").slice(0, 120);

  /* ---------- theme ---------- */

  function syncTheme() {
    const dark =
      document.documentElement.classList.contains("dark") ||
      (!document.documentElement.classList.contains("light") &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute(
      "data-slm-theme",
      dark ? "dark" : "light"
    );
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  /* ---------- toasts ---------- */

  function toast(msg, ms = 2600) {
    let box = document.querySelector(".slm-toasts");
    if (!box) {
      box = el("div", "slm-toasts");
      document.body.appendChild(box);
    }
    const t = el("div", "slm-toast", msg);
    box.appendChild(t);
    requestAnimationFrame(() => t.classList.add("slm-show"));
    setTimeout(() => {
      t.classList.remove("slm-show");
      setTimeout(() => t.remove(), 300);
    }, ms);
  }

  /* ---------- selection capture ---------- */

  function captureSelection() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (!text || text.length < 3 || !sel.rangeCount) return null;
    const msgEl = A.getMessageContainer(sel.anchorNode);
    if (!msgEl || !A.getMessageContainer(sel.focusNode)) return null;
    return {
      text,
      messageId: A.getMessageId(msgEl),
      fullText: A.getMessageText(msgEl),
      rect: sel.getRangeAt(0).getBoundingClientRect(),
    };
  }

  document.addEventListener("mouseup", (e) => {
    if (e.target.closest(".slm-popup, .slm-float, .slm-sidebar, .slm-quiz, .slm-fab"))
      return;
    setTimeout(() => {
      hideFloat();
      const s = captureSelection();
      if (!s) return;
      pendingSel = s;
      showFloat(s.rect);
    }, 10);
  });

  // Alt+N shortcut, Esc to close
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "n") {
      const s = captureSelection();
      if (s) {
        pendingSel = s;
        e.preventDefault();
        openPopup();
      }
    } else if (e.key === "Escape") {
      closePopup();
      hideFloat();
      quizEl?.remove();
      quizEl = null;
    }
  });

  // click on a highlight -> open its note
  document.addEventListener("click", (e) => {
    if (e.target.closest(".slm-popup, .slm-sidebar, .slm-quiz, .slm-fab, .slm-float"))
      return;
    const noteId = HL?.hitTest(e.clientX, e.clientY);
    if (noteId) openSidebar(noteId);
  });

  function showFloat(rect) {
    floatBtn = el("button", "slm-float");
    floatBtn.innerHTML = I.note + "<span>Add note</span>";
    floatBtn.title = "Add StudyLM note (Alt+N)";
    floatBtn.style.top = window.scrollY + rect.bottom + 8 + "px";
    floatBtn.style.left =
      window.scrollX + Math.min(rect.left, window.innerWidth - 130) + "px";
    floatBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPopup();
    });
    document.body.appendChild(floatBtn);
  }
  function hideFloat() {
    floatBtn?.remove();
    floatBtn = null;
  }

  /* ---------- note popup ---------- */

  function typeChips(selected) {
    return Object.entries(TYPES)
      .map(
        ([k, t]) =>
          `<button class="slm-chip ${k === selected ? "slm-chip-on" : ""}"
             data-type="${k}" style="--chip:${t.color}"><i class="slm-dot"></i>${t.label}</button>`
      )
      .join("");
  }

  function smartTrim(s, n = 160) {
    if (s.length <= n) return s;
    return s.slice(0, n * 0.7) + " … " + s.slice(-n * 0.25);
  }

  function openPopup() {
    hideFloat();
    closePopup();
    const s = pendingSel;
    if (!s) return;
    let noteType = "general";

    popupEl = el("div", "slm-popup slm-pop-in");
    popupEl.innerHTML = `
      <div class="slm-popup-head">
        <span class="slm-brand">${I.note}<b>New note</b></span>
        <span class="slm-hint"><kbd>Alt</kbd><kbd>N</kbd></span></div>
      <blockquote class="slm-quote">${esc(smartTrim(s.text, 260))}</blockquote>
      <div class="slm-chips">${typeChips(noteType)}</div>
      <textarea class="slm-input" rows="3"
        placeholder="Your question or note about this text…"></textarea>
      <div class="slm-row">
        <button class="slm-btn slm-cancel">Cancel</button>
        <button class="slm-btn slm-save">Save note</button>
        <button class="slm-btn slm-primary slm-ask">Ask AI & save</button>
      </div>
      <div class="slm-status"></div>
      <div class="slm-stream"></div>`;
    document.body.appendChild(popupEl);
    const input = popupEl.querySelector(".slm-input");
    input.focus();

    // Enter = Ask AI & save · Shift+Enter = newline
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        popupEl.querySelector(".slm-ask").click();
      }
    });

    popupEl.querySelectorAll(".slm-chip").forEach((c) => {
      c.onclick = () => {
        noteType = c.dataset.type;
        popupEl
          .querySelectorAll(".slm-chip")
          .forEach((x) => x.classList.toggle("slm-chip-on", x === c));
      };
    });

    popupEl.querySelector(".slm-cancel").onclick = closePopup;
    popupEl.querySelector(".slm-save").onclick = async () => {
      await createNote(s, input.value.trim() || "(note)", null, noteType);
      toast("Note saved ✓");
      closePopup();
    };
    popupEl.querySelector(".slm-ask").onclick = async () => {
      const question = input.value.trim();
      if (!question) return setStatus("Type a question first.");
      const note = await createNote(s, question, "⏳ waiting for answer…", noteType);
      // Open the sidebar on this note so the answer streams in live — same
      // seamless flow as follow-ups, instead of leaving it hidden behind a badge.
      closePopup();
      await openSidebar(note.id);
      askAI(note, buildPrompt(s, question));
    };

    function setStatus(t) {
      if (popupEl) popupEl.querySelector(".slm-status").textContent = t;
    }
  }

  function closePopup() {
    popupEl?.remove();
    popupEl = null;
  }

  /* ---------- asking ---------- */

  function buildPrompt(s, question) {
    return (
      "You are helping a student annotate study material. " +
      "Answer the question briefly (2-4 sentences max), no preamble.\n\n" +
      "--- FULL CONTEXT (an AI answer the student is reading) ---\n" +
      s.fullText.slice(0, 8000) +
      "\n\n--- HIGHLIGHTED PART ---\n" +
      s.text.slice(0, 1500) +
      "\n\n--- QUESTION ---\n" +
      question
    );
  }

  function buildFollowupPrompt(note, q) {
    return (
      "You are helping a student with a follow-up on their study note. " +
      "Answer briefly (2-4 sentences max), no preamble.\n\n" +
      "--- ORIGINAL HIGHLIGHT ---\n" +
      note.selection.slice(0, 1500) +
      "\n\n--- PREVIOUS Q ---\n" +
      note.question +
      "\n\n--- PREVIOUS A ---\n" +
      (note.answer || "") +
      "\n\n--- FOLLOW-UP QUESTION ---\n" +
      q
    );
  }

  // Locate a follow-up node by its index path ("0", "0.2", "0.2.1", …).
  function getNodeByPath(note, pathStr) {
    let nodes = note.followups || [];
    let node = null;
    for (const i of pathStr.split(".").map(Number)) {
      node = nodes[i];
      if (!node) return null;
      nodes = node.children || [];
    }
    return node;
  }

  // Reply to any follow-up (recursive depth). Context = last 2 Q&A turns on the
  // path (nearest ancestor + the node itself) to keep prompts small at any depth.
  function buildSubFollowupPrompt(note, pathStr, q) {
    const turns = [{ q: note.question, a: note.answer || "" }];
    let nodes = note.followups || [];
    for (const i of pathStr.split(".").map(Number)) {
      const node = nodes[i];
      if (!node) break;
      turns.push({ q: node.q, a: node.a || "" });
      nodes = node.children || [];
    }
    const last2 = turns.slice(-2);
    let ctx =
      "You are helping a student with a follow-up on their study note. " +
      "Answer briefly (2-4 sentences max), no preamble.\n\n" +
      "--- ORIGINAL HIGHLIGHT ---\n" +
      note.selection.slice(0, 1500);
    last2.forEach((t, i) => {
      ctx +=
        `\n\n--- PREVIOUS Q${i + 1} ---\n` +
        t.q +
        `\n--- PREVIOUS A${i + 1} ---\n` +
        (t.a || "").slice(0, 1500);
    });
    ctx += "\n\n--- FOLLOW-UP QUESTION ---\n" + q;
    return ctx;
  }

  // ---- retry: re-ask ChatGPT for a better answer ----

  function buildRetryPrompt(note, prevAnswer) {
    return (
      "You are helping a student annotate study material. The student was NOT " +
      "satisfied with your previous answer below — it may be unclear, too vague, " +
      "or inaccurate. Give a BETTER answer: correct, factual, and easy to " +
      "understand, explained differently from before. Be concise (2-4 sentences), " +
      "no preamble.\n\n" +
      "--- HIGHLIGHTED TEXT ---\n" +
      note.selection.slice(0, 1500) +
      "\n\n--- QUESTION ---\n" +
      note.question +
      "\n\n--- PREVIOUS (REJECTED) ANSWER ---\n" +
      (prevAnswer || "").slice(0, 2000) +
      "\n\n--- NOW GIVE AN IMPROVED, ACCURATE, CLEARER ANSWER ---"
    );
  }

  function buildRetryFollowupPrompt(note, pathStr, prevAnswer) {
    const idx = pathStr.split(".").map(Number);
    const node = getNodeByPath(note, pathStr);
    // context = last 2 Q&A turns of the ANCESTORS (exclude the node being retried)
    const turns = [{ q: note.question, a: note.answer || "" }];
    let nodes = note.followups || [];
    for (let k = 0; k < idx.length - 1; k++) {
      const nd = nodes[idx[k]];
      if (!nd) break;
      turns.push({ q: nd.q, a: nd.a || "" });
      nodes = nd.children || [];
    }
    const last2 = turns.slice(-2);
    let ctx =
      "You are helping a student with a follow-up on their study note. The student " +
      "was NOT satisfied with your previous answer below — it may be unclear, vague, " +
      "or inaccurate. Give a BETTER answer: correct and easy to understand, explained " +
      "differently. Be concise (2-4 sentences), no preamble.\n\n" +
      "--- ORIGINAL HIGHLIGHT ---\n" +
      note.selection.slice(0, 1500);
    last2.forEach((t, i) => {
      ctx +=
        `\n\n--- PREVIOUS Q${i + 1} ---\n` +
        t.q +
        `\n--- PREVIOUS A${i + 1} ---\n` +
        (t.a || "").slice(0, 1500);
    });
    ctx += "\n\n--- FOLLOW-UP QUESTION ---\n" + (node?.q || "");
    ctx +=
      "\n\n--- PREVIOUS (REJECTED) ANSWER ---\n" +
      (prevAnswer || "").slice(0, 2000);
    ctx += "\n\n--- NOW GIVE AN IMPROVED, ACCURATE, CLEARER ANSWER ---";
    return ctx;
  }

  async function retryNote(convoId, noteId) {
    const notes = await Store.getNotes(convoId);
    const n = notes.find((x) => x.id === noteId);
    if (!n || !n.answer || String(n.answer).startsWith("⏳")) return;
    const prev = n.answer;
    await Store.update(convoId, noteId, { answer: "⏳ retrying…" });
    renderList();
    const requestId = "r" + Date.now();
    liveAsks[requestId] = noteId; // stream progress live into .slm-a
    chrome.runtime
      .sendMessage({ type: "ASK", requestId, prompt: buildRetryPrompt(n, prev) })
      .then(async (resp) => {
        delete liveAsks[requestId];
        await Store.update(convoId, noteId, {
          answer: resp?.ok
            ? resp.answer
            : "⚠️ Failed: " + (resp?.error || "no response"),
        });
        toast(resp?.ok ? "New answer ready ✓" : "Retry failed ⚠️");
        renderList();
      });
  }

  async function retryFollowup(convoId, noteId, pathStr) {
    const notes = await Store.getNotes(convoId);
    const n = notes.find((x) => x.id === noteId);
    const node = n && getNodeByPath(n, pathStr);
    if (!node || !node.a || String(node.a).startsWith("⏳")) return;
    const prev = node.a;
    node.a = "⏳ retrying…";
    await Store.update(convoId, noteId, { followups: n.followups });
    renderList();
    const requestId = "r" + Date.now();
    chrome.runtime
      .sendMessage({
        type: "ASK",
        requestId,
        prompt: buildRetryFollowupPrompt(n, pathStr, prev),
      })
      .then(async (resp) => {
        const notes2 = await Store.getNotes(convoId);
        const n2 = notes2.find((x) => x.id === noteId);
        const node2 = getNodeByPath(n2, pathStr);
        if (node2)
          node2.a = resp?.ok
            ? resp.answer
            : "⚠️ Failed: " + (resp?.error || "no response");
        await Store.update(convoId, noteId, { followups: n2.followups });
        toast(resp?.ok ? "New answer ready ✓" : "Retry failed ⚠️");
        renderList();
      });
  }

  function askAI(note, prompt, streamTarget, followupQ) {
    const requestId = "r" + Date.now() + Math.random().toString(36).slice(2, 6);
    liveAsks[requestId] = note.id;
    chrome.runtime
      .sendMessage({ type: "ASK", requestId, prompt })
      .then(async (resp) => {
        const answer = resp?.ok
          ? resp.answer
          : "⚠️ Failed: " + (resp?.error || "no response");
        if (followupQ) {
          await Store.update(cid(), note.id, {
            followupAdd: { q: followupQ, a: answer, at: Date.now() },
          });
        } else {
          await Store.update(cid(), note.id, { answer });
        }
        toast(resp?.ok ? "Answer ready ✓" : "Ask failed ⚠️");
        delete liveAsks[requestId];
        closePopup();
        refresh();
        renderList(); // show the final answer in the sidebar (no-op if closed)
      })
      .catch(async (err) => {
        await Store.update(cid(), note.id, { answer: "⚠️ Failed: " + err });
        delete liveAsks[requestId];
        refresh();
        renderList();
      });
    if (streamTarget) streamTarget.dataset.slmStream = requestId;
  }

  // live streaming updates from the worker tab (relayed by background)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "ASK_PROGRESS") return;
    const noteId = liveAsks[msg.requestId];
    // popup stream box
    document
      .querySelectorAll(`[data-slm-stream="${msg.requestId}"]`)
      .forEach((n) => (n.textContent = msg.text));
    // sidebar answer element, if visible
    if (noteId) {
      document
        .querySelectorAll(`.slm-note[data-id="${noteId}"] .slm-a`)
        .forEach((n) => (n.textContent = msg.text));
    }
  });

  async function createNote(s, question, answer, type) {
    const note = {
      id: "n" + Date.now() + Math.random().toString(36).slice(2, 7),
      messageId: s.messageId,
      selection: s.text,
      question,
      answer,
      type: type || "general",
      followups: [],
      srs: { reps: 0, intervalDays: 0, due: null },
      createdAt: new Date().toISOString(),
    };
    await Store.add(cid(), title(), note);
    refresh();
    return note;
  }

  /* ---------- FAB + sidebar ---------- */

  function ensureFab(count) {
    let fab = document.querySelector(".slm-fab");
    if (!fab) {
      fab = el("button", "slm-fab");
      fab.innerHTML = I.note;
      fab.title = "StudyLM notes";
      fab.onclick = () => (sidebarEl ? closeSidebar() : openSidebar());
      document.body.appendChild(fab);
    }
    fab.setAttribute("data-count", count || "");
  }

  let sbState = { scope: "chat", q: "", type: "all" };

  async function openSidebar(focusNoteId) {
    closeSidebar();
    sidebarEl = el("div", "slm-sidebar slm-slide-in");
    sidebarEl.innerHTML = `
      <div class="slm-sb-head">
        <span class="slm-brand">${I.note}<b>StudyLM</b></span>
        <button class="slm-btn slm-review">${I.grad}<span>Review</span></button>
        <button class="slm-x" title="Close">${I.close}</button>
      </div>
      <div class="slm-sb-tools">
        <input class="slm-search" placeholder="Search notes…" value="${esc(sbState.q)}">
        <div class="slm-scope">
          <button class="slm-seg ${sbState.scope === "chat" ? "slm-seg-on" : ""}" data-scope="chat">This chat</button>
          <button class="slm-seg ${sbState.scope === "all" ? "slm-seg-on" : ""}" data-scope="all">All chats</button>
        </div>
        <div class="slm-chips slm-filter">
          <button class="slm-chip ${sbState.type === "all" ? "slm-chip-on" : ""}" data-type="all" style="--chip:#8e8ea0">All</button>
          ${typeChips(sbState.type)}
        </div>
      </div>
      <div class="slm-sb-list"></div>
      <div class="slm-sb-foot">
        <button class="slm-btn" data-exp="md" title="Export Markdown">${I.dl}<span>MD</span></button>
        <button class="slm-btn" data-exp="anki" title="Export Anki TSV">${I.dl}<span>Anki</span></button>
        <button class="slm-btn" data-exp="json" title="Backup JSON">${I.dl}<span>JSON</span></button>
        <button class="slm-btn" data-exp="import" title="Import JSON backup">${I.ul}<span>Import</span></button>
        <input type="file" accept=".json" class="slm-file" hidden>
      </div>`;
    document.body.appendChild(sidebarEl);

    sidebarEl.querySelector(".slm-x").onclick = closeSidebar;
    sidebarEl.querySelector(".slm-review").onclick = openQuiz;
    sidebarEl.querySelector(".slm-search").oninput = (e) => {
      sbState.q = e.target.value;
      renderList();
    };
    sidebarEl.querySelectorAll(".slm-seg").forEach((b) => {
      b.onclick = () => {
        sbState.scope = b.dataset.scope;
        sidebarEl
          .querySelectorAll(".slm-seg")
          .forEach((x) => x.classList.toggle("slm-seg-on", x === b));
        renderList();
      };
    });
    sidebarEl.querySelectorAll(".slm-filter .slm-chip").forEach((c) => {
      c.onclick = () => {
        sbState.type = c.dataset.type;
        sidebarEl
          .querySelectorAll(".slm-filter .slm-chip")
          .forEach((x) => x.classList.toggle("slm-chip-on", x === c));
        renderList();
      };
    });
    sidebarEl.querySelectorAll("[data-exp]").forEach((b) => {
      b.onclick = () => doExport(b.dataset.exp);
    });

    await renderList(focusNoteId);
  }

  function closeSidebar() {
    sidebarEl?.remove();
    sidebarEl = null;
  }

  async function renderList(focusNoteId) {
    if (!sidebarEl) return;
    const list = sidebarEl.querySelector(".slm-sb-list");
    const all = await Store.getAll();
    const entries =
      sbState.scope === "chat"
        ? { [cid()]: all[cid()] || { title: title(), notes: [] } }
        : all;

    const q = sbState.q.toLowerCase();
    let html = "";
    for (const [convoId, convo] of Object.entries(entries)) {
      const notes = (convo.notes || []).filter((n) => {
        if (sbState.type !== "all" && n.type !== sbState.type) return false;
        if (!q) return true;
        return (n.selection + n.question + (n.answer || ""))
          .toLowerCase()
          .includes(q);
      });
      if (!notes.length) continue;
      if (sbState.scope === "all")
        html += `<div class="slm-convo-title">${esc(convo.title || convoId)}</div>`;
      html += notes.map((n) => noteCard(n, convoId)).join("");
    }
    list.innerHTML =
      html ||
      `<div class="slm-empty">${I.note}<p>No notes yet</p><span>Select text in a ChatGPT answer<br>and press <kbd>Alt</kbd>+<kbd>N</kbd></span></div>`;

    // wire note buttons
    list.querySelectorAll(".slm-note").forEach((card) => {
      const noteId = card.dataset.id;
      const convoId = card.dataset.cid;
      card.querySelector(".slm-del").onclick = async () => {
        await Store.remove(convoId, noteId);
        toast("Note deleted");
        renderList();
        refresh();
      };
      const retryBtn = card.querySelector(".slm-note-top .slm-retry");
      if (retryBtn) retryBtn.onclick = () => retryNote(convoId, noteId);
      const jump = card.querySelector(".slm-jump");
      if (jump)
        jump.onclick = async () => {
          const notes = await Store.getNotes(convoId);
          const n = notes.find((x) => x.id === noteId);
          const msgEl = n && A.findMessageById(n.messageId);
          if (msgEl) {
            msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
            msgEl.classList.add("slm-flash");
            setTimeout(() => msgEl.classList.remove("slm-flash"), 1600);
          } else toast("Message not on this page");
        };
      const fu = card.querySelector(".slm-fu");
      if (fu)
        fu.onclick = async () => {
          const box = card.querySelector(".slm-fu-box");
          box.hidden = !box.hidden;
          box.querySelector("input")?.focus();
        };
      const fuInput = card.querySelector(".slm-fu-box input");
      if (fuInput)
        fuInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            card.querySelector(".slm-fu-send")?.click();
          }
        });
      const fuSend = card.querySelector(".slm-fu-send");
      if (fuSend)
        fuSend.onclick = async () => {
          const inp = card.querySelector(".slm-fu-box input");
          const q = inp.value.trim();
          if (!q) return;
          const notes = await Store.getNotes(convoId);
          const n = notes.find((x) => x.id === noteId);
          await Store.update(convoId, noteId, {
            followupAdd: { q, a: "⏳ waiting…", at: Date.now() },
          });
          renderList();
          // ask, then replace the placeholder
          const requestId = "r" + Date.now();
          chrome.runtime
            .sendMessage({
              type: "ASK",
              requestId,
              prompt: buildFollowupPrompt(n, q),
            })
            .then(async (resp) => {
              const notes2 = await Store.getNotes(convoId);
              const n2 = notes2.find((x) => x.id === noteId);
              const f = n2.followups.find((f) => f.q === q && f.a === "⏳ waiting…");
              if (f)
                f.a = resp?.ok
                  ? resp.answer
                  : "⚠️ Failed: " + (resp?.error || "no response");
              await Store.update(convoId, noteId, { followups: n2.followups });
              toast(resp?.ok ? "Follow-up answered ✓" : "Ask failed ⚠️");
              renderList();
            });
        };

      // recursive: a reply button on every follow-up answer, any depth
      card.querySelectorAll(".slm-followup").forEach((fuEl) => {
        const path = fuEl.dataset.path;
        const rt = fuEl.querySelector(":scope > .slm-fu-line > .slm-retry");
        if (rt) rt.onclick = () => retryFollowup(convoId, noteId, path);
        const sfu = fuEl.querySelector(":scope > .slm-fu-line > .slm-sfu");
        const box = fuEl.querySelector(":scope > .slm-sfu-box");
        if (!sfu || !box) return;
        const inp = box.querySelector("input");
        sfu.onclick = () => {
          box.hidden = !box.hidden;
          if (!box.hidden) inp.focus();
        };
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            box.querySelector(".slm-sfu-send").click();
          }
        });
        box.querySelector(".slm-sfu-send").onclick = async () => {
          const q = inp.value.trim();
          if (!q) return;
          const notes = await Store.getNotes(convoId);
          const n = notes.find((x) => x.id === noteId);
          const node = getNodeByPath(n, path);
          if (!node) return;
          node.children = node.children || [];
          node.children.push({ q, a: "⏳ waiting…", at: Date.now() });
          await Store.update(convoId, noteId, { followups: n.followups });
          renderList();
          const requestId = "r" + Date.now();
          chrome.runtime
            .sendMessage({
              type: "ASK",
              requestId,
              prompt: buildSubFollowupPrompt(n, path, q),
            })
            .then(async (resp) => {
              const notes2 = await Store.getNotes(convoId);
              const n2 = notes2.find((x) => x.id === noteId);
              const node2 = getNodeByPath(n2, path);
              const c = node2?.children?.find(
                (c) => c.q === q && c.a === "⏳ waiting…"
              );
              if (c)
                c.a = resp?.ok
                  ? resp.answer
                  : "⚠️ Failed: " + (resp?.error || "no response");
              await Store.update(convoId, noteId, { followups: n2.followups });
              toast(resp?.ok ? "Follow-up answered ✓" : "Ask failed ⚠️");
              renderList();
            });
        };
      });
    });

    if (focusNoteId) {
      const target = list.querySelector(`.slm-note[data-id="${focusNoteId}"]`);
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.classList.add("slm-flash");
        setTimeout(() => target.classList.remove("slm-flash"), 1600);
      }
    }
  }

  // Recursively render follow-ups. Children are wrapped in .slm-kids so each
  // node's own controls stay reachable via ":scope >" (no descendant clashes).
  function followupTree(nodes, basePath) {
    return (nodes || [])
      .map((f, i) => {
        const path = basePath ? basePath + "." + i : String(i);
        const kids =
          f.children && f.children.length
            ? `<div class="slm-kids">${followupTree(f.children, path)}</div>`
            : "";
        return `
        <div class="slm-followup" data-path="${path}">
          <div class="slm-fu-line"><b>↳ ${esc(f.q)}</b>
            ${
              f.a && !String(f.a).startsWith("⏳")
                ? `<button class="slm-mini slm-retry" title="Retry — get a clearer, more accurate answer">${I.retry}</button>`
                : ""
            }
            <button class="slm-mini slm-sfu" title="Ask a follow-up on this answer">${I.reply}</button>
          </div>
          <div>${esc(f.a || "")}</div>
          ${kids}
          <div class="slm-sfu-box" hidden>
            <input placeholder="Follow-up on this answer…">
            <button class="slm-btn slm-primary slm-sfu-send">Ask</button>
          </div>
        </div>`;
      })
      .join("");
  }

  function noteCard(n, convoId) {
    const t = TYPES[n.type] || TYPES.general;
    return `
      <div class="slm-note" data-id="${n.id}" data-cid="${esc(convoId)}"
           style="--note-color:${t.color}">
        <div class="slm-note-top">
          <span class="slm-type" style="--chip:${t.color}"><i class="slm-dot"></i>${t.label}</span>
          <span class="slm-note-btns">
            <button class="slm-mini slm-jump" title="Jump to highlight">${I.target}</button>
            ${
              n.answer && !String(n.answer).startsWith("⏳")
                ? `<button class="slm-mini slm-retry" title="Retry — get a clearer, more accurate answer">${I.retry}</button>`
                : ""
            }
            <button class="slm-mini slm-fu" title="Ask follow-up">${I.reply}</button>
            <button class="slm-mini slm-del" title="Delete">${I.trash}</button>
          </span>
        </div>
        <blockquote class="slm-quote">${esc(smartTrim(n.selection, 180))}</blockquote>
        <div class="slm-q">Q: ${esc(n.question)}</div>
        ${n.answer ? `<div class="slm-a">${esc(n.answer)}</div>` : ""}
        ${followupTree(n.followups, "")}
        <div class="slm-fu-box" hidden>
          <input placeholder="Follow-up question…">
          <button class="slm-btn slm-primary slm-fu-send">Ask</button>
        </div>
      </div>`;
  }

  async function doExport(kind) {
    const all = await Store.getAll();
    const scope = sbState.scope === "chat" ? cid() : null;
    if (kind === "md")
      Store.download("studylm-notes.md", Store.exportMarkdown(all, scope), "text/markdown");
    else if (kind === "anki")
      Store.download("studylm-anki.txt", Store.exportAnki(all, scope));
    else if (kind === "json")
      Store.download("studylm-backup.json", Store.exportJSON(all), "application/json");
    else if (kind === "import") {
      const file = sidebarEl.querySelector(".slm-file");
      file.onchange = async () => {
        try {
          const n = await Store.importJSON(await file.files[0].text());
          toast(`Imported ${n} note${n === 1 ? "" : "s"} ✓`);
          renderList();
          refresh();
        } catch (e) {
          toast("Import failed ⚠️");
        }
      };
      file.click();
    }
  }

  /* ---------- quiz / review mode ---------- */

  async function openQuiz() {
    quizEl?.remove();
    const all = await Store.getAll();
    const scope = sbState.scope === "chat" ? [cid()] : Object.keys(all);
    let cards = [];
    for (const c of scope) {
      for (const n of (all[c]?.notes || [])) cards.push({ n, c });
    }
    const due = cards.filter(({ n }) => Store.dueNotes([n]).length);
    if (due.length) cards = due;
    cards = cards.filter(({ n }) => n.answer);
    if (!cards.length) return toast("No answered notes to review yet");
    cards.sort(() => Math.random() - 0.5);

    let i = 0;
    quizEl = el("div", "slm-quiz slm-pop-in");
    document.body.appendChild(quizEl);
    show();

    function show() {
      const { n } = cards[i];
      const t = TYPES[n.type] || TYPES.general;
      quizEl.innerHTML = `
        <div class="slm-quiz-card" style="--note-color:${t.color}">
          <div class="slm-progress"><i style="width:${Math.round((i / cards.length) * 100)}%"></i></div>
          <div class="slm-quiz-head">
            <span class="slm-brand">${I.grad}<b>Review</b></span>
            <span class="slm-hint">${i + 1} / ${cards.length}</span>
            <button class="slm-x">${I.close}</button></div>
          <span class="slm-type" style="--chip:${t.color}"><i class="slm-dot"></i>${t.label}</span>
          <blockquote class="slm-quote">${esc(smartTrim(n.selection, 220))}</blockquote>
          <div class="slm-q">${esc(n.question)}</div>
          <div class="slm-quiz-answer" hidden>${esc(n.answer)}</div>
          <div class="slm-row slm-quiz-actions">
            <button class="slm-btn slm-primary slm-reveal">Show answer</button>
          </div>
          <div class="slm-row slm-grades" hidden>
            <button class="slm-btn slm-g slm-g-again" data-g="again">Again</button>
            <button class="slm-btn slm-g slm-g-good" data-g="good">Good</button>
            <button class="slm-btn slm-g slm-g-easy" data-g="easy">Easy</button>
          </div>
        </div>`;
      quizEl.querySelector(".slm-x").onclick = () => {
        quizEl.remove();
        quizEl = null;
      };
      quizEl.querySelector(".slm-reveal").onclick = () => {
        quizEl.querySelector(".slm-quiz-answer").hidden = false;
        quizEl.querySelector(".slm-quiz-actions").hidden = true;
        quizEl.querySelector(".slm-grades").hidden = false;
      };
      quizEl.querySelectorAll(".slm-g").forEach((b) => {
        b.onclick = async () => {
          const { n, c } = cards[i];
          Store.grade(n, b.dataset.g);
          await Store.update(c, n.id, { srs: n.srs });
          i++;
          if (i < cards.length) show();
          else {
            toast("Review complete 🎉");
            quizEl.remove();
            quizEl = null;
          }
        };
      });
    }
  }

  /* ---------- badges + highlights refresh ---------- */

  async function refresh() {
    const notes = await Store.getNotes(cid());
    ensureFab(notes.length);

    document.querySelectorAll(".slm-badge").forEach((b) => b.remove());
    const byMsg = {};
    for (const n of notes) (byMsg[n.messageId] = byMsg[n.messageId] || []).push(n);

    const hlEntries = [];
    for (const [mid, list] of Object.entries(byMsg)) {
      const msgEl = A.findMessageById(mid);
      if (!msgEl) continue;
      const badge = el("button", "slm-badge");
      badge.innerHTML =
        I.note + `<span>${list.length} note${list.length > 1 ? "s" : ""}</span>`;
      badge.onclick = () => openSidebar(list[0].id);
      msgEl.appendChild(badge);
      for (const n of list) hlEntries.push({ note: n, messageEl: msgEl });
    }
    HL?.apply(hlEntries);
  }

  /* ---------- SPA survival ---------- */

  let debounce = null;
  new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!document.querySelector(".slm-badge")) refresh();
    }, 800);
  }).observe(document.body, { childList: true, subtree: true });

  // Watch the CONVERSATION (path), not the full URL. ChatGPT mutates the query
  // string / hash during an ask — reacting to those was closing the sidebar on
  // the first question. Only act on a real conversation change, and when it does
  // change, re-render the sidebar in place instead of closing it.
  let lastCid = cid();
  setInterval(() => {
    const now = cid();
    if (now !== lastCid) {
      lastCid = now;
      refresh();
      if (sidebarEl) renderList();
    }
  }, 1000);

  /* ---------- utils ---------- */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  refresh();
})();
// slm
