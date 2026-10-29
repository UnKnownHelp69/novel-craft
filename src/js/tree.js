/* The scene/chapter tree in the left panel. A chapter is a container of scenes. A scene is
   the writing unit that the editor edits; it carries content, per-scene metadata, and margin
   notes. */
import { $, $$, chapterList, editor, mdEditor } from './dom.js';
import { countWords, esc, escAttr, uuid } from './lib/text.js';
import { stripHtml } from './lib/html.js';
import { blankChapter, blankScene } from './lib/model.js';
import {
  currentChapterId, currentSceneId, dirty, isLoadingContent, novel, setCurrentChapterId,
  setCurrentSceneId, setLoadingContent
} from './state.js';
import { markDirty } from './dirty.js';
import { nvTitle } from './novel-file.js';
import { mdMode } from './editor.js';
import { htmlToMd, mdToHtml } from './lib/markdown.js';
import { updateCounters } from './panels.js';
import { promptModal, toast, toastAction } from './dialogs.js';
import { localBackup } from './autosave.js';
import {
  closeAddNote, reconcileNotes, renderNoteCard, renderNotes, setOpenNoteId
} from './notes.js';
import { corkboardOpen, renderCorkboard } from './corkboard.js';

// [id stored in the file, label, icon]; ids the file may hold that are not listed fall back
// to the last entry ('unknown') in timeMeta().
export const TIME_OF_DAY = [
  ['morning', 'Morning', '🌅'], ['afternoon', 'Afternoon', '🌞'], ['evening', 'Evening', '🌆'],
  ['night', 'Night', '🌙'], ['dawn', 'Dawn', '🌄'], ['dusk', 'Dusk', '🌇'], ['unknown', 'Unknown', '❓']
];
// [id, label, colour]; unknown ids fall back to 'draft' in statusMeta().
export const SCENE_STATUS = [
  ['draft', 'Draft', '#8f887c'], ['review', 'Review', '#e6b422'], ['done', 'Done', '#5cb85c']
];
export function timeMeta(id) { return TIME_OF_DAY.find(t => t[0] === id) || TIME_OF_DAY[6]; }
export function statusMeta(id) { return SCENE_STATUS.find(s => s[0] === id) || SCENE_STATUS[0]; }

/* currentChapter/currentScene derive from currentSceneId so a stale
   currentChapterId (after a drag/move) can never disagree with the loaded scene. */
export function currentChapter() {
  if (!novel) return null;
  if (currentSceneId) { const f = findScene(currentSceneId); if (f) return f.chapter; }
  return novel.chapters.find(c => c.id === currentChapterId) || novel.chapters[0];
}
export function currentScene() {
  if (!novel) return null;
  if (currentSceneId) { const f = findScene(currentSceneId); if (f) return f.scene; }
  const c = novel.chapters.find(c => c.id === currentChapterId) || novel.chapters[0];
  return c ? (c.scenes[0] || null) : null;
}
export function findScene(id) {
  if (!novel) return null;
  for (const c of novel.chapters) {
    const s = (c.scenes || []).find(x => x.id === id);
    if (s) return { chapter: c, scene: s };
  }
  return null;
}
export function findChapter(id) { return novel ? novel.chapters.find(c => c.id === id) : null; }
export function chapterWordCount(c) { return (c.scenes || []).reduce((s, x) => s + (x.wordCount || 0), 0); }
export function renumber() {
  if (!novel) return;
  novel.chapters.forEach((c, i) => { c.order = i; (c.scenes || []).forEach((s, j) => (s.order = j)); });
}

/* Rebuilds the whole sidebar tree. That detaches every row element, so it must not run while a
   pointer gesture still needs its row (between the two presses of a double-click on a chapter:
   see setChapterCollapsed). Also rewrites every `order` to match the array positions. */
