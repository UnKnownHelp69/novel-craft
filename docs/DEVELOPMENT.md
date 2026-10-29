# NovelCraft — development guide

Everything technical about NovelCraft: how it is built, where it keeps data, the file format,
and how to build, run and test it. The user-facing overview is the [README](../README.md).
Architecture notes and the invariants contributors must not break are in
[CLAUDE.md](../CLAUDE.md); releases are described in [RELEASING.md](../RELEASING.md).

NovelCraft is a desktop app built with **Tauri v2** (Rust backend) and plain HTML/CSS/JS in
native ES modules (no framework, no bundler). One `.novel` file holds one novel.

## Where data lives

The desktop app keeps everything outside the `.novel` file in two per-user directories named
after the app identifier `com.novelcraft.desktop`:

| | App config dir | App local data dir |
|---|---|---|
| Linux | `~/.config/com.novelcraft.desktop/` | `~/.local/share/com.novelcraft.desktop/` |
| macOS | `~/Library/Application Support/com.novelcraft.desktop/` | same as config |
| Windows | `%APPDATA%\com.novelcraft.desktop\` | `%LOCALAPPDATA%\com.novelcraft.desktop\` |

- **The novel itself** is the `.novel` file the user chose. While there are unsaved changes, the
  app **writes them to that file every 30 seconds** on its own; `Ctrl/Cmd+S` just does it now.
- **Crash recovery**: every 10 seconds while there are unsaved changes, a copy goes to
  `working.novel` in the config dir. If one is left over at the next launch (after a crash, say),
  the app offers to restore it. If the file it came from can no longer be written (see *Security*
  below), it is restored as an unsaved novel and Save asks where to put it. The copy is deleted
  once the novel is saved, or when the user closes and chooses not to save.
- **Backups**: each time a save overwrites a `.novel`, the previous version is first copied to
  `backups/<hash of the file's path>/<unix seconds>.novel` in the local data dir — at most one
  copy per 10 minutes per file, none if an identical copy exists. The newest 20 are kept, plus the
  newest of each day for 30 days. Restore with **File ▸ Restore from Backup…** (or the button in
  Settings); the current file is backed up first, so a restore can itself be undone. Backups are
  keyed by path: after moving or renaming a `.novel` its old backups are no longer listed (they
  are still on disk; `source.txt` in each folder names the original file).
- **Recent files** (the last 5) in `recent.json`, the file to reopen at launch in
  `last_file.txt`, window size and position in `.window-state.json` — all in the config dir.
- **UI preferences** (native title bar, typewriter mode, note display) are stored in the webview's
  local storage, not in the `.novel`. Per-novel settings (font, word goal, note types, compile
  presets, export language) are in the `.novel`.

In browser mode (see *Development* below) there are no backups or recent files, the recovery
copy goes to the browser's `localStorage` (a novel with a large map image can exceed its quota —
the app then says so), and Save downloads the file.

## The `.novel` format

Plain JSON, one novel per file:

```jsonc
{
  "version": "1.0",
  "title": "My Novel",
  "settings": {
    "fontSize": 18, "defaultFont": "Georgia, serif", "wordGoal": 80000,
    "customNoteTypes": [], "noteTypeColors": {}, "language": null,   // null = auto-detect
    "worldMap": { "backgroundImage": "", "locations": {}, "routes": [], "layers": [], "baseLayers": {} },
    "compilationPresets": []
  },
  "chapters": [ {
    "id": "…", "order": 0, "title": "Chapter 1", "wordCount": 0, "collapsed": false,
    "scenes": [ {
      "id": "…", "order": 0, "title": "Scene 1", "content": "<p>…</p>", "markdownContent": "…",
      "wordCount": 0, "povCharacter": null, "location": null, "timeOfDay": "morning",
      "status": "draft", "notes": [], "createdAt": "…", "modifiedAt": "…"
    } ]
  } ],
  "characters": [ /* …, relationships: [{ targetCharacterId, type, strength, status, … }], graphPosition: { x, y } */ ],
  "locations":  [ /* name, type, description, history, atmosphere, notes */ ],
  "races":      [ /* name, description, appearance, culture, history, traits */ ]
}
```

Scenes store their text twice: `content` (HTML, what the visual editor and the exports use) and
`markdownContent`. The world map's background image is stored inline as a data URL, so it grows
the file by roughly its own size.

**Older files open in newer builds** (`migrateNovel` in `src/js/novel-file.js`). A pre-scenes
chapter with its own `content` becomes a chapter with one scene; a character's old free-text
`relationships` field is kept as `relationshipNotes`. A multi-novel *library* file (top-level
`novels` array) opens its active novel **as unsaved**, so it can't be overwritten with a single
novel, and offers to split the library into one file per novel.

**Security.** A `.novel` from someone else is treated as untrusted: scene HTML is sanitized against
an allowlist on load, the webview runs under a strict CSP, and the backend only reads or writes
paths the user picked in a file dialog (or opened in an earlier session, via the recent list / last
file). The details, which contributors must preserve, are in
[CLAUDE.md](../CLAUDE.md#security-invariants-dont-regress-these).

## Building from source

### Prerequisites

- **Rust** stable (via <https://rustup.rs>).
- **Node.js 20.11 or newer.** The Tauri CLI alone runs on Node 18, but the test suites use
  `import.meta.dirname`. CI uses the current LTS.
- The system packages Tauri v2 needs ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)):
  - **Linux (Debian/Ubuntu)** — exactly what CI installs:
    ```bash
    sudo apt-get install -y build-essential libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils
    ```
    Tauri v2 needs **webkit2gtk 4.1** (Ubuntu 22.04 / Debian 12 or newer); the 4.0 package of older
    distributions does not work. These are required even for `cargo check`, because the
    `webkit2gtk-sys` build script probes them with `pkg-config`.
  - **macOS** — Xcode Command Line Tools (`xcode-select --install`).
  - **Windows** — Microsoft C++ Build Tools ("Desktop development with C++") and the WebView2
    runtime (preinstalled on Windows 11). The MSI and NSIS installer tools are downloaded by the
    Tauri CLI on first build.

