// AfterThought — capture ChatGPT's answer from the network (PAGE / MAIN world)
// Runs ONLY on the #slm-worker tab, at document_start, before ChatGPT grabs its
// own fetch reference. Browsers pause requestAnimationFrame in background tabs,
// so ChatGPT never paints the streamed answer until the tab is focused — which
// is why answers only appeared after tapping the tab. Network callbacks are NOT
// paused in the background, so we read the answer straight off the response
// stream. We ONLY capture the POST that generates a reply (not the page-load
// GETs), and never report "done" on an empty stream.
(function () {
  if (!location.hash.includes("slm-worker")) return;

  // The reply is a POST to /backend-api/conversation (or /f/conversation).
  const CONV = /\/backend-api\/(f\/)?conversation(?:$|\?)/;
  const post = (data) => {
    try {
      window.postMessage(Object.assign({ __aftg: 1 }, data), "*");
    } catch (_) {}
  };

  function applyOp(op, state) {
    if (!op || typeof op !== "object") return;
    if (Array.isArray(op.v) && (op.o === "patch" || op.o === undefined)) {
      op.v.forEach((o) => applyOp(o, state));
      return;
    }
    if (typeof op.v === "string" && (op.o === "append" || op.o === undefined)) {
      if (op.p === undefined || op.p === "" || /content\/parts/.test(op.p))
        state.text += op.v;
    }
  }
  function applyEvent(obj, state) {
    // Bare strings are protocol markers (e.g. "v1" = delta-encoding version),
    // NOT answer content — ignore them.
    if (typeof obj !== "object" || obj === null) return;
    const parts =
      obj &&
      obj.message &&
      obj.message.content &&
      Array.isArray(obj.message.content.parts) &&
      obj.message.content.parts;
    const role =
      obj && obj.message && obj.message.author && obj.message.author.role;
    if (parts && role !== "user") {
      state.text = parts.map((p) => (typeof p === "string" ? p : "")).join("");
      return;
    }
    applyOp(obj, state);
  }

  async function readStream(stream) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    const state = { text: "" };
    let buf = "";
    let sampled = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            post({ text: state.text, done: true });
            return;
          }
          if (sampled < 3) {
            sampled++;
            post({ sample: data.slice(0, 300) }); // for debugging the format
          }
          try {
            applyEvent(JSON.parse(data), state);
            if (state.text) post({ text: state.text, done: false });
          } catch (_) {}
        }
      }
      post({ text: state.text, done: true }); // stream ended (no [DONE])
    } catch (e) {
      post({ text: state.text, done: !!state.text, error: String(e) });
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    let url = "";
    let method = "GET";
    const input = args[0];
    const init = args[1];
    if (input && typeof input === "object" && "url" in input) {
      url = input.url || "";
      method = input.method || "GET";
    } else {
      url = String(input || "");
    }
    if (init && init.method) method = init.method;
    const isAnswer = method.toUpperCase() === "POST" && CONV.test(url);
    return origFetch.apply(this, args).then((res) => {
      try {
        if (isAnswer && res && res.body) readStream(res.clone().body);
      } catch (_) {}
      return res;
    });
  };
})();
