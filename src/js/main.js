/* Entry point: index.html loads this file as a module. Importing the other modules only
   declares things (and looks up elements); each module wires its event listeners in its
   init(), and those run below in a fixed order. Several modules listen on the same target
   (document clicks, mousedowns, mousemoves, keydowns), and listeners on one target run in the
   order they were added, so keep the order of the calls. */
import { hasTauri, invoke, init as initBridge } from './bridge.js';
import { setSaved } from './dirty.js';
import { init as initTree } from './tree.js';
import { loadFromPath, refreshUI, renderRecentMenu, init as initNovelFile } from './novel-file.js';
import { init as initEditor } from './editor.js';
import { init as initEntities } from './entities.js';
import { init as initPanels } from './panels.js';
import { init as initContextMenu } from './context-menu.js';
import { init as initDialogs } from './dialogs.js';
import { init as initExport } from './export.js';
import { checkRecovery, init as initAutosave } from './autosave.js';
import { applyNoteDisplay, ensureHighlightStyles, init as initNotes } from './notes.js';
import { init as initCorkboard } from './corkboard.js';
import { init as initGraph } from './graph.js';
import { init as initMap } from './map.js';
import { init as initCompile } from './compile.js';
import { init as initBackups } from './backups.js';
import { init as initShortcuts } from './shortcuts.js';
import { init as initMenu } from './menu.js';
import { refreshMaxIcon, init as initWindowControls } from './window-controls.js';
import {
  applyNativeTitlebar, applyTypewriter, loadPrefs, init as initSettings
} from './settings.js';

/* Runs once, after every init(), so all handlers are wired before a novel loads. An
   unsaved-work recovery is offered before the last file is reopened: a leftover recovery
   copy holds work that never reached disk, and whichever way the user answers, the last
   file is not opened on top of it. */
async function startup() {
  refreshUI();               // no novel yet -> shows the empty state
  setSaved();

  const prefs = loadPrefs();
  applyNativeTitlebar(!!prefs.nativeTitlebar);
  applyTypewriter(!!prefs.typewriter);
  applyNoteDisplay();
  ensureHighlightStyles();
  refreshMaxIcon();
  await renderRecentMenu();

  const recovery = await checkRecovery();   // 'restored' | 'declined' | null
  if (recovery === 'restored') return;      // recovered novel is already loaded
  if (recovery === 'declined') return;      // leave the start menu; user opens what they want

  // No recovery backup -> normal launch: auto-open the last file if there is one,
  // otherwise the start menu (empty state) stays shown for the user to choose.
  if (hasTauri) {
    try {
      const path = await invoke('get_last_file');
      if (path) await loadFromPath(path);
    } catch (_) {}
  }
}

initBridge();
initTree();
initNovelFile();
initEditor();
initEntities();
initPanels();
initContextMenu();
initDialogs();
initExport();
initAutosave();
initNotes();
initCorkboard();
initGraph();
initMap();
initCompile();
initBackups();
initShortcuts();
initMenu();
initWindowControls();
initSettings();
startup();
