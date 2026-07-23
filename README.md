# AfterThought

Chrome extension: select any text in a ChatGPT answer, attach a question or note, and optionally get a short AI answer pinned inline — without polluting your main conversation.

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Open or reload chatgpt.com

## Usage

1. Select text inside any ChatGPT answer → a **📝 Note** button appears (or press **Alt+N**)
2. Pick a note type (General / Definition / Doubt / Important / To-do), type your question
3. **Save note** — stores it locally, or **Ask AI & save** — opens a hidden temporary ChatGPT chat, asks your question with the selection + full message as context, and streams the answer live into the note
4. Saved selections stay highlighted in the message (color-coded by type); click a highlight to open its note
5. The floating **📝** button (right edge) opens the sidebar: search, filter by type, "This chat / All chats" scope, follow-up questions per note, jump-to-highlight
6. Export from the sidebar footer: **Markdown**, **Anki** (tab-separated, import with "Fields separated by: Tab"), **JSON backup** + import

Notes are stored per-conversation in `chrome.storage.local`. Theme follows ChatGPT's light/dark mode.

## How "Ask AI" works

`background.js` opens an inactive tab at `chatgpt.com/?temporary-chat=true#slm-worker`. The content script detects the `#slm-worker` hash, types the prompt into the composer, sends it, waits for generation to finish, returns the answer, and the tab is closed. Temporary-chat mode keeps these queries out of your history.

**Caveats:** you must be logged in to ChatGPT; each ask takes 10–60s; automating the web UI is fragile (see below) and gray-area under OpenAI's ToS — for personal/study use, but be aware. A future "bring your own API key" mode would be more robust.

## When ChatGPT's DOM changes (it will)

All site-specific selectors live in **`src/adapter-chatgpt.js`** (`SEL` object at the top). If the extension stops working, inspect the page and update the selectors there — nothing else should need touching.

## Adding Gemini / Claude later

1. Copy `adapter-chatgpt.js` → `adapter-gemini.js`, implement the same interface (`getAssistantMessages`, `getMessageContainer`, `setComposerText`, `clickSend`, `isGenerating`, …)
2. Add a second `content_scripts` entry in `manifest.json` for that host loading the new adapter + `content.js`
3. Add the host to `host_permissions` and route `WORKER_URL` in `background.js` by provider

## Structure

```
manifest.json          MV3 manifest
src/
  adapter-chatgpt.js   all ChatGPT DOM selectors/helpers (fix breakages here)
  content.js           selection UI, notes popup, badges, storage + worker automation
  background.js        hidden-tab orchestration for "Ask AI"
  styles.css           injected UI styles
```

## Roadmap ideas

- Export notes (markdown/Anki)
- Bring-your-own API key backend (robust alternative to tab automation)
- Gemini and Claude adapters
- Highlight persistence (re-mark the selected text in the message)
