/* In-app updates, desktop only. The backend asks the release endpoint in tauri.conf.json
   (latest.json on the newest GitHub release) and verifies a download against the public key
   there; this module decides when to ask and talks to the user. At startup the check is quiet:
   an update shows as a toast with an Install button, never as a modal over another dialog, and
   being offline says nothing. A check from the menu or Settings always answers. */
import { hasTauri, invoke } from './bridge.js';
import { $ } from './dom.js';
import { dirty, novel } from './state.js';
import { doSave } from './save.js';
import { confirmModal, toast, toastAction } from './dialogs.js';
import { loadPrefs, savePrefs } from './settings.js';
import { t } from './i18n/index.js';

let checking = false;

export async function checkForUpdates({ manual = false } = {}) {
  if (!hasTauri || checking) return;
  checking = true;
  try {
    const u = await invoke('check_update');
    if (!u) { if (manual) toast(t('updates.upToDate')); return; }
    if (manual) confirmModal(t('updates.availableTitle'), t('updates.availableBody', { version: u.version, current: u.current }), installUpdate);
    else toastAction(t('updates.availableToast', { version: u.version }), t('updates.install'), installUpdate, 20000);
  } catch (e) {
    console.warn('update check failed:', e);
    if (manual) toast(t('updates.checkFailed'));
  } finally { checking = false; }
}

/* The app restarts into the new version, so unsaved work is saved first; if the save is
   cancelled or fails, nothing is installed. */
async function installUpdate() {
  if (novel && dirty && !(await doSave(false))) { toast(t('updates.saveFirst')); return; }
  toast(t('updates.installing'));
  try { await invoke('install_update'); }   // restarts the app when it succeeds
  catch (e) { console.error(e); toast(t('updates.installFailed')); }
}

/* Startup check, unless turned off in Settings (on by default). */
export function autoCheckForUpdates() {
  if (hasTauri && loadPrefs().checkUpdates !== false) checkForUpdates();
}

export function init() {
  if (!hasTauri) { $('#updateSettings').classList.add('hidden'); return; }
  const auto = $('#checkUpdatesAuto');
  auto.checked = loadPrefs().checkUpdates !== false;
  auto.addEventListener('change', () => { const p = loadPrefs(); p.checkUpdates = auto.checked; savePrefs(p); });
  $('#btnCheckUpdates').addEventListener('click', () => checkForUpdates({ manual: true }));
}
