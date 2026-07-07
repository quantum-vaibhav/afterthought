// StudyLM — persistent highlights via the CSS Custom Highlight API (Chrome 105+)
// Re-paints saved selections inside messages; clicking a highlight opens its note.

(function () {
  "use strict";

  const supported = typeof Highlight !== "undefined" && CSS.highlights;
  const registries = {}; // type -> Highlight
  let hitList = []; // [{range, noteId}]

  function registryFor(type) {
    if (!registries[type]) {
      registries[type] = new Highlight();
      CSS.highlights.set("studylm-" + type, registries[type]);
    }
    return registries[type];
  }

  // Find `needle` inside root's text nodes (whitespace-normalized), return a Range.
  function findRange(root, needle) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let full = "";
    while (walker.nextNode()) {
      nodes.push({ node: walker.currentNode, start: full.length });
      full += walker.currentNode.data;
    }
    if (!full) return null;

    // normalized haystack + map: normalized index -> raw index
    let out = "";
    const map = [];
    let lastWs = true;
    for (let i = 0; i < full.length; i++) {
      if (/\s/.test(full[i])) {
        if (!lastWs) {
          out += " ";
          map.push(i);
        }
        lastWs = true;
      } else {
        out += full[i];
        map.push(i);
        lastWs = false;
      }
    }
    const needleN = needle.replace(/\s+/g, " ").trim();
    if (!needleN) return null;
    const idx = out.indexOf(needleN);
    if (idx < 0) return null;

    const rawStart = map[idx];
    const rawEnd = map[idx + needleN.length - 1] + 1;

    function locate(pos, isEnd) {
      for (let j = nodes.length - 1; j >= 0; j--) {
        if (nodes[j].start <= (isEnd ? pos - 1 : pos)) {
          return { node: nodes[j].node, offset: pos - nodes[j].start };
        }
      }
      return null;
    }
    const s = locate(rawStart, false);
    const e = locate(rawEnd, true);
    if (!s || !e) return null;
    const range = document.createRange();
    try {
      range.setStart(s.node, Math.min(s.offset, s.node.data.length));
      range.setEnd(e.node, Math.min(e.offset, e.node.data.length));
    } catch (_) {
      return null;
    }
    return range;
  }

  window.StudyLMHighlights = {
    supported,

    // notes: [{note, messageEl}]
    apply(entries) {
      if (!supported) return;
      for (const h of Object.values(registries)) h.clear();
      hitList = [];
      for (const { note, messageEl } of entries) {
        if (!messageEl) continue;
        const range = findRange(messageEl, note.selection);
        if (!range) continue;
        registryFor(note.type || "general").add(range);
        hitList.push({ range, noteId: note.id });
      }
    },

    // Return the noteId under a click point, or null.
    hitTest(x, y) {
      if (!supported) return null;
      const pos = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(x, y)
        : null;
      if (!pos) return null;
      for (const { range, noteId } of hitList) {
        try {
          if (range.isPointInRange(pos.startContainer, pos.startOffset)) {
            return noteId;
          }
        } catch (_) {}
      }
      return null;
    },

    clear() {
      for (const h of Object.values(registries)) h.clear();
      hitList = [];
    },
  };
})();
