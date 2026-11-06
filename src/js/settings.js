/* App-wide UI preferences (the Settings toggles). They live in the webview's localStorage, per
   machine — not in the .novel file, whose settings belong to the novel. */
import { hasTauri, invoke } from './bridge.js';
import { $ } from './dom.js';
import { LOCALES, locale, setLocale, resolveLocale, applyI18n, t } from './i18n/index.js';
import { novel } from './state.js';
import { refreshSaveIndicator } from './dirty.js';
import { renderTree, updateBreadcrumb, updateSceneMeta } from './tree.js';
import { renderEntities } from './entities.js';
import { updateCounters } from './panels.js';
import { renderRecentMenu, updateFilePathIndicator, updateWindowTitle } from './novel-file.js';
import { renderNoteCard, renderNotes, renderNoteTypeSettings } from './notes.js';

const PREF_KEY = 'novelcraft:prefs';
export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
export function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (_) {} }

/* The stored preference is the source of truth: startup re-applies it on every launch,
   whatever frame the window opened with. body.native-titlebar hides the custom controls. */
export async function applyNativeTitlebar(on) {
  document.body.classList.toggle('native-titlebar', on);
  if (hasTauri) { try { await invoke('set_decorations', { on }); } catch (_) {} }
  const p = loadPrefs(); p.nativeTitlebar = on; savePrefs(p);
  $('#nativeTitlebar').checked = on;
}

export function applyTypewriter(on) {
  document.body.classList.toggle('typewriter', on);
  const p = loadPrefs(); p.typewriter = on; savePrefs(p);
  $('#typewriterToggle').checked = on;
}

/* The native menu's labels in the interface language; the keys are build_menu's in lib.rs. */
function nativeMenuLabels() {
  return {
    file: t('nativeMenu.file'), edit: t('nativeMenu.edit'), view: t('nativeMenu.view'), help: t('nativeMenu.help'),
    new: t('nativeMenu.new'), open: t('nativeMenu.open'), open_recent: t('nativeMenu.openRecent'),
    recent_none: t('nativeMenu.recentNone'), save: t('nativeMenu.save'), save_as: t('nativeMenu.saveAs'),
    restore_backup: t('nativeMenu.restoreBackup'), compile: t('nativeMenu.compile'),
    export_txt: t('nativeMenu.exportTxt'), export_html: t('nativeMenu.exportHtml'), export_md: t('nativeMenu.exportMd'),
    quit: t('nativeMenu.quit'), undo: t('nativeMenu.undo'), redo: t('nativeMenu.redo'), cut: t('nativeMenu.cut'),
    copy: t('nativeMenu.copy'), paste: t('nativeMenu.paste'), select_all: t('nativeMenu.selectAll'),
    toggle_focus: t('nativeMenu.toggleFocus'), toggle_panels: t('nativeMenu.togglePanels'), about: t('nativeMenu.about')
  };
}

/* Interface language: 'auto' (the system language when there is a dictionary for it) or a
   LOCALES code. Switching re-renders in place, so the open scene, selection and unsaved work
   stay as they are; the overlays (graph, map, corkboard, compile) render on open. */
export function applyUiLanguage(pref, { rerender = true } = {}) {
  setLocale(resolveLocale(pref, navigator.languages || [navigator.language]));
  document.documentElement.lang = locale;
  const p = loadPrefs(); p.uiLanguage = pref; savePrefs(p);
  const sel = $('#uiLanguage');
  sel.replaceChildren(new Option(t('settings.languageAuto'), 'auto'),
    ...Object.entries(LOCALES).map(([code, l]) => new Option(l.name, code)));
  sel.value = LOCALES[pref] ? pref : 'auto';
  applyI18n(document);
  if (hasTauri) invoke('set_menu_labels', { labels: nativeMenuLabels() }).catch(() => {});
  if (!rerender) return;
  refreshSaveIndicator();
  updateFilePathIndicator();
  updateWindowTitle();
  renderRecentMenu();
  renderTree();
  if (novel) { updateBreadcrumb(); updateSceneMeta(); }
  ['characters', 'locations', 'races'].forEach(renderEntities);
  updateCounters();
  renderNoteTypeSettings();
  renderNotes();
  renderNoteCard();
}

export function init() {
  $('#uiLanguage').addEventListener('change', e => applyUiLanguage(e.target.value));
  $('#nativeTitlebar').addEventListener('change', e => applyNativeTitlebar(e.target.checked));
  $('#typewriterToggle').addEventListener('change', e => applyTypewriter(e.target.checked));
}