export function renderTree() {
  chapterList.innerHTML = '';
  if (!novel) return;
  renumber();
  novel.chapters.forEach((c, ci) => {
    c.wordCount = chapterWordCount(c);
    const chLi = document.createElement('li');
    chLi.className = 'tree-chapter' + (c.collapsed ? ' collapsed' : '') + (c.id === currentChapterId ? ' active' : '');
    chLi.dataset.chapterId = c.id;
    chLi.innerHTML =
      `<div class="tc-row" data-chapter-id="${escAttr(String(c.id))}">
         <button class="tc-caret" title="Expand / collapse">▾</button>
         <span class="tc-folder">📁</span>
         <span class="tc-num">${ci + 1}.</span>
         <span class="tc-title">${esc(c.title)}</span>
         <span class="tc-words">${c.wordCount}</span>
         <button class="tc-add" title="Add scene to this chapter">＋</button>
       </div>
       <ul class="tc-scenes"></ul>`;
    const sceneUl = chLi.querySelector('.tc-scenes');
    (c.scenes || []).forEach(s => {
      const st = statusMeta(s.status);   // constants, never file data, so safe unescaped below
      const li = document.createElement('li');
      li.className = 'tree-scene' + (s.id === currentSceneId ? ' active' : '');
      li.dataset.sceneId = s.id;
      li.dataset.chapterId = c.id;
      li.innerHTML =
        `<span class="ts-icon">🎬</span>
         <span class="ts-title">${esc(s.title)}</span>
         <span class="ts-words">${s.wordCount || 0}</span>
         <span class="ts-status" style="--sc:${st[2]}" title="${st[1]}"></span>`;
      sceneUl.appendChild(li);
    });
    chapterList.appendChild(chLi);
  });
}

/* ---- selection / editor sync ---- */
export function selectScene(sceneId, saveFirst = true) {
  if (saveFirst) saveCurrentScene();
  const f = findScene(sceneId);
  if (!f) return;
  setCurrentChapterId(f.chapter.id);
  setCurrentSceneId(sceneId);
  setOpenNoteId(null);
  closeAddNote();
  loadSceneIntoEditor();
  renderTree();
  updateCounters();
  renderNotes();
  renderNoteCard();
  if (dirty) localBackup();   // a clean novel matches disk; backing it up would plant a stale recovery offer
}
function selectChapter(id) {
  const c = findChapter(id);
  if (!c) return;
  c.collapsed = false;
  if (c.scenes && c.scenes.length) selectScene(c.scenes[0].id);
  else { setCurrentChapterId(id); renderTree(); }
}
export function loadSceneIntoEditor() {
  const wasLoading = isLoadingContent;   // restored, not cleared: refreshUI() holds the flag across its whole pass
  setLoadingContent(true);
  const s = currentScene();
  if (!s) { editor.innerHTML = ''; mdEditor.value = ''; }
  else if (mdMode) mdEditor.value = s.markdownContent || htmlToMd(s.content);
  else { editor.innerHTML = s.content || ''; reconcileNotes(s); }
  updateBreadcrumb();
  updateSceneMeta();
  setLoadingContent(wasLoading);
}
export function saveCurrentScene() {
  const s = currentScene();
  if (!s) return;
  const before = s.content;
  // The HTML -> Markdown -> HTML round trip is lossy (fonts, alignment, …), so the HTML is only
  // regenerated when the Markdown was actually edited.
  if (mdMode) { 
    if (mdEditor.value !== htmlToMd(s.content)) {
      s.content = mdToHtml(mdEditor.value); 
    }
    s.markdownContent = mdEditor.value; 
  }
  else { s.content = editor.innerHTML; s.markdownContent = htmlToMd(s.content); }
  s.wordCount = countWords(stripHtml(s.content));
  if (s.content !== before) s.modifiedAt = new Date().toISOString();
  const c = currentChapter();
  if (c) c.wordCount = chapterWordCount(c);
}

/* ---- scene CRUD ---- */
export function addScene(chapterId) {
  const c = chapterId ? findChapter(chapterId) : currentChapter();
  if (!c) return null;
  saveCurrentScene();
  const s = blankScene((c.scenes || []).length);
  c.scenes.push(s);
  c.collapsed = false;
  setCurrentChapterId(c.id);
  setCurrentSceneId(s.id);
  setOpenNoteId(null);
  loadSceneIntoEditor();
  renderTree();
  updateCounters();
  renderNotes();
  renderNoteCard();
  markDirty();
  toast('Scene added');
  return s;
}
export function duplicateScene(sceneId) {
  saveCurrentScene();
  const f = findScene(sceneId);
  if (!f) return;
  const now = new Date().toISOString();
  const copy = { ...f.scene, id: uuid(), title: f.scene.title + ' (copy)', createdAt: now, modifiedAt: now };
  copy.notes = (f.scene.notes || []).map(n => ({ ...n, id: uuid() }));
  const idx = f.chapter.scenes.findIndex(s => s.id === sceneId);
  f.chapter.scenes.splice(idx + 1, 0, copy);
  renderTree();
  markDirty();
  toast('Scene duplicated');
}
/* Re-render everything a structural change (delete / undo) can affect. */
function refreshAfterStructureChange() {
  setOpenNoteId(null);
  loadSceneIntoEditor();
  renderTree();
  updateCounters();
  renderNotes();
  renderNoteCard();
  if (corkboardOpen) renderCorkboard();
}
/* Deleting is immediate and undoable from the toast (no "cannot be undone" prompt). The
   undo puts the very same object back where it was, so ids, notes and compile items stay
   intact; it does nothing once another novel has been opened. Only the latest deletion can
   be undone: a new one retires the previous Undo, so nothing comes back out of order or into
   a chapter that is gone. */