### Build

```bash
npm install
npm run build        # = tauri build: release binary + installers
```

The bare executable is `src-tauri/target/release/novelcraft` (`.exe` on Windows); the installers
are under `src-tauri/target/release/bundle/`: `msi/` and `nsis/` on Windows, `macos/` (the `.app`)
and `dmg/` on macOS, `deb/`, `rpm/` and `appimage/` on Linux. Tauri cannot cross-compile desktop
bundles, so each platform has to be built on that platform — the [release workflow](../RELEASING.md)
does this on GitHub's runners. To build only one bundle type:
`npm run build -- --bundles appimage` (or `deb`, `nsis`, `msi`, `app`, `dmg`, …).

Builds are not code-signed; see [RELEASING.md](../RELEASING.md#known-limitations-not-bugs).

**Optional fonts.** The editor offers Lora, Merriweather, Inter and Roboto (and the Markdown mode
uses Roboto Mono). Each is taken from the system if installed, otherwise from
`src/fonts/<name>.woff2`, otherwise a generic fallback is shown. Those `.woff2` files are not in the
repository (they are git-ignored); `npm run fonts` is meant to download them before a build, but
currently saves nothing — see the note in [`scripts/fetch-fonts.mjs`](../scripts/fetch-fonts.mjs).
Release builds therefore ship without them. (The PDF fonts in `src/fonts/pdf/` are committed and
always bundled.)

**Icons.** `src-tauri/icons/` is generated from `assets/app-icon.png` by `npm run icons`, and
`assets/app-icon.png` itself is drawn by `node scripts/make-icon.mjs`. Both outputs are committed;
rerun them only when changing the icon.

## Development

```bash
npm run dev          # = tauri dev: the app with the frontend in src/ served as-is and reloaded on change
npm run serve        # the frontend alone in a browser, at http://127.0.0.1:1420
```

There is no frontend build step: `src/` is what the app loads, `index.html` plus the ES modules in
`src/js/` (one per area of the app; the map is in [CLAUDE.md](../CLAUDE.md#frontend-modules-srcjs)).
For UI work without Rust, `npm run serve` runs the frontend in a browser: the app detects that
Tauri is missing and falls back to file inputs and downloads. `src/index.html` cannot be opened
from disk: browsers refuse to load ES modules (and the `fetch()` of the PDF fonts) from `file://`
URLs. `npm run serve -- --csp` sends the desktop app's Content-Security-Policy as well, and
`PORT=…` picks another port.

### Tests

| Command | What it runs | Needs |
|---|---|---|
| `npm test` | `node:test` unit tests in `test/`, importing the pure modules in `src/js/lib/` | Node only |
| `npm run test:e2e` | `e2e/browser.e2e.mjs` and `e2e/flows.e2e.mjs`: the real `src/` in Chromium via `playwright-core`, under the desktop CSP | a Chromium (below) |
| `npm run test:desktop` | `e2e/desktop.e2e.mjs`: the built app over WebDriver | Linux, a debug build, `tauri-driver`, `WebKitWebDriver`, a display |
| `cd src-tauri && cargo test` | backend unit tests (file-access allowlist, atomic writes, backups) | Rust (+ the system packages above on Linux) |

**Chromium for `test:e2e`.** `playwright-core` never downloads a browser. The harness tries, in order:
`$CHROME_PATH`; Playwright's own Chromium (from `$PLAYWRIGHT_BROWSERS_PATH`, or the default cache
after `npx playwright-core install chromium`); an installed Google Chrome. A Playwright Chromium only
works with the `playwright-core` version it was made for, which is why that dependency is pinned to
an exact version in `package.json`. `flows.e2e.mjs` switches to a UTF-8 locale by itself if yours
isn't one (Chromium on Linux otherwise saves a download named `Роман.novel` as `download`). A test
there marked `{ todo: 'bug: …' }` documents a known bug without failing the run; drop the `todo`
when the bug is fixed.

**Desktop suite (Linux only).**

```bash
sudo apt-get install -y webkit2gtk-driver xvfb xdotool   # WebKitWebDriver, a virtual display, dialog driving
cargo install tauri-driver --locked
npx tauri build --debug --no-bundle                      # the suite runs src-tauri/target/debug/novelcraft
xvfb-run -a npm run test:desktop                          # or plain `npm run test:desktop` inside a desktop session
```

If the binary, `tauri-driver` or a `DISPLAY` is missing, the whole suite is **skipped, not failed** —
check the summary for skipped tests. The two native file-dialog tests additionally need `xdotool`.
`NOVELCRAFT_BIN` points the suite at another binary. It runs the app with temporary
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`, so your own recent files and backups are not touched.

**CI** ([`ci.yml`](../.github/workflows/ci.yml)) runs on every pull request to `main`: syntax check,
`npm test`, `npm run test:e2e` and `cargo check` first (the required *Quick check* job), then
`cargo test` plus the desktop suite, and a release build on all three platforms.

## Releasing

See [RELEASING.md](../RELEASING.md).
