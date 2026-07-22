// StudyLM — ChatGPT adapter
// ALL site-specific DOM knowledge lives in this file. If ChatGPT changes its
// markup, fix it here. Adding Gemini/Claude later = write a new adapter with
// the same interface and load it for that host in manifest.json.

(function () {
  "use strict";

  // Selector lists are ordered: first match wins. Add new fallbacks at the top.
  const SEL = {
    assistantMessage: [
      '[data-message-author-role="assistant"]',
    ],
    composer: [
      "#prompt-textarea",
      'div[contenteditable="true"].ProseMirror',
      'textarea[data-testid="prompt-textarea"]',
    ],
    sendButton: [
      '[data-testid="send-button"]',
      "#composer-submit-button",
      'button[aria-label*="Send" i]',
    ],
    stopButton: [
      '[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
    ],
    copyButton: [
      '[data-testid="copy-turn-action-button"]',
      'button[aria-label*="Copy" i]',
    ],
  };

  function q(list, root = document) {
    for (const s of list) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function qa(list, root = document) {
    for (const s of list) {
      const els = root.querySelectorAll(s);
      if (els.length) return Array.from(els);
    }
    return [];
  }

  window.StudyLMAdapter = {
    provider: "chatgpt",

    newChatUrl: "https://chatgpt.com/?temporary-chat=true",

    // ---- reading messages ----

    getConversationId() {
      const m = location.pathname.match(/\/c\/([\w-]+)/);
      return m ? m[1] : "no-conversation";
    },

    getAssistantMessages() {
      return qa(SEL.assistantMessage);
    },

    // Walk up from any node to its containing assistant message, or null.
    getMessageContainer(node) {
      let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      while (el && el !== document.body) {
        if (el.matches && el.matches(SEL.assistantMessage.join(","))) return el;
        el = el.parentElement;
      }
      return null;
    },

    // Stable id for a message so notes survive re-renders. Positional index is a
    // last resort — it shifts when messages are edited/regenerated, mis-mapping
    // notes — so look on the element, an ancestor, then a descendant first.
    getMessageId(messageEl) {
      const explicit =
        messageEl.getAttribute("data-message-id") ||
        messageEl.closest("[data-message-id]")?.getAttribute("data-message-id") ||
        messageEl
          .querySelector("[data-message-id]")
          ?.getAttribute("data-message-id");
      if (explicit) return explicit;
      const all = this.getAssistantMessages();
      return "idx-" + all.indexOf(messageEl);
    },

    findMessageById(messageId) {
      if (messageId.startsWith("idx-")) {
        const i = parseInt(messageId.slice(4), 10);
        return this.getAssistantMessages()[i] || null;
      }
      return document.querySelector(
        `[data-message-id="${CSS.escape(messageId)}"]`
      );
    },

    getMessageText(messageEl) {
      // scope to the markdown body so related-link chips / UI text are excluded
      const md = messageEl.querySelector(".markdown");
      return ((md || messageEl).innerText || "").trim();
    },

    getLastAssistantText() {
      const all = this.getAssistantMessages();
      return all.length ? this.getMessageText(all[all.length - 1]) : "";
    },

    // ---- driving the composer (used only in the hidden worker tab) ----

    getComposer() {
      return q(SEL.composer);
    },

    setComposerText(text) {
      const el = this.getComposer();
      if (!el) return false;
      el.focus();
      if (el.tagName === "TEXTAREA") {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        ).set;
        setter.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        // contenteditable / ProseMirror: select all + insertText keeps the
        // editor's internal state in sync.
        document.getSelection().selectAllChildren(el);
        document.execCommand("insertText", false, text);
        if (!(el.innerText || "").trim()) {
          // fallback: synthetic paste event (ProseMirror handles natively)
          const dt = new DataTransfer();
          dt.setData("text/plain", text);
          el.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            })
          );
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    },

    clickSend() {
      const btn = q(SEL.sendButton);
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
      // Fallback: Enter keydown on composer
      const el = this.getComposer();
      if (!el) return false;
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
        })
      );
      return true;
    },

    isGenerating() {
      // true while ChatGPT is streaming a response
      return !!q(SEL.stopButton);
    },

    // A finished reply shows its action bar (copy button) under the turn.
    lastTurnComplete() {
      const msgs = this.getAssistantMessages();
      if (!msgs.length) return false;
      const last = msgs[msgs.length - 1];
      const turn =
        last.closest('section[data-testid^="conversation-turn"], article') ||
        last.parentElement?.parentElement?.parentElement;
      return !!(turn && q(SEL.copyButton, turn));
    },
  };
})();
