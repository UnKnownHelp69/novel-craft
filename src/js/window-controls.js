/* The window has no OS frame (decorations: false in tauri.conf.json): the top bar is the
   drag handle (data-tauri-drag-region in index.html) and #winControls are the minimize /
   maximize / close buttons. "Use native title bar" brings the OS frame back and hides them. */
import { hasTauri, invoke, nativeDialogOpen } from './bridge.js';
import { $ } from './dom.js';
import { dirty, novel, setDirty } from './state.js';
import { doSave } from './save.js';
import { clearBackup } from './autosave.js';

async function destroyWindow() {
  if (hasTauri) await invoke('close_window');
}
/* Every close path (our button, the OS) ends here: close at once when nothing is unsaved,
   otherwise ask Save / Discard / Cancel. */
export function requestClose() {
  if (nativeDialogOpen) return;   // finish (or cancel) the open file dialog first
  // Clean close: the open novel matches disk. With no novel open (start menu, e.g. after
  // declining recovery) the backup is left alone so it is offered again next launch.
  if (!dirty) { if (novel) clearBackup(); destroyWindow(); return; }
  $('#closeOverlay').classList.remove('hidden');
}

export async function refreshMaxIcon() {
  const btn = $('#winMax');
  if (!btn) return;
  let max = false;
  if (hasTauri) { try { max = await invoke('is_maximized'); } catch (_) {} }
  btn.innerHTML = max ? '&#10064;' : '&#9723;';   // ❐ restore  /  ◻ maximize
  btn.title = max ? 'Restore' : 'Maximize';
}

export function init() {
  if (!hasTauri) $('#winControls').style.display = 'none'; // browser: no native controls
  $('#closeSaveBtn').addEventListener('click', async () => {
    const ok = await doSave(false);
    if (ok) { $('#closeOverlay').classList.add('hidden'); destroyWindow(); }
    // if save was cancelled/failed, leave dialog & app open
  });
  $('#closeDiscardBtn').addEventListener('click', () => {
    setDirty(false);
    clearBackup();   // otherwise the next launch offers to restore what was just discarded
    $('#closeOverlay').classList.add('hidden');
    destroyWindow();
  });
  $('#closeCancelBtn').addEventListener('click', () => {
    $('#closeOverlay').classList.add('hidden');
  });
  $('#winMin').addEventListener('click', () => invoke('minimize_window'));
  $('#winClose').addEventListener('click', () => requestClose());
  $('#winMax').addEventListener('click', async () => {
    if (!hasTauri) return;
    const max = await invoke('is_maximized');
    await invoke(max ? 'unmaximize_window' : 'maximize_window');
    refreshMaxIcon();
  });
}
