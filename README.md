# NovelCraft

A distraction‑free desktop **novel‑writing studio** built with **Tauri v2** (Rust backend) and **vanilla HTML/CSS/JS** (no frameworks). Compiles to a single native binary for Windows, macOS and Linux.

[![CI](https://github.com/UnKnownHelp69/novel-craft/actions/workflows/ci.yml/badge.svg)](https://github.com/UnKnownHelp69/novel-craft/actions/workflows/ci.yml)
![theme](https://img.shields.io/badge/theme-dark%20amber-c9a96e)
![built with AI](https://img.shields.io/badge/built%20with-AI%20agent-8a7549)

> 🤖 **Built with an AI agent.** This project was developed collaboratively with an AI coding agent (Claude Code / Claude Opus). See [CLAUDE.md](CLAUDE.md) for the architecture notes used during development.

## Features

- **Warm dark theme** (`#1a1a1f` / panels `#22222b` / cream text `#e8e0d5` / amber accent `#c9a96e`), thin themed scrollbars.
- **Hybrid editor** — WYSIWYG *Visual Mode* (`contenteditable` + `execCommand`) with a toggleable raw **Markdown Mode**. Bold / Italic / H1–H3 / per‑selection font, live active‑state highlighting on the toolbar.
- **Global font controls** — size slider (14–24 px) and default document font (Georgia, Lora, Merriweather, Inter, Roboto, Arial).
- **Scenes & chapter tree** (left) — chapters are collapsible folders containing **scenes** (the writing unit the editor edits). 🎬 scenes show live word counts and a status dot (draft / review / done). Add, rename, duplicate, delete, **drag‑and‑drop** to reorder within a chapter, move between chapters, or reorder chapters; right‑click for a context menu (incl. *Move to Chapter*). Breadcrumb navigation (Novel › Chapter › Scene) and a per‑scene metadata bar (POV character, location, time of day, status).
- **Corkboard view** — toggle the tree into a Scrivener‑style board of draggable scene cards grouped by chapter, with status badges, POV/location/time, zoom, status/POV filters, and sorting. Drag cards to reorder or move between chapters; click to open a scene; click a badge to cycle its status.
- **Character relationship graph** (`Ctrl+G`) — an interactive HTML‑canvas network of characters (nodes) and relationships (edges). Drag nodes, pan/zoom, colour‑coded edge types with thickness by strength and style by status (active/past/secret/one‑sided), click a node to spotlight its connections, edit relationships in a side panel, auto‑arrange (force‑directed) / circular / manual layouts, filters, a legend, and **Export as PNG**. Positions persist in the `.novel` file.
- **Interactive world map** — upload a background map image (PNG/JPG/WebP/SVG, stored inline in the `.novel`) and drop **location pins** (drag to move, colour‑coded by type, click for a details card, double‑click to edit). Draw **travel routes** between locations with names, travel time, distance, terrain, characters and colour. Toggleable **layers** (background / locations / routes / labels) plus custom **drawing layers** (pen / line / rectangle / circle / text / eraser, opacity). Pan/zoom, Fit to Screen, and **Export as PNG**.
- **Compile Novel** — assemble all scenes into one document: drag to reorder, add **part dividers** and **section breaks**, rename items for the compilation only, live **preview**, and formatting/title‑page/**table‑of‑contents** settings with saveable presets. Export to **PDF** (print), **EPUB**, **HTML**, **TXT** and **DOCX**.
- **Worldbuilding panels** (right accordion) — Characters, Locations, Races/Peoples with full editable field sets, plus a **Counters** section (chapter/total words, chars with & without spaces, configurable word‑goal progress bar).
- **Margin notes** — attach colour‑coded comments to any text selection (right‑click ▸ *Add Note* or `Ctrl+Shift+M`). Notes appear as dots in the editor's right margin with hover tooltips and an expandable card (resolve / edit / delete), underline the annotated text via the CSS Custom Highlight API, and are tracked by character offset so they survive edits. A **Notes** panel filters by type and resolved state; five default types (Исправить / Проверить факт / Развить мысль / Перенести / Идея) plus user‑defined **custom types** (name, colour, emoji) managed in **Settings**. Export all notes to TXT / Markdown.
- **Focus Mode** (`Ctrl+Shift+F`) — hides chrome, centers a 720 px column, hover‑top / `Esc` to exit.
- **`.novel` JSON project format**, native open/save dialogs, TXT / HTML / Markdown export.
- **Auto‑save & crash recovery** — `localStorage` backup every 10 s, backend working‑file auto‑save every 30 s, "Saving…/Saved" indicator, unsaved‑changes prompt on close, last‑file auto‑load on launch.
- **Native menu bar** (File / Edit / View / Help) and window state (min size 1200×750, remembered position/size).
- **Full Cyrillic / Unicode support**, optional offline‑bundled Google Fonts.

## Project structure

```
redactor-for-novels/
├─ package.json                 # npm scripts (dev/build/icons/fonts) + Tauri CLI
├─ assets/
│  └─ app-icon.png              # source icon (regen: node scripts/make-icon.mjs)
├─ scripts/
│  ├─ make-icon.mjs             # generates the source PNG (no deps)
│  └─ fetch-fonts.mjs           # downloads woff2 fonts for offline use
├─ src/                         # ← frontend (frontendDist)
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js                    # all app logic
│  └─ fonts/
│     └─ fonts.css              # @font-face (local, with system fallbacks)
└─ src-tauri/                   # ← Rust backend
   ├─ Cargo.toml
   ├─ build.rs
   ├─ tauri.conf.json
   ├─ capabilities/default.json
   ├─ icons/                    # generated by `npm run icons`
   └─ src/
      ├─ main.rs
      └─ lib.rs                 # commands, native menu, file I/O, autosave
```

## Prerequisites

- **Rust** (stable) + Cargo — https://rustup.rs
- **Node.js 18+** (only for the Tauri CLI and the optional font/icon scripts)
- Platform Webview / build deps per the Tauri guide:
  - **Windows:** WebView2 runtime (preinstalled on Win 11) + MSVC build tools
  - **macOS:** Xcode command‑line tools
  - **Linux:** `webkit2gtk`, `libgtk-3-dev`, `librsvg2-dev`, `patchelf`, `build-essential` (see Tauri docs)

## Setup

```bash
npm install                 # installs @tauri-apps/cli
npm run icons               # (already run) regenerate icons from assets/app-icon.png
npm run fonts               # OPTIONAL: download woff2 fonts for full offline use
```

Fonts are optional — if the `.woff2` files are absent the app falls back to locally installed / system fonts, so it still works entirely offline.

## Run in development

```bash
npm run dev        # = tauri dev  (hot-reloads the static frontend)
```

## Build a native binary (single command)

```bash
npm run build      # = tauri build
```

Outputs land in `src-tauri/target/release/`:

| Platform | Executable | Installers (`.../bundle/`) |
|----------|------------|-----------------------------|
| Windows  | `novelcraft.exe` | `msi/`, `nsis/` (`.msi`, `-setup.exe`) |
| macOS    | `NovelCraft.app` | `dmg/` (`.dmg`) |
| Linux    | `novelcraft` (rename to `.bin` if desired) | `deb/`, `appimage/`, `rpm/` |

### Cross‑platform note
Tauri builds **natively per host OS** (it does not cross‑compile GUI binaries out of the box). To produce all three, run `npm run build` on each of Windows, macOS and Linux (e.g. via CI matrix). Target a single current platform with:

```bash
npm run build -- --bundles app        # macOS .app only
npm run build -- --bundles nsis       # Windows installer only
npm run build -- --bundles appimage   # Linux AppImage only
```

## `.novel` file format

Plain JSON. **One `.novel` file = one novel:**

```jsonc
{
  "version": "1.0",
  "title": "My Novel",
  "settings": {
    "fontSize": 18, "defaultFont": "Georgia, serif", "wordGoal": 80000, "customNoteTypes": [],
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
  "characters": [ /* …, relationshipNotes, notes, relationships:[{targetCharacterId,type,subtype,strength,status,…}], graphPosition:{x,y} */ ],
  "locations":  [ /* name, type, description, history, atmosphere, notes */ ],
  "races":      [ /* name, description, appearance, culture, history, traits */ ]
}
```

Each **scene** stores both `content` (HTML) and `markdownContent`. The current file path is shown next to the novel title in the top bar (or "• Unsaved" for a new novel). The last 5 opened files are kept in **Recent** (top bar) and the native **File ▸ Open Recent** menu.

**Backward compatible:** older files are migrated on open — a multi-novel *library* file (top-level `novels` array) offers to split into one‑novel files, and a pre‑scenes chapter (with its own `content`) is wrapped into a single default "Scene 1". Characters' former free‑text `relationships` field is preserved as `relationshipNotes`.

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| Save | `Ctrl/Cmd+S` |
| Save As | `Ctrl/Cmd+Shift+S` |
| Open | `Ctrl/Cmd+O` |
| Bold / Italic | `Ctrl/Cmd+B` / `Ctrl/Cmd+I` |
| Focus Mode | `Ctrl/Cmd+Shift+F` (`Esc` to exit) |
| Add margin note | `Ctrl/Cmd+Shift+M` |
| Character graph | `Ctrl/Cmd+G` |
| Toggle chapters / tools | `Ctrl/Cmd+\` / `Ctrl/Cmd+/` |
| Undo / Redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |

## License

Released under the [MIT License](LICENSE). © 2026 UnKnownHelp69.
