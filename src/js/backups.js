/* File → Restore from Backup…. Each save of a .novel keeps the previous version of the file
   (save_novel in lib.rs, at most one copy per 10 minutes, pruned to the newest 20 plus one per
   day for 30 days). This lists them for the open file and loads one into the editor as unsaved
   changes — saving keeps it, and the version on disk is backed up first so the restore itself
   can be undone. */
import { hasTauri, invoke } from './bridge.js';
import { $ } from './dom.js';
import { currentFilePath, dirty, novel } from './state.js';
import { markDirty } from './dirty.js';
import { baseName, setCurrentNovel } from './novel-file.js';
import { confirmModal, toast } from './dialogs.js';
import { fmtNoteDate } from './notes.js';

function fmtBytes(n) {
  return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}
export async function openBackups() {
  if (!hasTauri) { toast('Backups are kept by the desktop app'); return; }
  if (!novel || !currentFilePath) { toast('Save the novel to a file first — backups are kept per file'); return; }
  let list;
  try { list = await invoke('list_backups', { path: currentFilePath }); }
  catch (e) { console.error(e); toast('Could not list backups'); return; }
  const name = baseName(currentFilePath);
  $('#backupHint').textContent = list.length
    ? `Earlier versions of ${name}, newest first. Restoring replaces what is in the editor; the file as it is now is backed up first, so a restore can be undone from this list.`
    : `No backups of ${name} yet. The previous version is kept each time you save (at most one copy per 10 minutes).`;
  const host = $('#backupList');
  host.innerHTML = '';
  list.forEach(b => {
    const at = new Date(b.created * 1000);
    const row = document.createElement('div');
    row.className = 'backup-row';
    const when = document.createElement('span');
    when.className = 'br-when';
    when.textContent = at.toLocaleString();
    const meta = document.createElement('span');
    meta.className = 'br-meta';
    meta.textContent = fmtNoteDate(at.toISOString()) + ' · ' + fmtBytes(b.size);
    const btn = document.createElement('button');
    btn.className = 'tbtn accent';
    btn.textContent = 'Restore';
    btn.addEventListener('click', () => restoreBackup(b));
    row.append(when, meta, btn);
    host.appendChild(row);
  });
  $('#backupOverlay').classList.remove('hidden');
}
export function closeBackups() { $('#backupOverlay').classList.add('hidden'); }
async function restoreBackup(b) {
  const path = currentFilePath;
  const at = new Date(b.created * 1000).toLocaleString();
  closeBackups();
  const go = async () => {
    try {
      let data = JSON.parse(await invoke('read_backup', { path, name: b.name }));
      // a copy of a file from before one-novel-per-file holds a library: take its open novel
      if (data && Array.isArray(data.novels)) data = data.novels.find(n => n && n.id === data.activeNovelId) || data.novels[0];
      if (!data || typeof data !== 'object' || !Array.isArray(data.chapters)) { toast('This backup does not hold a novel'); return; }
      await invoke('backup_now', { path });   // the version on disk survives the restore
      setCurrentNovel(data, path);
      markDirty();
      toast(`Restored the version from ${at}`);
    } catch (e) {
      console.error(e);
      toast('Could not restore this backup');
    }
  };
  if (dirty) confirmModal('Unsaved changes', `Discard unsaved changes and load the version from ${at}?`, go);
  else go();
}

export function init() {
  $('#btnRestoreBackup').addEventListener('click', openBackups);
  $('#backupClose').addEventListener('click', closeBackups);
  $('#backupOverlay').addEventListener('mousedown', e => { if (e.target === $('#backupOverlay')) closeBackups(); });
  if (!hasTauri) $('#btnRestoreBackup').classList.add('hidden');
}
