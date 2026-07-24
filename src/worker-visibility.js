// AfterThought — keep the hidden worker tab "awake" (page-world part)
// Runs in the PAGE (MAIN) world, ONLY on the #slm-worker tab. ChatGPT (like most
// web apps) throttles/pauses its own streaming when its tab is backgrounded via
// the Page Visibility API. Forcing the page to always believe it is visible and
// focused keeps generation flowing while the tab stays in the background.
(function () {
  if (!location.hash.includes("slm-worker")) return;
  try {
    const spoof = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, { configurable: true, get: () => value });
      } catch (_) {}
    };
    spoof(document, "hidden", false);
    spoof(document, "visibilityState", "visible");
    spoof(document, "webkitHidden", false);
    spoof(document, "webkitVisibilityState", "visible");
    document.hasFocus = () => true;
    const swallow = (e) => e.stopImmediatePropagation();
    ["visibilitychange", "webkitvisibilitychange", "blur"].forEach((type) => {
      window.addEventListener(type, swallow, true);
      document.addEventListener(type, swallow, true);
    });

    // Browsers pause requestAnimationFrame entirely in background tabs, which
    // stops ChatGPT from painting the streamed answer. Route rAF through a timer
    // so rendering keeps happening while hidden (backup to the network capture).
    const rafCbs = new Map();
    let rafId = 1;
    window.requestAnimationFrame = function (cb) {
      const id = rafId++;
      const t = setTimeout(() => {
        rafCbs.delete(id);
        try {
          cb(performance.now());
        } catch (_) {}
      }, 32);
      rafCbs.set(id, t);
      return id;
    };
    window.cancelAnimationFrame = function (id) {
      const t = rafCbs.get(id);
      if (t) {
        clearTimeout(t);
        rafCbs.delete(id);
      }
    };
  } catch (_) {}
})();
