// StudyLM — storage layer (v2)
// Shape: { [convoId]: { title, notes: [Note] } }
// Note: { id, messageId, selection, question, answer, type, followups:[{q,a,at}],
//         srs:{reps,intervalDays,due}, createdAt }

(function () {
  "use strict";

  const KEY = "studylm_notes_v2";
  const LEGACY_KEY = "studylm_notes";

  const TYPES = {
    general: { label: "General", icon: "📝", color: "#10a37f" },
    definition: { label: "Definition", icon: "📖", color: "#3b82f6" },
    doubt: { label: "Doubt", icon: "❓", color: "#f59e0b" },
    important: { label: "Important", icon: "⭐", color: "#ef4444" },
    todo: { label: "To-do", icon: "✅", color: "#8b5cf6" },
  };

  function normNote(n) {
    return Object.assign(
      {
        type: "general",
        followups: [],
        srs: { reps: 0, intervalDays: 0, due: null },
        answer: null,
      },
      n
    );
  }

  async function loadAll() {
    const r = await chrome.storage.local.get([KEY, LEGACY_KEY]);
    let data = r[KEY] || null;
    // migrate v1 ({cid: Note[]}) -> v2
    if (!data && r[LEGACY_KEY]) {
      data = {};
      for (const [cid, notes] of Object.entries(r[LEGACY_KEY])) {
        data[cid] = { title: "", notes: notes.map(normNote) };
      }
      await chrome.storage.local.set({ [KEY]: data });
      await chrome.storage.local.remove(LEGACY_KEY);
    }
    data = data || {};
    for (const c of Object.values(data)) c.notes = c.notes.map(normNote);
    return data;
  }

  async function saveAll(data) {
    await chrome.storage.local.set({ [KEY]: data });
  }

  window.StudyLMStore = {
    TYPES,

    async getAll() {
      return loadAll();
    },

    async getNotes(cid) {
      const all = await loadAll();
      return all[cid]?.notes || [];
    },

    async add(cid, title, note) {
      const all = await loadAll();
      all[cid] = all[cid] || { title: "", notes: [] };
      if (title) all[cid].title = title;
      all[cid].notes.push(normNote(note));
      await saveAll(all);
      return note;
    },

    async update(cid, noteId, patch) {
      const all = await loadAll();
      const n = (all[cid]?.notes || []).find((n) => n.id === noteId);
      if (n) {
        if (patch.followupAdd) {
          n.followups.push(patch.followupAdd);
          delete patch.followupAdd;
        }
        Object.assign(n, patch);
        await saveAll(all);
      }
      return n;
    },

    async remove(cid, noteId) {
      const all = await loadAll();
      if (all[cid]) {
        all[cid].notes = all[cid].notes.filter((n) => n.id !== noteId);
        if (!all[cid].notes.length) delete all[cid];
        await saveAll(all);
      }
    },

    // ---- spaced repetition (SM-2 lite) ----

    dueNotes(notes) {
      const now = Date.now();
      return notes.filter(
        (n) => n.answer && (!n.srs.due || n.srs.due <= now)
      );
    },

    grade(note, g) {
      // g: 'again' | 'good' | 'easy'
      const s = note.srs;
      if (g === "again") {
        s.reps = 0;
        s.intervalDays = 0;
        s.due = Date.now() + 10 * 60 * 1000; // 10 min
      } else {
        s.reps++;
        const mult = g === "easy" ? 3.5 : 2.5;
        s.intervalDays = s.intervalDays
          ? Math.round(s.intervalDays * mult)
          : g === "easy"
          ? 3
          : 1;
        s.due = Date.now() + s.intervalDays * 86400000;
      }
      return s;
    },

    // ---- export / import ----

    exportMarkdown(all, onlyCid) {
      let md = "# StudyLM notes\n";
      for (const [cid, convo] of Object.entries(all)) {
        if (onlyCid && cid !== onlyCid) continue;
        md += `\n## ${convo.title || cid}\n`;
        for (const n of convo.notes) {
          const t = TYPES[n.type] || TYPES.general;
          md += `\n### ${t.icon} ${n.question}\n\n`;
          md += `> ${n.selection.replace(/\n/g, "\n> ")}\n\n`;
          if (n.answer) md += `${n.answer}\n`;
          for (const f of n.followups) {
            md += `\n**↳ ${f.q}**\n\n${f.a || ""}\n`;
          }
        }
      }
      return md;
    },

    exportAnki(all, onlyCid) {
      // TSV: front <tab> back — import in Anki with "Fields separated by: Tab"
      const rows = [];
      for (const [cid, convo] of Object.entries(all)) {
        if (onlyCid && cid !== onlyCid) continue;
        for (const n of convo.notes) {
          if (!n.answer) continue;
          const clean = (s) => s.replace(/\t/g, " ").replace(/\n/g, "<br>");
          rows.push(
            clean(n.question + "<br><i>" + n.selection.slice(0, 200) + "</i>") +
              "\t" +
              clean(n.answer)
          );
        }
      }
      return rows.join("\n");
    },

    exportJSON(all) {
      return JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), data: all }, null, 2);
    },

    async importJSON(text) {
      const parsed = JSON.parse(text);
      const incoming = parsed.data || parsed; // accept raw dumps too
      const all = await loadAll();
      let count = 0;
      for (const [cid, convo] of Object.entries(incoming)) {
        all[cid] = all[cid] || { title: convo.title || "", notes: [] };
        const have = new Set(all[cid].notes.map((n) => n.id));
        for (const n of convo.notes || []) {
          if (!have.has(n.id)) {
            all[cid].notes.push(normNote(n));
            count++;
          }
        }
      }
      await saveAll(all);
      return count;
    },

    download(filename, text, mime = "text/plain") {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  };
})();
