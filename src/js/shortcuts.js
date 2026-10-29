/* Global keyboard shortcuts. */
import { $ } from './dom.js';
import { updateToolbarState } from './editor.js';
import { focusMode, setFocus } from './panels.js';
import { doOpen, doSave } from './save.js';
import {
  closeAddNote, closeNoteCard, filteredNotes, notePopup, openAddNote, openNoteCard,
  openNoteId
} from './notes.js';
import { closeCorkboard, corkboardOpen } from './corkboard.js';
import { closeGraph, graphOpen, openGraph } from './graph.js';
import {
  cancelRouteMode, closeMap, closeRouteEditor, mapDraw, mapOpen, mRouteMode, updateMapHint
} from './map.js';
import { closeCompile, compOpen } from './compile.js';
import { closeBackups } from './backups.js';
import { shortcutKey } from './lib/keys.js';

function navigateNotes(dir) {
  const notes = filteredNotes();
  if (!notes.length) return;
  let idx = notes.findIndex(n => n.id === openNoteId);
  idx = idx === -1 ? (dir > 0 ? 0 : notes.length - 1) : (idx + dir + notes.length) % notes.length;
  openNoteCard(notes[idx].id);
}

export function init() {
  /* One handler for every global shortcut; the first matching line wins, so order matters.
     Escape closes the topmost layer first (backup dialog, graph side panel, graph, corkboard,
     map route editor / route mode, map, compile, note card, add-note popup, focus mode), and
     Ctrl+Shift+S is tested before Ctrl+S, which does not exclude Shift. Letters are compared
     via shortcutKey(), so shortcuts work on non-Latin layouts; arrow keys and Escape via e.key.
     While a native file dialog is pending, the capture listener next to pickPath() swallows
     every key before it gets here. */
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    const key = shortcutKey(e);
    if (e.key === 'Escape' && !$('#backupOverlay').classList.contains('hidden')) { closeBackups(); return; }
    if (mod && !e.shiftKey && key === 'g') { e.preventDefault(); if (graphOpen) closeGraph(); else openGraph(); return; }
    if (e.key === 'Escape' && graphOpen) { if (!$('#graphPanel').classList.contains('hidden')) { $('#graphPanel').classList.add('hidden'); } else closeGraph(); return; }
    if (e.key === 'Escape' && corkboardOpen) { closeCorkboard(); return; }
    if (e.key === 'Escape' && mapOpen) {
      if (!$('#routeOverlay').classList.contains('hidden')) { closeRouteEditor(); return; }
      if (mRouteMode) { cancelRouteMode(); mapDraw(); updateMapHint(); return; }
      closeMap(); return;
    }
    if (e.key === 'Escape' && compOpen && !$('#routeOverlay').classList.contains('hidden')) { return; }
    if (e.key === 'Escape' && compOpen) { closeCompile(); return; }
    if (mod && e.shiftKey && key === 'm') { e.preventDefault(); openAddNote(); return; }
    if (e.key === 'Escape' && openNoteId) { closeNoteCard(); return; }
    if (e.key === 'Escape' && notePopup && !notePopup.classList.contains('hidden')) { closeAddNote(); return; }
    if (mod && openNoteId && e.key === 'ArrowDown') { e.preventDefault(); navigateNotes(1); return; }
    if (mod && openNoteId && e.key === 'ArrowUp') { e.preventDefault(); navigateNotes(-1); return; }
    if (mod && e.shiftKey && key === 'f') { e.preventDefault(); setFocus(!focusMode); return; }
    if (mod && e.shiftKey && key === 's') { e.preventDefault(); doSave(true); return; }
    if (mod && key === 's') { e.preventDefault(); doSave(false); return; }
    if (mod && !e.shiftKey && key === 'o') { e.preventDefault(); doOpen(); return; }
    if (mod && key === '\\') { e.preventDefault(); $('#toggleLeft').click(); return; }
    if (mod && key === '/') { e.preventDefault(); $('#toggleRight').click(); return; }
    if (e.key === 'Escape' && focusMode) { setFocus(false); return; }
    if (mod && (key === 'b' || key === 'i')) { updateToolbarState(); } // no preventDefault: contenteditable applies bold/italic itself
  });
}
