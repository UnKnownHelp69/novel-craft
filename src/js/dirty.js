/* Dirty tracking and the save indicator; the rules are under "Dirty-flag discipline" in
   CLAUDE.md. */
import { $ } from './dom.js';
import { isLoadingContent, novel, setDirty } from './state.js';

export let savedContent = {};         // sceneId -> normalizeHTML() snapshot at last save/load
export let savedMd = {};              // sceneId -> markdown snapshot at last save/load

export function markDirty() {
  if (isLoadingContent) return;   // ignore mutations caused by programmatic loads
  setDirty(true);
  const ind = $('#saveIndicator');
  ind.textContent = 'Unsaved';
  ind.classList.remove('saving');
}
export function setSaved() {
  setDirty(false);
  const ind = $('#saveIndicator');
  ind.textContent = 'Saved';
  ind.classList.remove('saving');
}

/* Canonical form of scene HTML for the "is this a real edit?" comparison against savedContent.
   contenteditable re-serializes markup it did not change (attribute order, whitespace between
   tags, <br> spelling, a trailing empty <p> left after deleting everything), and none of that
   may count as an edit. Only for comparing: scene content itself is never normalized. */
export function normalizeHTML(html) {
  try {
    const doc = new DOMParser().parseFromString('<div id="__r">' + (html || '') + '</div>', 'text/html');
    const root = doc.getElementById('__r');
    root.querySelectorAll('*').forEach(el => {                 // re-add attributes in sorted order
      const names = [...el.attributes].map(a => a.name).sort();
      const vals = {};
      names.forEach(n => (vals[n] = el.getAttribute(n)));
      names.forEach(n => el.removeAttribute(n));
      names.forEach(n => el.setAttribute(n, vals[n]));
    });
    let s = root.innerHTML;
    s = s.replace(/>\s+</g, '><');
    s = s.replace(/<br\s*\/?>/gi, '<br/>');
    s = s.replace(/(?:<p>(?:\s|<br\/>)*<\/p>)+$/i, '');
    return s.trim();
  } catch { return (html || '').trim(); }
}
/* The baseline later edits are compared against, per scene; retaken on every save (manual or
   auto) and every load. */
export function snapshotSaved() {
  savedContent = {};
  savedMd = {};
  if (!novel) return;
  novel.chapters.forEach(c => (c.scenes || []).forEach(s => {
    savedContent[s.id] = normalizeHTML(s.content);
    savedMd[s.id] = s.markdownContent || '';
  }));
}
export function setSaving() {
  const ind = $('#saveIndicator');
  ind.textContent = 'Saving…';
  ind.classList.add('saving');
}
