/* Manual and periodic saves share a queue so a slow write cannot overtake a newer one. */
import { hasTauri, invoke, pickPath } from './bridge.js';
import { currentFilePath, dirty, novel, setCurrentFilePath } from './state.js';
import { markDirty, refreshSaveIndicator, setSaved, setSaving, snapshotSaved } from './dirty.js';
import { renumber } from './tree.js';
import {
  addRecent, flushNovel, newNovelFile, openNovelFile, serializeNovel, updateFilePathIndicator
} from './novel-file.js';
import { toast } from './dialogs.js';
import { downloadFile } from './export.js';
import { clearBackup, localBackup } from './autosave.js';
import { t } from './i18n/index.js';

let queue = Promise.resolve();
export function doSave(saveAs = false, automatic = false) {
  const target = novel;
  if (!target) { if (!automatic) toast(t('save.noNovel')); return Promise.resolve(false); }
  const next = queue.then(() => writeNovel(target, saveAs, automatic));
  queue = next.catch(() => {});
  return next;
}
async function writeNovel(target, saveAs, automatic) {
  if (target !== novel || (automatic && (!dirty || !currentFilePath))) return false;
  const defaultName = (target.title || 'novel') + '.novel';
  let path = currentFilePath;
  if (hasTauri && (!path || saveAs)) {
    path = await pickPath('pick_save', { defaultName });
    if (!path) return false;
    if (novel !== target) { toast(t('save.cancelledOtherNovel')); return false; }
  }
  flushNovel();
  renumber();
  const content = serializeNovel(target);
  setSaving();
  try {
    if (hasTauri) {
      await invoke('save_novel', { path, content });
      if (novel !== target) return false;
      setCurrentFilePath(path);
      if (!automatic) {
        await invoke('set_last_file', { path });
        if (novel !== target) return false;
        await addRecent(path);
      }
    } else downloadFile(defaultName, content);
    if (novel !== target) return false;
    flushNovel();
    if (serializeNovel(target) === content) {
      snapshotSaved();
      setSaved();
      clearBackup();
    } else {
      markDirty();
      localBackup();
    }
    updateFilePathIndicator();
    if (!automatic) toast(saveAs ? t('save.savedCopy') : t('save.saved'));
    return !dirty;
  } catch (e) {
    console.error(e);
    if (novel !== target) return false;
    refreshSaveIndicator(true);
    if (automatic) { localBackup(); return false; }
    if (hasTauri && !saveAs && /access denied/.test(String(e))) {
      toast(t('save.chooseWhere'));
      return writeNovel(target, true, false);
    }
    toast(t('save.failed'));
    return false;
  }
}
export const doOpen = openNovelFile;
export const newProject = newNovelFile;
