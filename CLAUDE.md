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
npm test           # node --test — the test/ suite (no test framework, node:test only)
npm run test:e2e   # browser suites (e2e/browser.e2e.mjs, e2e/flows.e2e.mjs): the real src/ in Chromium via playwright-core
npm run test:desktop  # desktop suite (e2e/desktop.e2e.mjs): the built app via tauri-driver (Linux)
npm run dev        # tauri dev — run the app with a live-reloaded static frontend
npm run serve      # the frontend alone in a browser (no backend) at http://127.0.0.1:1420
npm run build      # tauri build — produce native binary + installers
npm run icons      # regenerate src-tauri/icons from assets/app-icon.png
npm run fonts      # download bundled Google Fonts (.woff2) for offline use (optional)
```

There is **no JS build step / bundler** — the frontend in `src/` is served as-is
(`frontendDist: "../src"`) as native ES modules. Edit and reload.

Quick checks after changing code:

```bash
node --check src/js/tree.js        # frontend syntax, per module
cd src-tauri && cargo check        # backend type-check (fast)
```

## Architecture

```
src/                     Frontend (served directly, no bundler)
  index.html             Static markup for the whole UI; loads js/main.js as a module
  styles.css             Theme + layout (CSS custom properties in :root)
  js/                    App logic, plain ES modules (one per area, see below)
  js/lib/                Pure logic: no DOM or app state at import time, imported by test/
  fonts/fonts.css        @font-face with system fallbacks
  fonts/pdf/*.ttf        IBM Plex Mono (OFL) — raw TrueType, embedded into PDF exports
test/                    node:test suites (no framework)
e2e/                     browser + UI-flow (playwright-core) and desktop (tauri-driver) regression suites
src-tauri/               Rust backend
  src/lib.rs             Commands, native menu, file I/O, window controls, recent files
  src/main.rs            Thin entry point -> novelcraft_lib::run()
  src/tests.rs           cargo test: file-access allowlist, atomic writes
  tauri.conf.json        Window (frameless: decorations=false), bundle, withGlobalTauri
  capabilities/default.json  Permission grants for the main window
assets/app-icon.png      Source icon (regenerate the set with `npm run icons`)
scripts/                 Node helpers: serve.mjs, make-icon.mjs, fetch-fonts.mjs
```

### Frontend modules (`src/js/`)

| Module | What it holds |
|---|---|
| `main.js` | Entry point: calls every module's `init()` in a fixed order, then `startup()` |
| `bridge.js` | `hasTauri`, `invoke`, `listen`, `pickPath` (native dialogs + the window shield) |
| `dom.js`, `state.js` | `$`/`$$` and shared elements; the open novel, selection and `dirty`, with setters |
| `dirty.js` | `markDirty`/`setSaved`, saved snapshots, the save indicator |
| `tree.js` | Scene/chapter tree, selection, CRUD + undo, breadcrumb, scene metadata, reordering |
| `novel-file.js` | New/open/load, `migrateNovel`, `setCurrentNovel`, recent files, title editing |
| `editor.js` | Editor input/paste, toolbar, markdown mode, document font and size |
| `entities.js`, `panels.js` | Characters/locations/races; counters, accordion, panel toggles, focus mode |
| `context-menu.js`, `dialogs.js` | `showCtx` + the tree menu; modal, `toast`, `toastAction` |
| `save.js`, `export.js`, `autosave.js`, `backups.js` | Save/Save As; quick exports; autosave + recovery; Restore from Backup |
| `notes.js`, `corkboard.js`, `graph.js`, `map.js` | Margin notes; corkboard; relationship graph; world map |
| `compile.js`, `compile-export.js` | The Compile dialog; building the HTML/TXT/PDF/EPUB/DOCX files |
| `shortcuts.js`, `menu.js`, `window-controls.js`, `settings.js` | Keyboard shortcuts; native menu events; frameless window; app prefs |
| `lib/*.js` | `text` (esc, uuid, countWords), `html` (sanitizer), `model`, `markdown`, `language`, `keys`, `compile-flow`, `zip`, `pdf`, `epub`, `docx` |

A module only declares things when it is imported; anything that wires events goes in its
`init()`, which `main.js` calls in order (listeners on the same target run in the order they
were added). Imported bindings are read-only, so shared state that other modules change has a
setter next to it (`setNovel`, `setCurrentSceneId`, `setDirty`, …). Circular imports between
UI modules are fine as long as nothing calls into another module at import time. `lib/` must
never import a UI module: node imports `lib/` directly in the tests.

### Frontend ↔ backend bridge

`withGlobalTauri: true` exposes `window.__TAURI__`; `js/bridge.js` reads it once:

```js
export const hasTauri = !!TAURI;
export const invoke = hasTauri ? TAURI.core.invoke : async () => null;
```

Every backend call is `invoke('command_name', { args })`. The app degrades
gracefully in a plain browser (`hasTauri === false`) — file dialogs fall back to
`<input type=file>` / download links — so `npm run serve` is enough for quick UI work.
(Browsers do not load modules from `file://`, so `src/index.html` cannot be opened from disk.)

### Backend commands (`src-tauri/src/lib.rs`)

File I/O and dialogs (via `tauri-plugin-dialog`): `pick_open`, `pick_save`,
`read_text`, `write_text`, `write_binary` (base64 → file, for EPUB/DOCX exports),
`get_last_file`, `set_last_file`, `autosave`.
Backups: `.novel` files are always saved with `save_novel` (not `write_text`), which first
copies the version on disk to `<app local data>/backups/<hash of path>/<unix secs>.novel`
(at most one copy per 10 minutes, none when nothing changed; the newest 20 are kept plus one
per day for 30 days). `list_backups`, `read_backup` (name must be `<digits>.novel`) and
`backup_now` (taken before a restore) back the File → Restore from Backup… dialog.
Window controls (frameless window): `minimize_window`, `maximize_window`,
`unmaximize_window`, `close_window`, `is_maximized`, `set_decorations`,
`set_window_title`. Recent files (stored as `recent.json` in app config dir):
`get_recent_files`, `add_recent_file`. The native menu emits `menu` events
(payload = item id, e.g. `"save"`, or `"recent:<path>"`) that `js/menu.js` listens for.

### Data model

**One `.novel` file = one novel** (JSON: `version, title, settings, chapters[],
characters[], locations[], races[]`); chapters hold `scenes[]`, and a scene carries
`content` (HTML) + `markdownContent`. In `js/state.js`:

- `novel` — the currently-open novel object (or `null` = start menu / empty state).
- `currentFilePath` — path of the open file (`null` = never saved).
- `currentSceneId` — the scene in the editor; `currentChapterId` — its chapter.
- `refreshUI()` (`novel-file.js`) re-renders the whole UI from `novel`; guard null everywhere
  the editor/panels touch `novel`.

### Dirty-flag discipline (don't regress this)

- `isLoadingContent` is set `true` around any *programmatic* editor mutation
  (`loadSceneIntoEditor`, `refreshUI`, `toggleMarkdownMode`); `markDirty()` and the
  `input` handlers early-return while it is true.
- The editor `input` handler only marks dirty when `normalizeHTML(content)` differs
  from the per-scene saved snapshot (`savedContent`/`savedMd`, refreshed by
  `snapshotSaved()` on every save/load).
- Set dirty only on real edits (text input, formatting, title/entity edits); never on
  focus/selection, mode switches, panel toggles, or chapter/novel switches.

### Chapter reordering

Reordering uses **pointer events** (mousedown/mousemove/mouseup), NOT the HTML5 Drag
API — the latter is unreliable in the WebView2/Chromium webview with the global
`user-select: none`. A 5px movement threshold distinguishes click (select) from drag.
A click on a chapter row collapses it **in place** (`setChapterCollapsed`, no re-render — a
re-render detaches the row under the pointer and the double-click is lost). The second press
of a double-click renames the chapter that was clicked (`chapterClick`), not whatever row is
under the pointer by then, unless that press turns into a drag.

## Conventions

- Vanilla JS in native ES modules — no frameworks, no bundler, no npm packages in `src/`.
  Helpers: `$`/`$$` (query), `esc` (HTML-escape), `uuid`, `toast`, `confirmModal`/`promptModal`.
- Theme colors live as CSS custom properties in `:root` (`styles.css`); reuse them
  (`--bg`, `--panel`, `--editor-bg`, `--text`, `--accent`, …) rather than hardcoding.
- Keep the browser fallback working: guard Tauri-only calls behind `hasTauri`.
- Deleting a scene or chapter is immediate and undoable from the toast (`toastAction`);
  don't add "cannot be undone" confirmations back.
- Full Unicode / Cyrillic support is a requirement — don't assume ASCII.
- The window is **frameless** (`decorations: false`); custom controls live in the top
  bar and a "Use native title bar" toggle in Settings restores the OS frame.

### Security invariants (don't regress these)

`.novel` files may come from anyone, and the webview can reach the file system through the
backend. Three layers keep a crafted file from running code:

- **Scene HTML is sanitized** (`sanitizeSceneHTML`, allowlist in `js/lib/html.js`)
  when a novel is loaded (`setCurrentNovel` → `sanitizeNovelHTML`), when HTML is pasted, and
  again in previews/exports. Parse untrusted HTML only with `parseInert()` (DOMParser) —
  never `document.createElement(...).innerHTML`, which loads images and fires their handlers
  even for detached elements.
- **Everything interpolated into an HTML template is escaped**: `esc()` for text, `escAttr()`
  for attribute values, `safeColor()` for colours, `CSS.escape()` inside selectors. Prefer
  `textContent`/`.value` over templates. Numbers that come from the file are validated in
  `migrateNovel` (e.g. a scene's `wordCount`).
- **The CSP** in `tauri.conf.json` forbids inline scripts and event handlers; keep event
  wiring in JS (`addEventListener`/`.onclick =`), never `on*=` attributes.
- **The backend only touches paths the user chose**: `read_text`/`write_text`/`write_binary`/
  `set_last_file`/`add_recent_file` reject any path that did not come from `pick_open`/
  `pick_save` in this session or from the recent list / last file (`GrantedPaths`). New
  file-taking commands must call `check_path` too.

## Commits and pull requests

- **Never put a link to the agent's session or chat** (`Claude-Session: https://claude.ai/code/session_…`
  or any other conversation URL) in a commit message, PR title or body, or a review comment.
- **`Co-Authored-By: Claude …` appears once per PR, at the very end.** Only the PR's last
  commit carries the trailer; earlier commits don't. PRs are squash-merged, and GitHub joins
  every commit message into the squash commit, so a trailer on each commit would repeat it there.
  Don't add it to the PR body.

## Verifying changes

Prefer `node --check` + `npm test` + `cargo check` for fast feedback; run `npm run build`
to confirm the full bundle. The `test/` suite uses Node's built-in `node:test` (no
framework, no dependency) and covers pure logic only: it imports `src/js/lib/` directly. The
two functions it tests outside `lib/` (`migrateNovel`, `compileTXT`) sit between marker
comments and are lifted out with stand-ins for their DOM-bound helpers
(`test/helpers/lift.js`). UI behavior still has to be validated by running `npm run dev`.
CI runs `npm test` and `npm run test:e2e` in the `quick-check` job on every PR, and
`cargo test` + `npm run test:desktop` against a debug build in the `desktop-e2e` job.
Browser-level behavior (sanitizer, paste, shortcuts, the app under the CSP) belongs in
`e2e/browser.e2e.mjs`; anything needing the real backend, IPC or CSP in `e2e/desktop.e2e.mjs`.
Both reach app internals through `app.<name>`, a live view of every module's exports
(`exposeApp` in `e2e/support.mjs`), so a function they call must be exported.
`e2e/flows.e2e.mjs` drives whole user flows black-box (clicks, keys, drags; the downloaded
`.novel` is the oracle) and never touches app internals, so it must pass unchanged across a
refactor of the modules. Its `{ todo: 'bug: …' }` tests document known bugs: when you fix one,
drop the `todo` so the test guards the fix.
