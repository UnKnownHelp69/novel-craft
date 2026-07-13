# CLAUDE.md

Guidance for AI agents (and humans) working in this repository.

> This project was built collaboratively with an AI agent (Claude Code / Claude Opus).

## What this is

**NovelCraft** — a desktop novel-writing app built with **Tauri v2** (Rust backend)
and **vanilla HTML/CSS/JS** (no frontend framework). It compiles to native binaries
for Windows, macOS, and Linux.

## Commands

```bash
npm install        # install the Tauri CLI (@tauri-apps/cli)
npm run dev        # tauri dev — run the app with a live-reloaded static frontend
npm run build      # tauri build — produce native binary + installers
npm run icons      # regenerate src-tauri/icons from assets/app-icon.png
npm run fonts      # download bundled Google Fonts (.woff2) for offline use (optional)
```

There is **no JS build step / bundler** — the frontend in `src/` is served as-is
(`frontendDist: "../src"`). Edit and reload.

Quick checks after changing code:

```bash
node --check src/app.js            # frontend syntax
cd src-tauri && cargo check        # backend type-check (fast)
```

## Architecture

```
src/                     Frontend (served directly, no bundler)
  index.html             Static markup for the whole UI
  styles.css             Theme + layout (CSS custom properties in :root)
  app.js                 ALL app logic (one file, plain JS, no modules)
  fonts/fonts.css        @font-face with system fallbacks
src-tauri/               Rust backend
  src/lib.rs             Commands, native menu, file I/O, window controls, recent files
  src/main.rs            Thin entry point -> novelcraft_lib::run()
  tauri.conf.json        Window (frameless: decorations=false), bundle, withGlobalTauri
  capabilities/default.json  Permission grants for the main window
assets/app-icon.png      Source icon (regenerate the set with `npm run icons`)
scripts/                 Node helpers: make-icon.mjs, fetch-fonts.mjs
```

### Frontend ↔ backend bridge

`withGlobalTauri: true` exposes `window.__TAURI__`. `app.js` reads it once:

```js
const hasTauri = !!window.__TAURI__;
const invoke = hasTauri ? window.__TAURI__.core.invoke : async () => null;
```

Every backend call is `invoke('command_name', { args })`. The app degrades
gracefully in a plain browser (`hasTauri === false`) — file dialogs fall back to
`<input type=file>` / download links — so `src/` can be opened directly for quick UI work.

### Backend commands (`src-tauri/src/lib.rs`)

File I/O and dialogs (via `tauri-plugin-dialog`): `pick_open`, `pick_save`,
`read_text`, `write_text`, `write_binary` (base64 → file, for EPUB/DOCX exports),
`get_last_file`, `set_last_file`, `autosave`.
Window controls (frameless window): `minimize_window`, `maximize_window`,
`unmaximize_window`, `close_window`, `is_maximized`, `set_decorations`,
`set_window_title`. Recent files (stored as `recent.json` in app config dir):
`get_recent_files`, `add_recent_file`. The native menu emits `menu` events
(payload = item id, e.g. `"save"`, or `"recent:<path>"`) that `app.js` listens for.

### Data model

**One `.novel` file = one novel** (JSON: `version, title, settings, chapters[],
characters[], locations[], races[]`). In `app.js`:

- `novel` — the currently-open novel object (or `null` = start menu / empty state).
- `currentFilePath` — path of the open file (`null` = never saved).
- `currentChapterId` — active chapter; chapters carry `content` (HTML) + `markdownContent`.
- `refreshUI()` re-renders the whole UI from `novel`; guard null everywhere the
  editor/panels touch `novel`.

### Dirty-flag discipline (don't regress this)

- `isLoadingContent` is set `true` around any *programmatic* editor mutation
  (`loadChapterIntoEditor`, `refreshUI`, `toggleMarkdownMode`); `markDirty()` and the
  `input` handlers early-return while it is true.
- The editor `input` handler only marks dirty when `normalizeHTML(content)` differs
  from the per-chapter saved snapshot (`savedContent`/`savedMd`, refreshed by
  `snapshotSaved()` on every save/load).
- Set dirty only on real edits (text input, formatting, title/entity edits); never on
  focus/selection, mode switches, panel toggles, or chapter/novel switches.

### Chapter reordering

Reordering uses **pointer events** (mousedown/mousemove/mouseup), NOT the HTML5 Drag
API — the latter is unreliable in the WebView2/Chromium webview with the global
`user-select: none`. A 5px movement threshold distinguishes click (select) from drag.

## Conventions

- Vanilla JS only in `app.js` — no frameworks, no bundler, no ES module imports.
  Helpers: `$`/`$$` (query), `esc` (HTML-escape), `uuid`, `toast`, `confirmModal`/`promptModal`.
- Theme colors live as CSS custom properties in `:root` (`styles.css`); reuse them
  (`--bg`, `--panel`, `--editor-bg`, `--text`, `--accent`, …) rather than hardcoding.
- Keep the browser fallback working: guard Tauri-only calls behind `hasTauri`.
- Full Unicode / Cyrillic support is a requirement — don't assume ASCII.
- The window is **frameless** (`decorations: false`); custom controls live in the top
  bar and a "Use native title bar" toggle in Settings restores the OS frame.

## Verifying changes

Prefer `node --check` + `cargo check` for fast feedback; run `npm run build` to confirm
the full bundle. There is no automated test suite — validate UI behavior by running
`npm run dev`.