let dismissUndo = null;
function offerUndo(msg, onUndo) {
  if (dismissUndo) dismissUndo();
  dismissUndo = toastAction(msg, 'Undo', onUndo);
}
export function deleteScene(sceneId) {
  const f = findScene(sceneId);
  if (!f) return;
  const c = f.chapter;
  if (c.scenes.length === 1) { toast('A chapter must keep at least one scene'); return; }
  const owner = novel;
  const wasCurrent = currentSceneId === sceneId;
  if (wasCurrent) saveCurrentScene();          // what Undo brings back includes the latest typing
  const idx = c.scenes.findIndex(s => s.id === sceneId);
  const [removed] = c.scenes.splice(idx, 1);
  if (wasCurrent) { setCurrentSceneId(c.scenes[Math.max(0, idx - 1)].id); setCurrentChapterId(c.id); }
  refreshAfterStructureChange();
  markDirty();
  offerUndo(`Scene “${removed.title}” deleted`, () => {
    if (novel !== owner || findScene(removed.id) || !findChapter(c.id)) return;
    c.scenes.splice(Math.min(idx, c.scenes.length), 0, removed);
    if (wasCurrent) selectScene(removed.id); else refreshAfterStructureChange();
    if (corkboardOpen) renderCorkboard();
    markDirty();
  });
}
export function renameScene(sceneId) {
  const f = findScene(sceneId);
  if (!f) return;
  promptModal('Rename scene', 'New title:', f.scene.title, v => {
    if (!v || v === f.scene.title) return;
    f.scene.title = v;
    renderTree(); updateBreadcrumb();
    if (corkboardOpen) renderCorkboard();
    markDirty();
  });
}
export function moveSceneToChapter(sceneId, chapterId) {
  const f = findScene(sceneId);
  const dest = findChapter(chapterId);
  if (!f || !dest || f.chapter.id === chapterId) return;
  if (f.chapter.scenes.length === 1) { toast('A chapter must keep at least one scene'); return; }
  const idx = f.chapter.scenes.findIndex(s => s.id === sceneId);
  const [moved] = f.chapter.scenes.splice(idx, 1);
  dest.scenes.push(moved);
  dest.collapsed = false;
  renderTree(); updateBreadcrumb(); updateCounters();
  if (corkboardOpen) renderCorkboard();
  markDirty();
  toast('Scene moved to ' + dest.title);
}

