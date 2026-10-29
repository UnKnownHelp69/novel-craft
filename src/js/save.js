/* Save and Save As. */
import { hasTauri, invoke, pickPath } from './bridge.js';
import { $ } from './dom.js';
import { currentFilePath, dirty, novel, setCurrentFilePath, setDirty } from './state.js';
import { markDirty, setSaved, setSaving, snapshotSaved } from './dirty.js';
import { renumber } from './tree.js';
import {
  addRecent, flushNovel, newNovelFile, openNovelFile, serializeNovel,
  updateFilePathIndicator
} from './novel-file.js';
import { toast } from './dialogs.js';
import { downloadFile } from './export.js';
import { clearBackup } from './autosave.js';

export async function doSave(saveAs = false) {
  if (!novel) { toast('No novel to save'); return false; }
  const target = novel;
  const defaultName = (novel.title || 'novel') + '.novel';
  let path = currentFilePath;
  if (hasTauri && (!path || saveAs)) {
    // Ask for the destination before taking the snapshot: until a path is chosen nothing
    // is saved, so the novel stays dirty (close prompt and backups keep protecting it).
    path = await pickPath('pick_save', { defaultName });
    if (!path) return false;
    if (novel !== target) { toast('Save cancelled — another novel was opened'); return false; }
  }
  flushNovel();
  renumber();
  const content = serializeNovel(novel);
  const wasDirty = dirty;
  setSaving();
  // Clean as of `content`, before the write is awaited: an edit typed while it is in flight
  // sets dirty again and must survive the success path below.
  snapshotSaved();
  setDirty(false);
  try {
    if (hasTauri) {
      await invoke('save_novel', { path, content });
      setCurrentFilePath(path);
      await invoke('set_last_file', { path });
      await addRecent(path);
    } else {
      downloadFile(defaultName, content);   // browser fallback: Save is a download
    }
    if (!dirty) setSaved();
    else $('#saveIndicator').classList.remove('saving');
    clearBackup();
    updateFilePathIndicator();
    toast(saveAs ? 'Saved a copy' : 'Project saved');
    return true;
  } catch (e) {
    console.error(e);
    if (wasDirty || dirty) markDirty();
    else setSaved();
    // The remembered path is not one this session may write (the backend only writes files
    // the user picked or opened): ask where to save instead of failing on every Ctrl+S.
    if (hasTauri && !saveAs && /access denied/.test(String(e))) {
      toast('Choose where to save this novel');
      return doSave(true);
    }
    toast('Save failed');
    return false;
  }
}
export const doOpen = openNovelFile;      // "Open" == open a .novel file
export const newProject = newNovelFile;   // "New"  == new .novel file
