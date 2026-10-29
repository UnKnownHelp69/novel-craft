/* Autosave and the crash-recovery copy. */
import { hasTauri, invoke } from './bridge.js';
import { $ } from './dom.js';
import { currentFilePath, dirty, novel, setDirty } from './state.js';
import { markDirty, setSaved, snapshotSaved } from './dirty.js';
import { renumber } from './tree.js';
import {
  flushNovel, serializeNovel, setCurrentNovel, updateFilePathIndicator
} from './novel-file.js';
import { confirmModal, toast } from './dialogs.js';

const LS_KEY = 'novelcraft:autosave';
let backupFailed = false;   // show the quota toast once, not every 10s, until a backup succeeds again
/* Crash-recovery copy of the unsaved state, separate from the .novel file and its backups:
   working.novel in the app config dir (desktop) or localStorage (browser, ~5 MB quota).
   It records the file path too, so checkRecovery() can reattach the novel to its file. */
export function localBackup() {
  flushNovel();
  const payload = JSON.stringify({ ts: Date.now(), path: currentFilePath, novel });
  if (hasTauri) {
    invoke('autosave', { content: payload }).catch(e => console.error(e));
  } else {
    try {
      localStorage.setItem(LS_KEY, payload);
      backupFailed = false;
    } catch (_) {
      if (!backupFailed) {
        toast('Novel too large for auto-backup. Save manually!');
        backupFailed = true;
      }
    }
  }
}
/* Drop the recovery backup once the in-memory novel matches disk (or was knowingly
   discarded). A leftover backup is older than the file, and restoring it would let the
   next autosave overwrite newer saved work with it. */
export function clearBackup() {
  if (hasTauri) {
    invoke('clear_autosave').catch(e => console.error(e));
  } else {
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
  }
}

// Resolves to 'restored' (user restored), 'declined' (user pressed Cancel),
// or null (no backup to offer).
export async function checkRecovery() {
  let data, payload;
  try {
    let raw = null;
    if (hasTauri) {
      try { raw = await invoke('read_autosave'); } catch (_) {}
    } else {
      raw = localStorage.getItem(LS_KEY);
    }
    if (!raw) return null;
    data = JSON.parse(raw);
    // { novel } from localBackup(); older versions wrote { library: { novels, activeNovelId } }
    payload = data && data.novel;
    if (!payload && data && data.library) {
      const lib = data.library;
      payload = (lib.novels || []).find(n => n.id === lib.activeNovelId) || (lib.novels || [])[0];
    }
    if (!payload) return null;
  } catch (_) { return null; }

  return new Promise(res => {
    const cancel = $('#modalCancel');
    let settled = false;
    const done = v => { if (settled) return; settled = true; cancel.removeEventListener('click', onCancel); res(v); };
    const onCancel = () => done('declined');   // keep the backup untouched; just go to the start menu
    confirmModal('Recover unsaved work',
      'Unsaved changes from a previous session were found. Restore them?',
      async () => {
        // The backup remembers where the novel lived, but this session may only write there
        // if the user opened or saved that file before (the backend's allowlist). If it can't
        // be read back, restore the novel as unsaved so Save asks where to put it.
        let path = data.path || null;
        if (path && hasTauri) {
          try { await invoke('read_text', { path }); } catch (_) { path = null; }
        }
        try {
          setCurrentNovel(payload, path); markDirty();
          toast(path || !data.path ? 'Recovered' : 'Recovered as unsaved — use Save to choose where to keep it');
          done('restored');
        } catch (e) {
          console.error('Recovery restore failed:', e);
          toast('Could not restore backup — the saved data appears corrupted');
          done('declined');   // leave the start menu; the backup is kept for inspection
        }
      });
    cancel.addEventListener('click', onCancel);   // confirmModal() runs nothing on Cancel
  });
}

export function init() {
  setInterval(() => { if (dirty && novel) localBackup(); }, 10000); // every 10s while dirty
  /* Every 30s while dirty: save to the novel's own file when it has one (desktop only;
     save_novel keeps at most one backup copy per 10 minutes, so this cadence does not flood
     the backups), otherwise refresh the recovery copy. Same snapshot-before-await rule as doSave(). */
  setInterval(async () => {
    if (!dirty || !novel) return;
    if (hasTauri && currentFilePath) {
      try {
        flushNovel();
        renumber();
        const content = serializeNovel(novel);
        snapshotSaved();
        setDirty(false);
        await invoke('save_novel', { path: currentFilePath, content });
        if (!dirty) setSaved();
        else $('#saveIndicator').classList.remove('saving');
        clearBackup();
        updateFilePathIndicator();
      } catch (_) { localBackup(); markDirty(); }   // still unsaved: keep the recovery copy current
    } else {
      localBackup();   // no file yet, or the browser build: recovery copy only
    }
  }, 30000);
}