/* ---- chapter CRUD ---- */
function addChapter() {
  if (!novel) return;
  saveCurrentScene();
  const c = blankChapter(novel.chapters.length);
  novel.chapters.push(c);
  setCurrentChapterId(c.id);
  setCurrentSceneId(c.scenes[0].id);
  setOpenNoteId(null);
  loadSceneIntoEditor();
  renderTree();
  updateCounters();
  renderNotes();
  renderNoteCard();
  markDirty();
  toast('Chapter added');
}
export function duplicateChapter(id) {
  saveCurrentScene();
  const src = findChapter(id);
  if (!src) return;
  const copy = { ...src, id: uuid(), title: src.title + ' (copy)' };
  copy.scenes = (src.scenes || []).map(s => ({
    ...s, id: uuid(), notes: (s.notes || []).map(n => ({ ...n, id: uuid() }))
  }));
  const idx = novel.chapters.findIndex(c => c.id === id);
  novel.chapters.splice(idx + 1, 0, copy);
  renderTree();
  markDirty();
  toast('Chapter duplicated');
}
export function deleteChapter(id) {
  if (novel.chapters.length === 1) { toast('Cannot delete the last chapter'); return; }
  const idx = novel.chapters.findIndex(c => c.id === id);
  if (idx === -1) return;
  const owner = novel;
  const wasCurrent = currentChapterId === id;
  const prevSceneId = currentSceneId;
  if (wasCurrent) saveCurrentScene();
  const [removed] = novel.chapters.splice(idx, 1);
  if (wasCurrent) {
    const nc = novel.chapters[Math.max(0, idx - 1)];
    setCurrentChapterId(nc.id);
    setCurrentSceneId(nc.scenes[0].id);
  }
  refreshAfterStructureChange();
  markDirty();
  offerUndo(`Chapter “${removed.title}” deleted`, () => {
    if (novel !== owner || findChapter(removed.id)) return;
    novel.chapters.splice(Math.min(idx, novel.chapters.length), 0, removed);
    if (wasCurrent && findScene(prevSceneId)) selectScene(prevSceneId); else refreshAfterStructureChange();
    if (corkboardOpen) renderCorkboard();
    markDirty();
  });
}
export function renameChapter(id) {
  const c = findChapter(id);
  if (!c) return;
  promptModal('Rename chapter', 'New title:', c.title, val => {
    if (!val || val === c.title) return;
    c.title = val;
    renderTree(); updateBreadcrumb();
    if (corkboardOpen) renderCorkboard();
    markDirty();
  });
}
export function setAllCollapsed(v) { if (!novel) return; novel.chapters.forEach(c => (c.collapsed = v)); renderTree(); }

/* ---- breadcrumb (top bar) ---- */
function updateBreadcrumb() {
  const bc = $('#breadcrumb');
  if (!bc) return;
  bc.innerHTML = '';
  const c = currentChapter(), s = currentScene();
  if (!novel || !c) return;
  const sep = () => { const x = document.createElement('span'); x.className = 'bc-sep'; x.textContent = '›'; return x; };
  const part = (text, cls, handler) => {
    const b = document.createElement('button');
    b.className = 'bc-part ' + cls;
    b.textContent = text;
    // A title edit still in progress is committed here, not on mousedown (see the breadcrumb
    // mousedown listener near nvTitle).
    if (handler) b.onclick = () => { if (document.activeElement === nvTitle) nvTitle.blur(); handler(); };
    return b;
  };
  bc.appendChild(part(novel.title || 'Untitled Novel', 'bc-novel', () => { if (novel) nvTitle.dispatchEvent(new MouseEvent('dblclick')); }));
  bc.appendChild(sep());
  bc.appendChild(part(c.title, 'bc-chapter', () => selectChapter(c.id)));
  if (s) { bc.appendChild(sep()); bc.appendChild(part(s.title, 'bc-scene', () => renameScene(s.id))); }
}

/* ---- scene metadata bar ---- */
export function fillSelect(sel, opts, val) {
  if (!sel) return;
  sel.innerHTML = '';
  opts.forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    if (v === val) o.selected = true;
    sel.appendChild(o);
  });
}
export function updateSceneMeta() {
  const bar = $('#sceneMeta');
  if (!bar) return;
  const s = currentScene();
  const showBtn = $('#metaShow');
  if (!novel || !s) { bar.classList.add('hidden'); if (showBtn) showBtn.classList.add('hidden'); return; }
  if (metaHidden) { bar.classList.add('hidden'); if (showBtn) showBtn.classList.remove('hidden'); return; }
  if (showBtn) showBtn.classList.add('hidden');
  bar.classList.remove('hidden');
  fillSelect($('#metaPov'), [['', '👤 POV: —'], ...novel.characters.map(c => [c.id, '👤 ' + (c.name || '(unnamed)')])], s.povCharacter || '');
  fillSelect($('#metaLoc'), [['', '📍 Location: —'], ...novel.locations.map(l => [l.id, '📍 ' + (l.name || '(unnamed)')])], s.location || '');
  fillSelect($('#metaTime'), TIME_OF_DAY.map(t => [t[0], t[2] + ' ' + t[1]]), s.timeOfDay || 'unknown');
  fillSelect($('#metaStatus'), SCENE_STATUS.map(x => [x[0], x[1]]), s.status || 'draft');
}
let metaHidden = false;
function bindSceneMeta() {
  const set = (key, val) => { const s = currentScene(); if (!s) return; s[key] = val; s.modifiedAt = new Date().toISOString(); markDirty(); renderTree(); if (corkboardOpen) renderCorkboard(); };
  const pov = $('#metaPov'); if (pov) pov.addEventListener('change', e => set('povCharacter', e.target.value || null));
  const loc = $('#metaLoc'); if (loc) loc.addEventListener('change', e => set('location', e.target.value || null));
  const tim = $('#metaTime'); if (tim) tim.addEventListener('change', e => set('timeOfDay', e.target.value));
  const sta = $('#metaStatus'); if (sta) sta.addEventListener('change', e => set('status', e.target.value));
  const hide = $('#metaHide'); if (hide) hide.addEventListener('click', () => { metaHidden = true; updateSceneMeta(); });
  const show = $('#metaShow'); if (show) show.addEventListener('click', () => { metaHidden = false; updateSceneMeta(); });
}

