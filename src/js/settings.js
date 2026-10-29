/* App-wide UI preferences (the Settings toggles). They live in the webview's localStorage, per
   machine — not in the .novel file, whose settings belong to the novel. */
import { hasTauri, invoke } from './bridge.js';
import { $ } from './dom.js';

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

export function init() {
  $('#nativeTitlebar').addEventListener('change', e => applyNativeTitlebar(e.target.checked));
  $('#typewriterToggle').addEventListener('change', e => applyTypewriter(e.target.checked));
}