/* Reordering uses mousedown/mousemove/mouseup, not the HTML5 Drag API, which is unreliable in
   the WebView2/Chromium webview under the global `user-select: none`. A press becomes a drag
   only after 5px of movement; below that it is a click (select a scene / toggle a chapter).
   move/up listen on document so a release outside the sidebar still ends the drag. */
let treeDrag = null;
/* A click on a chapter row collapses or expands it; a double-click renames it. The first click has
   toggled the chapter by the time the second press comes (the OS allows ~500 ms), and with the tree
   scrolled to its end the shorter list slides another row under the pointer. So on the release of
   the second press (unless it turned into a drag) that click's toggle is undone and the chapter
   that was clicked is renamed, whatever is under the pointer now; the click/dblclick events that
   follow are swallowed. */
let chapterClick = null;        // { id, was, scrollTop } of the last click on a chapter row, until the next press
let chapterRename = null;       // that click again, while the second press of its double-click is down
let swallowTreeClicks = false;
function setChapterCollapsed(c, v) {
  c.collapsed = v;
  // in place: rebuilding the tree would detach the row under the pointer
  const li = chapterList.querySelector(`.tree-chapter[data-chapter-id="${CSS.escape(String(c.id))}"]`);
  if (li) li.classList.toggle('collapsed', v); else renderTree();
}
function clearTreeDrop() { $$('.tree-scene,.tree-chapter').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-into')); }
function applySceneDrop(sceneId, target) {
  const f = findScene(sceneId);
  if (!f) return;
  const from = f.chapter;
  if (target.kind === 'scene') {
    const g = findScene(target.id);
    if (!g || target.id === sceneId) return;
    if (g.chapter.id !== from.id && from.scenes.length === 1) { toast('A chapter must keep at least one scene'); return; }
    const idx = from.scenes.findIndex(s => s.id === sceneId);
    const [moved] = from.scenes.splice(idx, 1);
    const dest = g.chapter;
    let di = dest.scenes.findIndex(s => s.id === target.id);
    if (target.after) di += 1;
    dest.scenes.splice(di, 0, moved);
  } else if (target.kind === 'chapter-into') {
    const dest = findChapter(target.id);
    if (!dest || dest.id === from.id) return;
    if (from.scenes.length === 1) { toast('A chapter must keep at least one scene'); return; }
    const idx = from.scenes.findIndex(s => s.id === sceneId);
    const [moved] = from.scenes.splice(idx, 1);
    dest.scenes.push(moved);
    dest.collapsed = false;
  }
  // selection stays on whatever scene was open (currentChapter derives from it)
  renderTree();
  updateBreadcrumb();
  updateCounters();
  if (corkboardOpen) renderCorkboard();
  markDirty();
}
function applyChapterDrop(chapterId, target) {
  if (target.kind !== 'chapter' || target.id === chapterId) return;
  const from = novel.chapters.findIndex(c => c.id === chapterId);
  const [moved] = novel.chapters.splice(from, 1);
  let to = novel.chapters.findIndex(c => c.id === target.id);
  if (target.after) to += 1;
  novel.chapters.splice(to, 0, moved);
  renderTree();
  if (corkboardOpen) renderCorkboard();
  markDirty();
}

export function init() {
  /* ---- tree interaction: caret / add / select / pointer drag ---- */
  chapterList.addEventListener('click', e => {
    if (swallowTreeClicks) return;
    const caret = e.target.closest('.tc-caret');
    if (caret) { const c = findChapter(caret.closest('.tree-chapter').dataset.chapterId); if (c) { c.collapsed = !c.collapsed; renderTree(); } return; }
    const add = e.target.closest('.tc-add');
    if (add) { addScene(add.closest('.tree-chapter').dataset.chapterId); return; }
  });
  chapterList.addEventListener('dblclick', e => {   // chapters are renamed on the second press (below)
    if (swallowTreeClicks) { swallowTreeClicks = false; return; }
    const sc = e.target.closest('.tree-scene');
    if (sc) renameScene(sc.dataset.sceneId);
  });
  // a press anywhere else ends a pending chapter click: a double-click that began elsewhere (say on a
  // context-menu item over the tree) is not a double-click on that chapter
  document.addEventListener('mousedown', e => { if (!chapterList.contains(e.target)) chapterClick = null; }, true);
  chapterList.addEventListener('mousedown', e => {
    const click = chapterClick;
    chapterClick = null;
    if (e.button !== 0) return;
    swallowTreeClicks = false;
    chapterRename = e.detail > 1 && click ? click : null;   // second press of a double-click on a chapter row
    if (chapterRename) e.preventDefault();
    if (e.target.closest('.tc-caret') || e.target.closest('.tc-add')) return;   // buttons handled on click
    const sceneEl = e.target.closest('.tree-scene');
    const chapRow = e.target.closest('.tc-row');
    if (sceneEl) treeDrag = { type: 'scene', id: sceneEl.dataset.sceneId, el: sceneEl, startX: e.clientX, startY: e.clientY, started: false, target: null };
    else if (chapRow) treeDrag = { type: 'chapter', id: chapRow.dataset.chapterId, el: chapRow.closest('.tree-chapter'), startX: e.clientX, startY: e.clientY, started: false, target: null };
  });
  document.addEventListener('mousemove', e => {
    if (!treeDrag) return;
    if (!treeDrag.started) {
      if (Math.abs(e.clientX - treeDrag.startX) < 5 && Math.abs(e.clientY - treeDrag.startY) < 5) return;
      treeDrag.started = true;
      treeDrag.el.classList.add('dragging');
      chapterRename = null;   // a press that drags is a drag, double-click or not
    }
    e.preventDefault();
    clearTreeDrop();
    treeDrag.target = null;
    // Hit-testing is by Y only (the tree is one column). A scene drops before/after the scene row
    // under it, or at the end of a chapter whose header row is under it; a chapter drops
    // before/after another chapter's whole block (header and scenes).
    if (treeDrag.type === 'scene') {
      const over = $$('.tree-scene').find(x => { const r = x.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; });
      if (over && over !== treeDrag.el) {
        const r = over.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        over.classList.add(after ? 'drop-after' : 'drop-before');
        treeDrag.target = { kind: 'scene', id: over.dataset.sceneId, after };
      } else {
        const overCh = $$('.tc-row').find(x => { const r = x.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; });
        if (overCh) { overCh.closest('.tree-chapter').classList.add('drop-into'); treeDrag.target = { kind: 'chapter-into', id: overCh.dataset.chapterId }; }
      }
    } else {
      const over = $$('.tree-chapter').find(x => { const r = x.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; });
      if (over && over !== treeDrag.el) {
        const r = over.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        over.classList.add(after ? 'drop-after' : 'drop-before');
        treeDrag.target = { kind: 'chapter', id: over.dataset.chapterId, after };
      }
    }
  });
  document.addEventListener('mouseup', () => {
    const d = treeDrag;
    treeDrag = null;
    if (d) { clearTreeDrop(); d.el.classList.remove('dragging'); }
    if (chapterRename) {
      const click = chapterRename;
      chapterRename = null;
      swallowTreeClicks = true;
      const c = findChapter(click.id);
      if (c) { setChapterCollapsed(c, click.was); chapterList.scrollTop = click.scrollTop; renameChapter(c.id); }
      return;
    }
    if (!d) return;
    if (!d.started) {                                   // under the drag threshold -> click
      if (d.type === 'scene') { if (d.id !== currentSceneId) selectScene(d.id); }
      else {
        const c = findChapter(d.id);
        // remembers the state before this toggle, for a double-click to restore
        if (c) { chapterClick = { id: c.id, was: !!c.collapsed, scrollTop: chapterList.scrollTop }; setChapterCollapsed(c, !c.collapsed); }
      }
      return;
    }
    if (!d.target) return;
    if (d.type === 'scene') applySceneDrop(d.id, d.target);
    else applyChapterDrop(d.id, d.target);
  });
  /* "+" add-chapter button */
  $('#btnAddChapter').addEventListener('click', addChapter);
  bindSceneMeta();
}
