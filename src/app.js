/* ================= NovelCraft ================= */
'use strict';

/* ---------- Tauri bridge (graceful browser fallback) ---------- */
const TAURI = window.__TAURI__ || null;
const hasTauri = !!TAURI;
const invoke = hasTauri ? TAURI.core.invoke : async () => null;
const listen = hasTauri ? TAURI.event.listen : async () => () => {};

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uuid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const countWords = t => {
  const m = (t || '').trim().match(/[\p{L}\p{N}'’-]+/gu);
  return m ? m.length : 0;
};
const stripHtml = html => {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent || '';
};

/* ---------- state ---------- */
function nowISO() { return new Date().toISOString(); }
function blankScene(n) {
  return {
    id: uuid(), title: `Scene ${n + 1}`, order: n,
    content: '', markdownContent: '', wordCount: 0,
    povCharacter: null, location: null, timeOfDay: 'unknown', status: 'draft',
    notes: [], createdAt: nowISO(), modifiedAt: nowISO()
  };
}
function blankChapter(n) {
  return { id: uuid(), order: n, title: `Chapter ${n + 1}`, wordCount: 0, collapsed: false, scenes: [blankScene(0)] };
}
/* A fresh, empty world map (lives in novel.settings.worldMap). The background
   image is stored inline as a base64 data URL so the map is self-contained and
   works in the browser fallback (no external file to resolve). */
function blankWorldMap() {
  return {
    backgroundImage: '', imageW: 0, imageH: 0,
    locations: {},              // locationId -> { x:0-1, y:0-1, visible }
    routes: [],
    layers: [],                 // custom drawing layers
    baseLayers: { background: true, locations: true, routes: true, labels: true }
  };
}
/* One .novel file = ONE novel. Structure matches the original spec:
   { version, title, settings, chapters[], characters[], locations[], races[] } */
function newNovel(title) {
  return {
    version: '1.0',
    title: title || 'Untitled Novel',
    settings: { fontSize: 18, defaultFont: 'Georgia, serif', wordGoal: 80000, customNoteTypes: [], noteTypeColors: {}, worldMap: blankWorldMap(), compilationPresets: [] },
    chapters: [blankChapter(0)],
    characters: [],
    locations: [],
    races: []
  };
}

let novel = null;              // the currently-open novel (null = none open)
let currentChapterId = null;
let currentSceneId = null;     // the scene currently loaded in the editor
let currentFilePath = null;    // path of the open .novel file (null = never saved)
let dirty = false;
let mdMode = false;
let focusMode = false;
let typewriter = false;

/* --- dirty-tracking (Bug 2) --- */
let isLoadingContent = false;  // true while we programmatically populate the editor
let savedContent = {};         // chapterId -> normalized HTML snapshot at last save/load
let savedMd = {};              // chapterId -> markdown snapshot at last save/load


/* ---------- DOM refs ---------- */
const editor = $('#editor');
const mdEditor = $('#mdEditor');
const chapterList = $('#chapterList');

/* ================= DIRTY / SAVE INDICATOR ================= */
function markDirty() {
  if (isLoadingContent) return;   // ignore mutations caused by programmatic loads
  dirty = true;
  const ind = $('#saveIndicator');
  ind.textContent = 'Unsaved';
  ind.classList.remove('saving');
}
function setSaved() {
  dirty = false;
  const ind = $('#saveIndicator');
  ind.textContent = 'Saved';
  ind.classList.remove('saving');
}

/* Normalize HTML so trivial browser differences don't look like edits (Bug 2B). */
function normalizeHTML(html) {
  try {
    const doc = new DOMParser().parseFromString('<div id="__r">' + (html || '') + '</div>', 'text/html');
    const root = doc.getElementById('__r');
    root.querySelectorAll('*').forEach(el => {                 // sort attributes alphabetically
      const names = [...el.attributes].map(a => a.name).sort();
      const vals = {};
      names.forEach(n => (vals[n] = el.getAttribute(n)));
      names.forEach(n => el.removeAttribute(n));
      names.forEach(n => el.setAttribute(n, vals[n]));
    });
    let s = root.innerHTML;
    s = s.replace(/>\s+</g, '><');            // trim whitespace between tags
    s = s.replace(/<br\s*\/?>/gi, '<br/>');   // standardize <br>
    s = s.replace(/(?:<p>(?:\s|<br\/>)*<\/p>)+$/i, ''); // drop trailing empty paragraphs
    return s.trim();
  } catch { return (html || '').trim(); }
}
/* Capture a clean snapshot of the whole novel so edits can be compared against it. */
function snapshotSaved() {
  savedContent = {};
  savedMd = {};
  if (!novel) return;
  novel.chapters.forEach(c => (c.scenes || []).forEach(s => {
    savedContent[s.id] = normalizeHTML(s.content);
    savedMd[s.id] = s.markdownContent || '';
  }));
}
function setSaving() {
  const ind = $('#saveIndicator');
  ind.textContent = 'Saving…';
  ind.classList.add('saving');
}

/* ================= SCENES & CHAPTERS (tree) ================= */
/* A chapter is a container of scenes. A scene is the writing unit that the
   editor edits; it carries content, per-scene metadata, and margin notes. */
const TIME_OF_DAY = [
  ['morning', 'Morning', '🌅'], ['afternoon', 'Afternoon', '🌞'], ['evening', 'Evening', '🌆'],
  ['night', 'Night', '🌙'], ['dawn', 'Dawn', '🌄'], ['dusk', 'Dusk', '🌇'], ['unknown', 'Unknown', '❓']
];
const SCENE_STATUS = [
  ['draft', 'Draft', '#8f887c'], ['review', 'Review', '#e6b422'], ['done', 'Done', '#5cb85c']
];
function timeMeta(id) { return TIME_OF_DAY.find(t => t[0] === id) || TIME_OF_DAY[6]; }
function statusMeta(id) { return SCENE_STATUS.find(s => s[0] === id) || SCENE_STATUS[0]; }

/* currentChapter/currentScene derive from currentSceneId so a stale
   currentChapterId (after a drag/move) can never disagree with the loaded scene. */
function currentChapter() {
  if (!novel) return null;
  if (currentSceneId) { const f = findScene(currentSceneId); if (f) return f.chapter; }
  return novel.chapters.find(c => c.id === currentChapterId) || novel.chapters[0];
}
function currentScene() {
  if (!novel) return null;
  if (currentSceneId) { const f = findScene(currentSceneId); if (f) return f.scene; }
  const c = novel.chapters.find(c => c.id === currentChapterId) || novel.chapters[0];
  return c ? (c.scenes[0] || null) : null;
}
function findScene(id) {
  if (!novel) return null;
  for (const c of novel.chapters) {
    const s = (c.scenes || []).find(x => x.id === id);
    if (s) return { chapter: c, scene: s };
  }
  return null;
}
function findChapter(id) { return novel ? novel.chapters.find(c => c.id === id) : null; }
function chapterWordCount(c) { return (c.scenes || []).reduce((s, x) => s + (x.wordCount || 0), 0); }
function renumber() {
  if (!novel) return;
  novel.chapters.forEach((c, i) => { c.order = i; (c.scenes || []).forEach((s, j) => (s.order = j)); });
}

/* ---- tree render ---- */
function renderTree() {
  chapterList.innerHTML = '';
  if (!novel) return;
  renumber();
  novel.chapters.forEach((c, ci) => {
    c.wordCount = chapterWordCount(c);
    const chLi = document.createElement('li');
    chLi.className = 'tree-chapter' + (c.collapsed ? ' collapsed' : '') + (c.id === currentChapterId ? ' active' : '');
    chLi.dataset.chapterId = c.id;
    chLi.innerHTML =
      `<div class="tc-row" data-chapter-id="${c.id}">
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
      const st = statusMeta(s.status);
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
const renderChapters = renderTree;   // back-compat alias for existing callers

/* ---- selection / editor sync ---- */
function selectScene(sceneId, saveFirst = true) {
  if (saveFirst) saveCurrentScene();
  const f = findScene(sceneId);
  if (!f) return;
  currentChapterId = f.chapter.id;
  currentSceneId = sceneId;
  openNoteId = null;
  closeAddNote();
  loadSceneIntoEditor();
  renderTree();
  updateCounters();
  renderNotes();
  renderNoteCard();
  localBackup();
}
function selectChapter(id) {
  const c = findChapter(id);
  if (!c) return;
  c.collapsed = false;
  if (c.scenes && c.scenes.length) selectScene(c.scenes[0].id);
  else { currentChapterId = id; renderTree(); }
}
function loadSceneIntoEditor() {
  const wasLoading = isLoadingContent;
  isLoadingContent = true;               // programmatic editor population must not mark dirty
  const s = currentScene();
  if (!s) { editor.innerHTML = ''; mdEditor.value = ''; }
  else if (mdMode) mdEditor.value = s.markdownContent || htmlToMd(s.content);
  else editor.innerHTML = s.content || '';
  updateBreadcrumb();
  updateSceneMeta();
  isLoadingContent = wasLoading;
}
function saveCurrentScene() {
  const s = currentScene();
  if (!s) return;
  if (mdMode) { s.markdownContent = mdEditor.value; s.content = mdToHtml(mdEditor.value); }
  else { s.content = editor.innerHTML; s.markdownContent = htmlToMd(s.content); }
  s.wordCount = countWords(stripHtml(s.content));
  s.modifiedAt = new Date().toISOString();
  const c = currentChapter();
  if (c) c.wordCount = chapterWordCount(c);
}
/* thin aliases kept so file I/O helpers (flushNovel, doSave, recovery…) still work */
function saveCurrentChapter() { saveCurrentScene(); }
function loadChapterIntoEditor() { loadSceneIntoEditor(); }
const loadChapter = id => selectChapter(id);

/* ---- scene CRUD ---- */
function addScene(chapterId) {
  const c = chapterId ? findChapter(chapterId) : currentChapter();
  if (!c) return null;
  saveCurrentScene();
  const s = blankScene((c.scenes || []).length);
  c.scenes.push(s);
  c.collapsed = false;
  currentChapterId = c.id;
  currentSceneId = s.id;
  openNoteId = null;
  loadSceneIntoEditor();
  renderTree();
  updateCounters();
  renderNotes();
  renderNoteCard();
  markDirty();
  toast('Scene added');
  return s;
}
function duplicateScene(sceneId) {
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
function deleteScene(sceneId) {
  const f = findScene(sceneId);
  if (!f) return;
  const c = f.chapter;
  if (c.scenes.length === 1) { toast('A chapter must keep at least one scene'); return; }
  confirmModal('Delete scene', 'Delete this scene? This cannot be undone.', () => {
    const idx = c.scenes.findIndex(s => s.id === sceneId);
    c.scenes.splice(idx, 1);
    if (currentSceneId === sceneId) { currentSceneId = c.scenes[Math.max(0, idx - 1)].id; currentChapterId = c.id; }
    openNoteId = null;
    loadSceneIntoEditor();
    renderTree();
    updateCounters();
    renderNotes();
    renderNoteCard();
    markDirty();
    toast('Scene deleted');
  });
}
function renameScene(sceneId) {
  const f = findScene(sceneId);
  if (!f) return;
  promptModal('Rename scene', 'New title:', f.scene.title, v => {
    f.scene.title = v || f.scene.title;
    renderTree(); updateBreadcrumb(); markDirty();
  });
}
function moveSceneToChapter(sceneId, chapterId) {
  const f = findScene(sceneId);
  const dest = findChapter(chapterId);
  if (!f || !dest || f.chapter.id === chapterId) return;
  if (f.chapter.scenes.length === 1) { toast('A chapter must keep at least one scene'); return; }
  const idx = f.chapter.scenes.findIndex(s => s.id === sceneId);
  const [moved] = f.chapter.scenes.splice(idx, 1);
  dest.scenes.push(moved);
  dest.collapsed = false;
  renderTree(); updateBreadcrumb(); updateCounters(); markDirty();
  toast('Scene moved to ' + dest.title);
}

/* ---- chapter CRUD ---- */
function addChapter() {
  if (!novel) return;
  saveCurrentScene();
  const c = blankChapter(novel.chapters.length);
  novel.chapters.push(c);
  currentChapterId = c.id;
  currentSceneId = c.scenes[0].id;
  openNoteId = null;
  loadSceneIntoEditor();
  renderTree();
  updateCounters();
  renderNotes();
  renderNoteCard();
  markDirty();
  toast('Chapter added');
}
function duplicateChapter(id) {
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
function deleteChapter(id) {
  if (novel.chapters.length === 1) { toast('Cannot delete the last chapter'); return; }
  confirmModal('Delete chapter', 'Delete this chapter and all its scenes? This cannot be undone.', () => {
    const idx = novel.chapters.findIndex(c => c.id === id);
    novel.chapters.splice(idx, 1);
    if (currentChapterId === id) {
      const nc = novel.chapters[Math.max(0, idx - 1)];
      currentChapterId = nc.id;
      currentSceneId = nc.scenes[0].id;
    }
    openNoteId = null;
    loadSceneIntoEditor();
    renderTree();
    updateCounters();
    renderNotes();
    renderNoteCard();
    markDirty();
    toast('Chapter deleted');
  });
}
function renameChapter(id) {
  const c = findChapter(id);
  if (!c) return;
  promptModal('Rename chapter', 'New title:', c.title, val => {
    c.title = val || c.title;
    renderTree(); updateBreadcrumb(); markDirty();
  });
}
function setAllCollapsed(v) { if (!novel) return; novel.chapters.forEach(c => (c.collapsed = v)); renderTree(); }

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
    if (handler) b.onclick = handler;
    return b;
  };
  bc.appendChild(part(novel.title || 'Untitled Novel', 'bc-novel', () => { if (novel) nvTitle.dispatchEvent(new MouseEvent('dblclick')); }));
  bc.appendChild(sep());
  bc.appendChild(part(c.title, 'bc-chapter', () => selectChapter(c.id)));
  if (s) { bc.appendChild(sep()); bc.appendChild(part(s.title, 'bc-scene', () => renameScene(s.id))); }
}

/* ---- scene metadata bar ---- */
function fillSelect(sel, opts, val) {
  if (!sel) return;
  sel.innerHTML = '';
  opts.forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    if (v === val) o.selected = true;
    sel.appendChild(o);
  });
}
function updateSceneMeta() {
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

/* ---- tree interaction: caret / add / select / pointer drag ---- */
chapterList.addEventListener('click', e => {
  const caret = e.target.closest('.tc-caret');
  if (caret) { const c = findChapter(caret.closest('.tree-chapter').dataset.chapterId); if (c) { c.collapsed = !c.collapsed; renderTree(); } return; }
  const add = e.target.closest('.tc-add');
  if (add) { addScene(add.closest('.tree-chapter').dataset.chapterId); return; }
});
chapterList.addEventListener('dblclick', e => {
  const sc = e.target.closest('.tree-scene');
  if (sc) { renameScene(sc.dataset.sceneId); return; }
  const cr = e.target.closest('.tc-row');
  if (cr) renameChapter(cr.dataset.chapterId);
});

let treeDrag = null;
function clearTreeDrop() { $$('.tree-scene,.tree-chapter').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-into')); }
chapterList.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
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
  }
  e.preventDefault();
  clearTreeDrop();
  treeDrag.target = null;
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
  if (!treeDrag) return;
  const d = treeDrag;
  treeDrag = null;
  clearTreeDrop();
  d.el.classList.remove('dragging');
  if (!d.started) {                                   // no movement -> click
    if (d.type === 'scene') { if (d.id !== currentSceneId) selectScene(d.id); }
    else { const c = findChapter(d.id); if (c) { c.collapsed = !c.collapsed; renderTree(); } }
    return;
  }
  if (!d.target) return;
  if (d.type === 'scene') applySceneDrop(d.id, d.target);
  else applyChapterDrop(d.id, d.target);
});
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
  markDirty();
}

/* "+" add-chapter button */
$('#btnAddChapter').addEventListener('click', addChapter);
bindSceneMeta();

/* ================= NOVEL FILE (one file = one novel) ================= */
function baseName(p) { return p ? p.replace(/\\/g, '/').split('/').pop() : ''; }
function updateWindowTitle() {
  const t = novel ? (novel.title || 'Untitled Novel') : 'No Novel';
  document.title = 'NovelCraft — ' + t;
  if (hasTauri) { try { invoke('set_window_title', { title: t }); } catch (_) {} }
}
function updateFilePathIndicator() {
  const el = $('#filePathIndicator');
  if (!novel) { el.textContent = ''; el.title = ''; el.classList.remove('unsaved'); return; }
  if (currentFilePath) {
    el.textContent = baseName(currentFilePath);
    el.title = currentFilePath;
    el.classList.remove('unsaved');
  } else {
    el.textContent = '• Unsaved';
    el.title = 'This novel has not been saved to a file yet';
    el.classList.add('unsaved');
  }
}
function flushNovel() { if (novel) saveCurrentChapter(); }

/* Render the whole UI for the current `novel` (or the empty state). */
function refreshUI() {
  const has = !!novel;
  isLoadingContent = true;
  editor.setAttribute('contenteditable', has ? 'true' : 'false');
  $('#emptyState').classList.toggle('hidden', has);
  $('#chaptersSection').classList.toggle('hidden', !has);
  $('#novelTitle').textContent = has ? (novel.title || 'Untitled Novel') : '—';
  if (has) {
    currentChapterId = novel.chapters[0] && novel.chapters[0].id;
    currentSceneId = novel.chapters[0] && novel.chapters[0].scenes[0] && novel.chapters[0].scenes[0].id;
    applyFontSize(novel.settings.fontSize || 18);
    applyDocFont(novel.settings.defaultFont || 'Georgia, serif');
  } else {
    currentChapterId = null;
    currentSceneId = null;
  }
  loadSceneIntoEditor();
  renderTree();
  renderEntities('characters');
  renderEntities('locations');
  renderEntities('races');
  updateCounters();
  updateWindowTitle();
  updateFilePathIndicator();
  openNoteId = null;
  closeAddNote();
  ensureHighlightStyles();
  renderNoteTypeSettings();
  renderNotes();
  renderNoteCard();
  isLoadingContent = false;
}

/* Serialize the current novel to the clean .novel file structure. */
function toFileObject(n) {
  return {
    version: '1.0',
    title: n.title || 'Untitled Novel',
    settings: n.settings,
    chapters: n.chapters,
    characters: n.characters,
    locations: n.locations,
    races: n.races
  };
}
function serializeNovel(n) { return JSON.stringify(toFileObject(n), null, 2); }

/* Normalize any loaded object into a valid in-memory novel. */
function migrateNovel(d) {
  d = d || {};
  const base = newNovel(d.title);
  const n = { ...base, ...d };
  n.version = '1.0';
  n.title = d.title || 'Untitled Novel';
  n.settings = { ...base.settings, ...(d.settings || {}) };
  if (!Array.isArray(n.settings.customNoteTypes)) n.settings.customNoteTypes = [];
  if (!n.settings.noteTypeColors || typeof n.settings.noteTypeColors !== 'object') n.settings.noteTypeColors = {};
  n.settings.customNoteTypes.forEach(t => { if (!t.id) t.id = uuid(); });
  // world map
  const wm = { ...blankWorldMap(), ...(n.settings.worldMap || {}) };
  if (typeof wm.locations !== 'object' || !wm.locations) wm.locations = {};
  if (!Array.isArray(wm.routes)) wm.routes = [];
  if (!Array.isArray(wm.layers)) wm.layers = [];
  wm.baseLayers = { ...blankWorldMap().baseLayers, ...(wm.baseLayers || {}) };
  wm.layers.forEach(l => {
    l.id = l.id || uuid();
    l.name = l.name || 'Layer';
    if (typeof l.visible !== 'boolean') l.visible = true;
    if (typeof l.opacity !== 'number') l.opacity = 1;
    if (!Array.isArray(l.drawings)) l.drawings = [];
  });
  wm.routes.forEach(r => {
    r.id = r.id || uuid();
    if (!Array.isArray(r.characterIds)) r.characterIds = [];
    r.color = r.color || '#c9a96e';
    if (typeof r.bidirectional !== 'boolean') r.bidirectional = true;
  });
  n.settings.worldMap = wm;
  if (!Array.isArray(n.settings.compilationPresets)) n.settings.compilationPresets = [];
  if (!Array.isArray(n.chapters) || !n.chapters.length) n.chapters = [blankChapter(0)];
  let migratedToScenes = false;
  const normNote = nt => {
    nt.id = nt.id || uuid();
    if (nt.typeId && RU_NOTE_NAME_TO_ID[nt.typeId]) nt.typeId = RU_NOTE_NAME_TO_ID[nt.typeId];
    nt.typeId = nt.typeId || 'idea';
    nt.content = nt.content || '';
    nt.selectedText = nt.selectedText || '';
    nt.startOffset = nt.startOffset || 0;
    nt.endOffset = nt.endOffset || 0;
    nt.createdAt = nt.createdAt || nowISO();
    nt.resolved = !!nt.resolved;
  };
  const normScene = (s, j) => {
    s.id = s.id || uuid();
    s.title = s.title || `Scene ${j + 1}`;
    s.order = j;
    s.content = s.content || '';
    s.markdownContent = s.markdownContent || '';
    s.wordCount = s.wordCount || countWords(stripHtml(s.content));
    if (s.povCharacter === undefined) s.povCharacter = null;
    if (s.location === undefined) s.location = null;
    s.timeOfDay = s.timeOfDay || 'unknown';
    s.status = s.status || 'draft';
    if (!Array.isArray(s.notes)) s.notes = [];
    s.notes.forEach(normNote);
    s.createdAt = s.createdAt || nowISO();
    s.modifiedAt = s.modifiedAt || nowISO();
  };
  n.chapters.forEach((c, i) => {
    c.id = c.id || uuid();
    c.order = i;
    c.title = c.title || `Chapter ${i + 1}`;
    if (typeof c.collapsed !== 'boolean') c.collapsed = false;
    if (!Array.isArray(c.scenes) || !c.scenes.length) {
      // legacy chapter: wrap its content (+notes) into a single default scene
      const s = blankScene(0);
      s.title = 'Scene 1';
      s.content = c.content || '';
      s.markdownContent = c.markdownContent || '';
      s.wordCount = countWords(stripHtml(s.content));
      s.notes = Array.isArray(c.notes) ? c.notes : [];
      c.scenes = [s];
      migratedToScenes = true;
    }
    delete c.content; delete c.markdownContent; delete c.notes;
    c.scenes.forEach(normScene);
    c.wordCount = c.scenes.reduce((sum, s) => sum + (s.wordCount || 0), 0);
  });
  if (migratedToScenes) setTimeout(() => toast('Migrated chapters to the new scene structure'), 400);
  ['characters', 'locations', 'races'].forEach(k => {
    if (!Array.isArray(n[k])) n[k] = [];
    n[k].forEach(e => { if (!e.id) e.id = uuid(); });
  });
  // characters gain relationships[] + graphPosition for the relationship graph
  n.characters.forEach(ch => {
    // legacy: `relationships` used to be a free-text field — preserve it
    if (typeof ch.relationships === 'string') { ch.relationshipNotes = ch.relationships; ch.relationships = []; }
    if (!Array.isArray(ch.relationships)) ch.relationships = [];
    ch.relationships.forEach(r => {
      r.id = r.id || uuid();
      r.type = r.type || 'friend';
      r.strength = typeof r.strength === 'number' ? r.strength : 5;
      r.status = r.status || 'active';
    });
    if (!ch.graphPosition || typeof ch.graphPosition.x !== 'number') ch.graphPosition = null;
    if (ch.hiddenInGraph === undefined) ch.hiddenInGraph = false;
  });
  return n;
}

/* Put a loaded novel object into the UI as the current file. */
function setCurrentNovel(n, path) {
  novel = migrateNovel(n);
  currentFilePath = path || null;
  refreshUI();
  snapshotSaved();
  setSaved();
}

/* Handle an old multi-novel (library) file by splitting it into separate files. */
async function handleLibraryFile(data, path) {
  const novels = (data.novels || []).map(migrateNovel);
  if (!novels.length) { setCurrentNovel(newNovel(), null); return; }
  const active = novels.find(n => n.id === data.activeNovelId) || novels[0];
  setCurrentNovel(active, path);   // keep the currently-active one in this file
  const others = novels.filter(n => n !== active);
  if (!others.length) return;
  confirmModal('Multiple novels found',
    `This file contains ${novels.length} novels, but NovelCraft now uses one file per novel. ` +
    `Save the other ${others.length} as separate .novel files now?`,
    async () => {
      for (const n of others) {
        const content = serializeNovel(n);
        if (hasTauri) {
          const p = await invoke('pick_save', { defaultName: (n.title || 'novel') + '.novel' });
          if (p) { await invoke('write_text', { path: p, content }); await addRecent(p); }
        } else {
          downloadFile((n.title || 'novel') + '.novel', content);
        }
      }
      toast('Split into separate files');
    });
}

/* --- open / new / load --- */
async function loadFromPath(path) {
  try {
    const content = await invoke('read_text', { path });
    const data = JSON.parse(content);
    if (data && Array.isArray(data.novels)) await handleLibraryFile(data, path);
    else setCurrentNovel(data, path);
    if (hasTauri) { await invoke('set_last_file', { path }); await addRecent(path); }
    toast('Opened ' + baseName(path));
  } catch (e) {
    console.error(e);
    toast('Could not open file');
  }
}
function guardUnsaved(action, msg) {
  if (dirty) confirmModal('Unsaved changes', msg, action);
  else action();
}
function openNovelFile() {
  guardUnsaved(async () => {
    if (hasTauri) {
      const path = await invoke('pick_open');
      if (path) await loadFromPath(path);
    } else {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.novel,application/json';
      inp.onchange = () => {
        const f = inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const data = JSON.parse(rd.result);
            if (data && Array.isArray(data.novels)) handleLibraryFile(data, null);
            else setCurrentNovel(data, null);
            toast('Opened ' + f.name);
          } catch { toast('Invalid file'); }
        };
        rd.readAsText(f);
      };
      inp.click();
    }
  }, 'Discard unsaved changes and open another novel?');
}
function newNovelFile() {
  guardUnsaved(async () => {
    const n = newNovel();
    if (hasTauri) {
      // prompt for the file location up front and create the file
      const path = await invoke('pick_save', { defaultName: 'Untitled Novel.novel' });
      if (!path) return;               // cancelled -> keep current novel
      setCurrentNovel(n, path);
      await invoke('write_text', { path, content: serializeNovel(novel) });
      await invoke('set_last_file', { path });
      await addRecent(path);
      toast('Created ' + baseName(path));
    } else {
      setCurrentNovel(n, null);        // browser: unsaved until first Save
      toast('New novel');
    }
  }, 'Discard unsaved changes and create a new novel?');
}

/* --- recent files --- */
async function getRecent() {
  if (!hasTauri) return [];
  try { return (await invoke('get_recent_files')) || []; } catch { return []; }
}
async function addRecent(path) {
  if (hasTauri) { try { await invoke('add_recent_file', { path }); } catch (_) {} }
  await renderRecentMenu();
}
async function renderRecentMenu() {
  const menu = $('#recentMenu');
  const list = await getRecent();
  menu.innerHTML = '';
  if (!list.length) {
    menu.innerHTML = '<button class="rm-empty" disabled>No recent files</button>';
    return;
  }
  list.slice(0, 5).forEach(p => {
    const b = document.createElement('button');
    b.textContent = baseName(p);
    b.title = p;
    b.addEventListener('click', () => {
      menu.classList.remove('open');
      guardUnsaved(() => loadFromPath(p), 'Discard unsaved changes and open this file?');
    });
    menu.appendChild(b);
  });
}

/* buttons */
$('#btnNewNovel').addEventListener('click', newNovelFile);
$('#btnOpenNovel').addEventListener('click', openNovelFile);
$('#esNew').addEventListener('click', newNovelFile);
$('#esOpen').addEventListener('click', openNovelFile);
$('#btnRecent').addEventListener('click', e => {
  e.stopPropagation();
  $('#recentMenu').classList.toggle('open');
});
document.addEventListener('click', () => $('#recentMenu').classList.remove('open'));

/* novel title inline edit (top bar) */
const nvTitle = $('#novelTitle');
nvTitle.addEventListener('dblclick', () => {
  if (!novel) return;
  nvTitle.contentEditable = 'true';
  nvTitle.focus();
  document.execCommand('selectAll', false, null);
});
nvTitle.addEventListener('blur', commitNovelTitle);
nvTitle.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); nvTitle.blur(); }
});
function commitNovelTitle() {
  nvTitle.contentEditable = 'false';
  if (!novel) return;
  const v = nvTitle.textContent.trim();
  if (v && v !== novel.title) { novel.title = v; updateWindowTitle(); markDirty(); }
  else nvTitle.textContent = novel.title;
}

/* ================= EDITOR ================= */
editor.addEventListener('input', () => {
  if (isLoadingContent) return;          // skip programmatic loads (Bug 2A)
  const s = currentScene();
  if (!s) return;
  s.content = editor.innerHTML;
  s.wordCount = countWords(stripHtml(s.content));
  s.modifiedAt = nowISO();
  updateCounters();
  refreshSceneWordCount(s);
  reconcileNotes(s);            // keep note offsets valid as text shifts
  scheduleNotesRender();
  // only mark dirty if the content really differs from the last saved snapshot (Bug 2B)
  if (normalizeHTML(s.content) !== (savedContent[s.id] || '')) markDirty();
});
mdEditor.addEventListener('input', () => {
  if (isLoadingContent) return;
  const s = currentScene();
  if (!s) return;
  s.markdownContent = mdEditor.value;
  s.wordCount = countWords(mdEditor.value);
  s.modifiedAt = nowISO();
  updateCounters();
  refreshSceneWordCount(s);
  if (s.markdownContent !== (savedMd[s.id] || '')) markDirty();
});
function refreshSceneWordCount(s) {
  const el = chapterList.querySelector(`[data-scene-id="${s.id}"] .ts-words`);
  if (el) el.textContent = s.wordCount || 0;
  const c = currentChapter();
  if (c) {
    c.wordCount = chapterWordCount(c);
    const cw = chapterList.querySelector(`.tree-chapter[data-chapter-id="${c.id}"] .tc-words`);
    if (cw) cw.textContent = c.wordCount;
  }
}

function exec(cmd, val = null) {
  editor.focus();
  document.execCommand(cmd, false, val);
  markDirty();
  updateToolbarState();
}
$('#fmtBold').addEventListener('click', () => exec('bold'));
$('#fmtItalic').addEventListener('click', () => exec('italic'));
$('#styleSelect').addEventListener('change', e => {
  exec('formatBlock', e.target.value === 'P' ? 'P' : e.target.value);
});
$('#fontSelect').addEventListener('change', e => {
  // apply font to selection only
  editor.focus();
  document.execCommand('fontName', false, e.target.value);
  // execCommand fontName uses <font face>; wrap already fine visually
  markDirty();
});

function updateToolbarState() {
  if (mdMode) return;
  try {
    $('#fmtBold').classList.toggle('active', document.queryCommandState('bold'));
    $('#fmtItalic').classList.toggle('active', document.queryCommandState('italic'));
  } catch (_) {}
  // paragraph style from current block
  const block = currentBlockTag();
  const sel = $('#styleSelect');
  if (['H1', 'H2', 'H3'].includes(block)) sel.value = block;
  else sel.value = 'P';
}
function currentBlockTag() {
  const s = window.getSelection();
  if (!s.rangeCount) return 'P';
  let n = s.getRangeAt(0).startContainer;
  n = n.nodeType === 3 ? n.parentElement : n;
  while (n && n !== editor) {
    if (/^(H1|H2|H3|P)$/.test(n.tagName)) return n.tagName;
    n = n.parentElement;
  }
  return 'P';
}
document.addEventListener('selectionchange', () => {
  if (document.activeElement === editor) updateToolbarState();
});

/* markdown mode toggle */
$('#btnMarkdownMode').addEventListener('click', toggleMarkdownMode);
function toggleMarkdownMode() {
  const s = currentScene();
  if (!s) return;
  isLoadingContent = true;   // switching views is not an edit (Bug 2C)
  if (!mdMode) {
    // visual -> markdown
    s.content = editor.innerHTML;
    mdEditor.value = htmlToMd(s.content);
    s.markdownContent = mdEditor.value;
    editor.classList.add('hidden');
    mdEditor.classList.remove('hidden');
    $('#btnMarkdownMode').classList.add('active');
    mdMode = true;
  } else {
    // markdown -> visual
    s.markdownContent = mdEditor.value;
    s.content = mdToHtml(mdEditor.value);
    editor.innerHTML = s.content;
    mdEditor.classList.add('hidden');
    editor.classList.remove('hidden');
    $('#btnMarkdownMode').classList.remove('active');
    mdMode = false;
  }
  isLoadingContent = false;
  renderNotes();   // margin dots / highlights only exist in visual mode
}

/* ---------- markdown <-> html ---------- */
function mdToHtml(md) {
  const lines = (md || '').split(/\r?\n/);
  const out = lines.map(line => {
    let l = line;
    if (/^###\s+/.test(l)) return '<h3>' + inlineMd(l.replace(/^###\s+/, '')) + '</h3>';
    if (/^##\s+/.test(l)) return '<h2>' + inlineMd(l.replace(/^##\s+/, '')) + '</h2>';
    if (/^#\s+/.test(l)) return '<h1>' + inlineMd(l.replace(/^#\s+/, '')) + '</h1>';
    if (l.trim() === '') return '<p><br></p>';
    return '<p>' + inlineMd(l) + '</p>';
  });
  return out.join('');
}
function inlineMd(s) {
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  return s;
}
function htmlToMd(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  let out = [];
  const inline = node => {
    let s = '';
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) s += ch.textContent;
      else if (/^(B|STRONG)$/.test(ch.tagName)) s += '**' + inline(ch) + '**';
      else if (/^(I|EM)$/.test(ch.tagName)) s += '*' + inline(ch) + '*';
      else if (ch.tagName === 'BR') s += '\n';
      else s += inline(ch);
    });
    return s;
  };
  const walk = node => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) {
        if (ch.textContent.trim()) out.push(ch.textContent);
        return;
      }
      const t = ch.tagName;
      if (t === 'H1') out.push('# ' + inline(ch));
      else if (t === 'H2') out.push('## ' + inline(ch));
      else if (t === 'H3') out.push('### ' + inline(ch));
      else if (t === 'P' || t === 'DIV') out.push(inline(ch));
      else out.push(inline(ch));
    });
  };
  walk(d);
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ================= FONT / SIZE ================= */
function applyFontSize(px) {
  document.documentElement.style.setProperty('--fs', px + 'px');
  $('#fsVal').textContent = px;
  $('#fontSize').value = px;
  if (novel) novel.settings.fontSize = px;
}
function applyDocFont(font) {
  document.documentElement.style.setProperty('--doc-font', font);
  $('#docFontSelect').value = font;
  if (novel) novel.settings.defaultFont = font;
}
$('#fontSize').addEventListener('input', e => {
  applyFontSize(+e.target.value);
  markDirty();
});
$('#docFontSelect').addEventListener('change', e => {
  applyDocFont(e.target.value);
  markDirty();
});

/* ================= ENTITIES (chars / locations / races) ================= */
const ENTITY_DEFS = {
  characters: {
    listEl: '#charList',
    empty: () => ({ id: uuid(), name: '', role: 'main', age: '', appearance: '', personality: '', bio: '', history: '', motivation: '', relationshipNotes: '', notes: '', relationships: [], graphPosition: null, hiddenInGraph: false }),
    subtitle: e => ({ main: 'Main', supporting: 'Supporting', minor: 'Minor' }[e.role] || ''),
    fields: [
      { key: 'name', label: 'Name', type: 'input' },
      { key: 'role', label: 'Role', type: 'select', options: [['main', 'Main'], ['supporting', 'Supporting'], ['minor', 'Minor']] },
      { key: 'age', label: 'Age', type: 'input' },
      { key: 'appearance', label: 'Appearance', type: 'textarea' },
      { key: 'personality', label: 'Personality', type: 'textarea' },
      { key: 'bio', label: 'Biography', type: 'textarea' },
      { key: 'history', label: 'Personal History', type: 'textarea' },
      { key: 'motivation', label: 'Motivation', type: 'textarea' },
      { key: 'relationshipNotes', label: 'Relationships (notes)', type: 'textarea' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },
  locations: {
    listEl: '#locList',
    empty: () => ({ id: uuid(), name: '', type: 'city', description: '', history: '', atmosphere: '', notes: '' }),
    subtitle: e => ({ city: 'City', building: 'Building', natural: 'Natural', other: 'Other' }[e.type] || ''),
    fields: [
      { key: 'name', label: 'Name', type: 'input' },
      { key: 'type', label: 'Type', type: 'select', options: [['city', 'City'], ['building', 'Building'], ['natural', 'Natural'], ['other', 'Other']] },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'history', label: 'History', type: 'textarea' },
      { key: 'atmosphere', label: 'Atmosphere', type: 'textarea' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },
  races: {
    listEl: '#raceList',
    empty: () => ({ id: uuid(), name: '', description: '', appearance: '', culture: '', history: '', traits: '' }),
    subtitle: () => '',
    fields: [
      { key: 'name', label: 'Name', type: 'input' },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'appearance', label: 'Appearance', type: 'textarea' },
      { key: 'culture', label: 'Culture', type: 'textarea' },
      { key: 'history', label: 'History', type: 'textarea' },
      { key: 'traits', label: 'Special Traits', type: 'textarea' }
    ]
  }
};

function renderEntities(kind) {
  const def = ENTITY_DEFS[kind];
  const host = $(def.listEl);
  host.innerHTML = '';
  if (!novel) return;
  novel[kind].forEach(item => {
    const wrap = document.createElement('div');
    wrap.className = 'entity';
    const head = document.createElement('div');
    head.className = 'entity-head';
    head.innerHTML = `<span class="ename">${esc(item.name || '(unnamed)')}</span><span class="erole">${esc(def.subtitle(item))}</span>`;
    head.addEventListener('click', () => wrap.classList.toggle('open'));
    const body = document.createElement('div');
    body.className = 'entity-body';
    def.fields.forEach(f => {
      const lab = document.createElement('label');
      lab.className = 'field-label';
      lab.textContent = f.label;
      body.appendChild(lab);
      let ctrl;
      if (f.type === 'textarea') ctrl = document.createElement('textarea');
      else if (f.type === 'select') {
        ctrl = document.createElement('select');
        f.options.forEach(([v, t]) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          ctrl.appendChild(o);
        });
      } else {
        ctrl = document.createElement('input');
        ctrl.type = 'text';
      }
      ctrl.value = item[f.key] || '';
      ctrl.addEventListener('input', () => {
        item[f.key] = ctrl.value;
        if (f.key === 'name') head.querySelector('.ename').textContent = ctrl.value || '(unnamed)';
        if (f.key === 'role' || f.key === 'type') head.querySelector('.erole').textContent = def.subtitle(item);
        if (kind === 'characters' || kind === 'locations') updateSceneMeta();
        if (kind === 'characters' && graphOpen) drawGraph();
        markDirty();
      });
      body.appendChild(ctrl);
    });
    const del = document.createElement('button');
    del.className = 'entity-del';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      confirmModal('Delete', `Delete "${item.name || 'this entry'}"?`, () => {
        novel[kind] = novel[kind].filter(x => x.id !== item.id);
        if (kind === 'characters') {
          // scrub references to the removed character
          novel.characters.forEach(c => { c.relationships = (c.relationships || []).filter(r => r.targetCharacterId !== item.id); });
          novel.chapters.forEach(c => (c.scenes || []).forEach(s => { if (s.povCharacter === item.id) s.povCharacter = null; }));
        }
        if (kind === 'locations') novel.chapters.forEach(c => (c.scenes || []).forEach(s => { if (s.location === item.id) s.location = null; }));
        renderEntities(kind);
        updateSceneMeta();
        if (graphOpen) { renderLegend(); drawGraph(); }
        markDirty();
        toast('Deleted');
      });
    });
    body.appendChild(del);
    wrap.appendChild(head);
    wrap.appendChild(body);
    host.appendChild(wrap);
  });
  if (kind === 'characters' || kind === 'locations') updateSceneMeta();
}
function addEntity(kind) {
  if (!novel) return;
  novel[kind].push(ENTITY_DEFS[kind].empty());
  renderEntities(kind);
  markDirty();
  const host = $(ENTITY_DEFS[kind].listEl);
  host.lastElementChild.classList.add('open');
}
$('#btnAddChar').addEventListener('click', () => addEntity('characters'));
$('#btnAddLoc').addEventListener('click', () => addEntity('locations'));
$('#btnAddRace').addEventListener('click', () => addEntity('races'));

/* ================= COUNTERS ================= */
function updateCounters() {
  const goal = novel ? (novel.settings.wordGoal || 80000) : 80000;
  const c = currentChapter();
  const chapWords = c ? chapterWordCount(c) : 0;
  const total = novel ? novel.chapters.reduce((s, x) => s + chapterWordCount(x), 0) : 0;
  const txt = !novel ? '' : mdMode ? mdEditor.value : stripHtml(editor.innerHTML);
  $('#statChapWords').textContent = chapWords;
  $('#statTotalWords').textContent = total;
  $('#statChars').textContent = txt.length;
  $('#statCharsNs').textContent = txt.replace(/\s/g, '').length;
  const pct = Math.min(100, Math.round((total / goal) * 100));
  $('#progressBar').style.width = pct + '%';
  $('#goalLabel').textContent = `${pct}% of ${goal.toLocaleString()}`;
}
$('#btnGoal').addEventListener('click', () => {
  if (!novel) return;
  promptModal('Word goal', 'Target total words:', String(novel.settings.wordGoal), v => {
    const n = parseInt(v, 10);
    if (n > 0) {
      novel.settings.wordGoal = n;
      updateCounters();
      markDirty();
    }
  });
});

/* ================= ACCORDION ================= */
$$('.acc-head').forEach(h =>
  h.addEventListener('click', () => h.parentElement.classList.toggle('open'))
);

/* ================= PANEL TOGGLES ================= */
$('#toggleLeft').addEventListener('click', () => {
  $('#leftPanel').classList.toggle('collapsed');
  $('#toggleLeft').textContent = $('#leftPanel').classList.contains('collapsed') ? '▶' : '◀';
});
$('#toggleRight').addEventListener('click', () => {
  $('#rightPanel').classList.toggle('collapsed');
  $('#toggleRight').textContent = $('#rightPanel').classList.contains('collapsed') ? '◀' : '▶';
});

/* ================= FOCUS MODE ================= */
function setFocus(on) {
  focusMode = on;
  document.body.classList.toggle('focus', on);
  if (on) editor.focus();
}
$('#btnFocus').addEventListener('click', () => setFocus(!focusMode));
$('#exitFocus').addEventListener('click', () => setFocus(false));
// peek exit button when hovering top edge
document.addEventListener('mousemove', e => {
  if (focusMode) $('#exitFocus').classList.toggle('peek', e.clientY < 8);
});

/* Scene/chapter titles are edited via the breadcrumb and the tree (double-click). */

/* ================= TREE CONTEXT MENU (scene / chapter) ================= */
const ctx = $('#ctxMenu');
function hideCtx() { ctx.classList.add('hidden'); ctx.innerHTML = ''; }
function ctxItem(label, handler, cls) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', () => { hideCtx(); handler(); });
  return b;
}
chapterList.addEventListener('contextmenu', e => {
  const sceneEl = e.target.closest('.tree-scene');
  const chapRow = e.target.closest('.tc-row');
  if (!sceneEl && !chapRow) return;
  e.preventDefault();
  ctx.innerHTML = '';
  if (sceneEl) {
    const id = sceneEl.dataset.sceneId;
    ctx.appendChild(ctxItem('Rename', () => renameScene(id)));
    ctx.appendChild(ctxItem('Duplicate', () => duplicateScene(id)));
    ctx.appendChild(ctxItem('Delete', () => deleteScene(id), 'danger'));
    const others = novel.chapters.filter(c => !(c.scenes || []).some(s => s.id === id));
    if (others.length) {
      const sub = document.createElement('div');
      sub.className = 'ctx-sub';
      sub.innerHTML = '<button class="ctx-sub-head">Move to Chapter ▸</button>';
      const list = document.createElement('div');
      list.className = 'ctx-sub-menu';
      others.forEach(c => list.appendChild(ctxItem(c.title, () => moveSceneToChapter(id, c.id))));
      sub.appendChild(list);
      ctx.appendChild(sub);
    }
  } else {
    const id = chapRow.dataset.chapterId;
    ctx.appendChild(ctxItem('Rename', () => renameChapter(id)));
    ctx.appendChild(ctxItem('Duplicate', () => duplicateChapter(id)));
    ctx.appendChild(ctxItem('Add Scene', () => addScene(id)));
    ctx.appendChild(ctxItem('Delete', () => deleteChapter(id), 'danger'));
    ctx.appendChild(ctxItem('Collapse All', () => setAllCollapsed(true)));
    ctx.appendChild(ctxItem('Expand All', () => setAllCollapsed(false)));
  }
  ctx.style.left = Math.min(e.clientX, innerWidth - 190) + 'px';
  ctx.style.top = e.clientY + 'px';
  ctx.classList.remove('hidden');
});
document.addEventListener('click', hideCtx);

/* ================= MODAL ================= */
let modalCb = null;
function confirmModal(title, body, onOk) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modalInput').classList.add('hidden');
  modalCb = () => onOk();
  $('#modalOverlay').classList.remove('hidden');
}
function promptModal(title, body, value, onOk) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  const inp = $('#modalInput');
  inp.classList.remove('hidden');
  inp.value = value || '';
  modalCb = () => onOk(inp.value);
  $('#modalOverlay').classList.remove('hidden');
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
}
$('#modalOk').addEventListener('click', () => {
  $('#modalOverlay').classList.add('hidden');
  if (modalCb) modalCb();
  modalCb = null;
});
$('#modalCancel').addEventListener('click', () => {
  $('#modalOverlay').classList.add('hidden');
  modalCb = null;
});
$('#modalInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#modalOk').click();
});

/* ================= TOASTS ================= */
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toastHost').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  }, 2200);
}

/* ================= SAVE ================= */
async function doSave(saveAs = false) {
  if (!novel) { toast('No novel to save'); return false; }
  flushNovel();
  renumber();
  const content = serializeNovel(novel);
  const defaultName = (novel.title || 'novel') + '.novel';
  setSaving();
  try {
    if (hasTauri) {
      let path = currentFilePath;
      if (!path || saveAs) path = await invoke('pick_save', { defaultName });
      if (!path) { setSaved(); return false; } // user cancelled the dialog
      await invoke('write_text', { path, content });
      currentFilePath = path;
      await invoke('set_last_file', { path });
      await addRecent(path);
    } else {
      downloadFile(defaultName, content);
    }
    snapshotSaved();
    setSaved();
    updateFilePathIndicator();
    toast(saveAs ? 'Saved a copy' : 'Project saved');
    return true;
  } catch (e) {
    console.error(e);
    toast('Save failed');
    markDirty();
    return false;
  }
}
// The top-bar buttons / menu use these:
const doOpen = openNovelFile;      // "Open" == open a .novel file
const newProject = newNovelFile;   // "New"  == new .novel file

/* ================= EXPORT ================= */
function buildExport(kind, n) {
  if (!n) return '';
  if (n === novel) saveCurrentScene();
  const scenesOf = c => c.scenes || [];
  if (kind === 'txt') {
    return n.chapters.map(c =>
      c.title.toUpperCase() + '\n\n' +
      scenesOf(c).map(s => stripHtml(s.content).trim()).filter(Boolean).join('\n\n* * *\n\n')
    ).join('\n\n\n');
  }
  if (kind === 'md') {
    return n.chapters.map(c =>
      '# ' + c.title + '\n\n' +
      scenesOf(c).map(s => '## ' + s.title + '\n\n' + (s.markdownContent || htmlToMd(s.content)).trim()).join('\n\n')
    ).join('\n\n---\n\n');
  }
  if (kind === 'html') {
    const body = n.chapters
      .map(c => `<section><h1>${esc(c.title)}</h1>\n` +
        scenesOf(c).map(s => `<article><h2>${esc(s.title)}</h2>\n${s.content}</article>`).join('\n') +
        `</section>`)
      .join('\n<hr/>\n');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(n.title)}</title>
<style>body{font-family:Georgia,serif;max-width:720px;margin:40px auto;line-height:1.7;padding:0 20px;}</style>
</head><body>${body}</body></html>`;
  }
}
async function doExport(kind) {
  if (!novel) { toast('No novel to export'); return; }
  const content = buildExport(kind, novel);
  const name = (novel.title || 'novel') + '.' + kind;
  if (hasTauri) {
    const path = await invoke('pick_save', { defaultName: name });
    if (!path) return;
    await invoke('write_text', { path, content });
  } else {
    downloadFile(name, content);
  }
  toast('Exported to ' + kind.toUpperCase());
}
function downloadFile(name, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* top bar buttons */
$('#btnNew').addEventListener('click', newProject);
$('#btnOpen').addEventListener('click', doOpen);
$('#btnSave').addEventListener('click', () => doSave(false));
$('#btnSaveAs').addEventListener('click', () => doSave(true));
$('#btnExport').addEventListener('click', e => {
  e.stopPropagation();
  $('#exportMenu').classList.toggle('open');
});
document.addEventListener('click', () => $('#exportMenu').classList.remove('open'));
$('#exportMenu').addEventListener('click', e => {
  const k = e.target.dataset.export;
  if (k) doExport(k);
  const nk = e.target.dataset.exportNotes;
  if (nk) doExportNotes(nk);
});

/* ================= AUTOSAVE / RECOVERY ================= */
const LS_KEY = 'novelcraft:autosave';
function localBackup() {
  try {
    flushNovel();
    localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), path: currentFilePath, novel }));
  } catch (_) {}
}
setInterval(() => { if (dirty && novel) localBackup(); }, 10000); // every 10s while dirty

// every 30s: write to the current file if we have one, else only localStorage
setInterval(async () => {
  if (!dirty || !novel) return;
  if (hasTauri && currentFilePath) {
    try {
      flushNovel();
      renumber();
      await invoke('write_text', { path: currentFilePath, content: serializeNovel(novel) });
      snapshotSaved();
      setSaved();
      updateFilePathIndicator();
    } catch (_) { localBackup(); }
  } else {
    localBackup();   // unsaved (new) novel -> localStorage only
  }
}, 30000);

// Resolves to 'restored' (user restored), 'declined' (user pressed Cancel),
// or null (no backup to offer).
async function checkRecovery() {
  let data, payload;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    data = JSON.parse(raw);
    // support new (novel) and legacy (library) backups
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
      () => { setCurrentNovel(payload, data.path); markDirty(); toast('Recovered'); done('restored'); });
    cancel.addEventListener('click', onCancel);
  });
}

/* ================= MARGIN NOTES ================= */
const DEFAULT_NOTE_TYPES = [
  { id: 'fix',       name: 'Fix',        color: '#e6b422', icon: '🟡' },
  { id: 'factcheck', name: 'Fact-check', color: '#4a90d9', icon: '🔵' },
  { id: 'expand',    name: 'Expand',     color: '#5cb85c', icon: '🟢' },
  { id: 'move',      name: 'Move',       color: '#9b59b6', icon: '🟣' },
  { id: 'idea',      name: 'Idea',       color: '#e74c3c', icon: '🔴' }
];
const NOTE_FALLBACK_ID = 'idea';
/* Backward-compat: files that stored a Russian default-type name as the typeId. */
const RU_NOTE_NAME_TO_ID = {
  'Исправить': 'fix', 'Проверить факт': 'factcheck', 'Развить мысль': 'expand',
  'Перенести': 'move', 'Идея': 'idea'
};

/* display prefs are app-level (localStorage), colors of default types are per-novel */
let noteDisplay = { showMargin: true, highlightAnno: true, autoResolveEdit: false };
let openNoteId = null;             // id of the note whose card is open
let noteEditing = false;           // card is in edit mode
let noteResolvedFilter = 'hide';   // 'hide' | 'show' | 'only'
let noteTypeFilter = new Set();    // empty = all types
let pendingSelection = null;       // {start,end,text,rect} captured for the add popup
let notesRenderRAF = null;

const marginNotes = $('#marginNotes');
const noteCard = $('#noteCard');
const notePopup = $('#notePopup');

function getNoteTypes() {
  const overrides = (novel && novel.settings && novel.settings.noteTypeColors) || {};
  const defs = DEFAULT_NOTE_TYPES.map(t => ({ ...t, color: overrides[t.id] || t.color, isDefault: true }));
  const custom = ((novel && novel.settings && novel.settings.customNoteTypes) || [])
    .map(t => ({ ...t, isDefault: false }));
  return [...defs, ...custom];
}
function getNoteType(id) {
  const all = getNoteTypes();
  return all.find(t => t.id === id) || all.find(t => t.id === NOTE_FALLBACK_ID) || all[0];
}
function chapterNotes() { const s = currentScene(); return (s && s.notes) || []; }  // notes live on the current scene
function scheduleNotesRender() {
  if (notesRenderRAF) return;
  notesRenderRAF = requestAnimationFrame(() => { notesRenderRAF = null; renderMargin(); updateHighlights(); positionOpenCard(); });
}

/* ---- text-offset helpers (character offsets within the editor text content) ---- */
function charIndexFromPoint(root, container, offset) {
  const pre = document.createRange();
  pre.setStart(root, 0);
  try { pre.setEnd(container, offset); } catch { return 0; }
  const frag = pre.cloneContents();
  let len = 0;
  const w = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT, null);
  while (w.nextNode()) len += w.currentNode.textContent.length;
  return len;
}
function rangeFromOffsets(root, start, end) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let idx = 0, sN = null, sO = 0, eN = null, eO = 0, n;
  while ((n = w.nextNode())) {
    const len = n.textContent.length;
    if (sN === null && start <= idx + len) { sN = n; sO = start - idx; }
    if (end <= idx + len) { eN = n; eO = end - idx; break; }
    idx += len;
  }
  if (!sN || !eN) return null;
  try { const r = document.createRange(); r.setStart(sN, sO); r.setEnd(eN, eO); return r; }
  catch { return null; }
}
/* Locate annotated text after the surrounding prose has changed length. */
function findTextInContent(content, searchText, hint) {
  if (!searchText) return null;
  let idx = content.indexOf(searchText);
  if (idx === -1) return null;
  if (typeof hint === 'number') {
    let best = idx, bestD = Math.abs(idx - hint), from = idx;
    while ((from = content.indexOf(searchText, from + 1)) !== -1) {
      const d = Math.abs(from - hint);
      if (d < bestD) { bestD = d; best = from; }
    }
    idx = best;
  }
  return { start: idx, end: idx + searchText.length };
}
function reconcileNotes(c) {
  if (!c || !Array.isArray(c.notes) || !c.notes.length) return;
  const text = editor.textContent;
  c.notes.forEach(nt => {
    if (text.slice(nt.startOffset, nt.endOffset) === nt.selectedText) { nt.positionLost = false; return; }
    const f = findTextInContent(text, nt.selectedText, nt.startOffset);
    if (f) { nt.startOffset = f.start; nt.endOffset = f.end; nt.positionLost = false; }
    else {
      nt.positionLost = true;
      if (noteDisplay.autoResolveEdit && !nt.resolved) { nt.resolved = true; nt.resolveReason = 'Text modified'; }
    }
  });
}

/* ---- selection capture ---- */
function getSelectionInEditor() {
  if (mdMode) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (r.collapsed) return null;
  if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return null;
  const start = charIndexFromPoint(editor, r.startContainer, r.startOffset);
  const end = charIndexFromPoint(editor, r.endContainer, r.endOffset);
  if (end <= start) return null;
  return { start, end, text: editor.textContent.slice(start, end), rect: r.getBoundingClientRect() };
}

/* ---- date + dropdown helpers ---- */
function fmtNoteDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
  if (diff < 172800) return 'yesterday';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
function buildTypeOptions(select, selectedId) {
  select.innerHTML = '';
  getNoteTypes().forEach(ty => {
    const o = document.createElement('option');
    o.value = ty.id;
    o.textContent = (ty.icon ? ty.icon + ' ' : '') + ty.name;
    if (ty.id === selectedId) o.selected = true;
    select.appendChild(o);
  });
}
function hexToRgba(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return `rgba(201,169,110,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
/* clamp a floating element to the viewport near a client rect */
function positionFloat(el, rect) {
  el.style.visibility = 'hidden';
  el.classList.remove('hidden');
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + w > innerWidth - 10) left = innerWidth - w - 10;
  if (left < 10) left = 10;
  if (top + h > innerHeight - 10) top = Math.max(10, rect.top - h - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.visibility = '';
}

/* ================= ADD-NOTE POPUP ================= */
function openAddNote(sel) {
  const s = sel || getSelectionInEditor();
  if (!s) { toast('Select text to annotate'); return; }
  if (!novel || !currentScene()) return;
  pendingSelection = s;
  buildTypeOptions($('#npType'));
  $('#npContent').value = '';
  positionFloat(notePopup, s.rect);
  setTimeout(() => $('#npContent').focus(), 30);
}
function closeAddNote() { if (notePopup) { notePopup.classList.add('hidden'); } pendingSelection = null; }
function confirmAddNote() {
  if (!pendingSelection) return;
  const c = currentScene();
  if (!c) return;
  if (!Array.isArray(c.notes)) c.notes = [];
  c.notes.push({
    id: uuid(),
    typeId: $('#npType').value,
    content: $('#npContent').value.trim(),
    selectedText: pendingSelection.text,
    startOffset: pendingSelection.start,
    endOffset: pendingSelection.end,
    createdAt: new Date().toISOString(),
    resolved: false
  });
  closeAddNote();
  markDirty();
  renderNotes();
  toast('Note added');
}
if (notePopup) {
  $('#npAdd').addEventListener('click', confirmAddNote);
  $('#npCancel').addEventListener('click', closeAddNote);
  $('#npContent').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); confirmAddNote(); }
    if (e.key === 'Escape') { e.preventDefault(); closeAddNote(); }
  });
}

/* editor right-click -> "Add Note" */
const editorCtx = $('#editorCtx');
editor.addEventListener('contextmenu', e => {
  const s = getSelectionInEditor();
  if (!s) return;                 // no selection -> let the native menu show
  e.preventDefault();
  editorCtx._sel = s;             // capture selection now; clicking the menu may clear it
  editorCtx.style.left = e.clientX + 'px';
  editorCtx.style.top = e.clientY + 'px';
  editorCtx.classList.remove('hidden');
});
document.addEventListener('click', () => editorCtx.classList.add('hidden'));
editorCtx.addEventListener('click', e => {
  if (e.target.dataset.ectx === 'addnote') openAddNote(editorCtx._sel);
});

/* ================= NOTE FILTERING ================= */
function filteredNotes() {
  let notes = chapterNotes().slice();
  if (noteTypeFilter.size) notes = notes.filter(n => noteTypeFilter.has(n.typeId));
  if (noteResolvedFilter === 'hide') notes = notes.filter(n => !n.resolved);
  else if (noteResolvedFilter === 'only') notes = notes.filter(n => n.resolved);
  notes.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  return notes;
}

/* ================= MARGIN DOTS ================= */
function renderMargin() {
  if (!marginNotes) return;
  marginNotes.innerHTML = '';
  if (mdMode || !noteDisplay.showMargin || !novel) { marginNotes.classList.add('hidden'); return; }
  marginNotes.classList.remove('hidden');
  const wrap = $('#editorWrap');
  const wrapTop = wrap.getBoundingClientRect().top;
  const placed = [];
  filteredNotes().forEach(nt => {
    const r = rangeFromOffsets(editor, nt.startOffset, nt.endOffset);
    if (!r) return;
    const rect = r.getBoundingClientRect();
    let top = rect.top - wrapTop + 4;
    while (placed.some(p => Math.abs(p - top) < 12)) top += 12;   // stack overlapping dots
    placed.push(top);
    const ty = getNoteType(nt.typeId);
    const dot = document.createElement('button');
    dot.className = 'note-dot' + (nt.resolved ? ' resolved' : '') + (nt.positionLost ? ' lost' : '') + (nt.id === openNoteId ? ' current' : '');
    dot.style.setProperty('--dot', ty.color);
    dot.style.top = top + 'px';
    dot.addEventListener('click', ev => { ev.stopPropagation(); openNoteCard(nt.id); });
    dot.addEventListener('mouseenter', () => showDotTooltip(dot, nt));
    dot.addEventListener('mouseleave', hideDotTooltip);
    marginNotes.appendChild(dot);
  });
}
let dotTip = null;
function showDotTooltip(dot, nt) {
  hideDotTooltip();
  const ty = getNoteType(nt.typeId);
  dotTip = document.createElement('div');
  dotTip.className = 'note-tip';
  dotTip.innerHTML = `<b style="color:${ty.color}">${ty.icon || ''} ${esc(ty.name)}</b>` +
    `<div class="nt-content">${esc((nt.content || '(no text)').slice(0, 50))}</div>` +
    `<div class="nt-date">${fmtNoteDate(nt.createdAt)}</div>`;
  document.body.appendChild(dotTip);
  const r = dot.getBoundingClientRect();
  dotTip.style.top = r.top + 'px';
  dotTip.style.left = (r.left - dotTip.offsetWidth - 10) + 'px';
}
function hideDotTooltip() { if (dotTip) { dotTip.remove(); dotTip = null; } }

/* ================= ANNOTATED-TEXT HIGHLIGHTING (CSS Custom Highlight API) ================= */
function cssHlName(id) { return 'note-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '_'); }
function ensureHighlightStyles() {
  let st = document.getElementById('noteHiliteStyles');
  if (!st) { st = document.createElement('style'); st.id = 'noteHiliteStyles'; document.head.appendChild(st); }
  st.textContent = getNoteTypes().map(ty =>
    `::highlight(${cssHlName(ty.id)}){text-decoration:underline;text-decoration-color:${ty.color};text-decoration-thickness:2px;text-underline-offset:3px;}`
  ).join('\n');
}
function updateActiveHighlightStyle(color) {
  let st = document.getElementById('noteActiveStyle');
  if (!st) { st = document.createElement('style'); st.id = 'noteActiveStyle'; document.head.appendChild(st); }
  st.textContent = color ? `::highlight(note-active){background-color:${hexToRgba(color, 0.22)};}` : '';
}
function updateHighlights() {
  if (!('highlights' in CSS) || typeof Highlight === 'undefined') return;
  CSS.highlights.clear();
  const c = currentChapter();
  if (mdMode || !noteDisplay.highlightAnno || !novel || !c) { updateActiveHighlightStyle(null); return; }
  const byType = {};
  let activeRange = null, activeColor = null;
  filteredNotes().forEach(nt => {
    const r = rangeFromOffsets(editor, nt.startOffset, nt.endOffset);
    if (!r) return;
    (byType[nt.typeId] = byType[nt.typeId] || []).push(r);
    if (nt.id === openNoteId) { activeRange = r; activeColor = getNoteType(nt.typeId).color; }
  });
  Object.entries(byType).forEach(([tid, ranges]) => { try { CSS.highlights.set(cssHlName(tid), new Highlight(...ranges)); } catch (_) {} });
  if (activeRange) { try { CSS.highlights.set('note-active', new Highlight(activeRange)); } catch (_) {} }
  updateActiveHighlightStyle(activeColor);
}

/* ================= EXPANDED NOTE CARD ================= */
function openNoteCard(id, scroll = true) {
  const c = currentScene();
  const nt = c && (c.notes || []).find(n => n.id === id);
  if (!nt) return;
  openNoteId = id;
  noteEditing = false;
  if (scroll && !mdMode) {
    const r = rangeFromOffsets(editor, nt.startOffset, nt.endOffset);
    if (r) {
      const rect = r.getBoundingClientRect();
      const sc = $('.editor-scroll');
      const target = sc.scrollTop + (rect.top - sc.getBoundingClientRect().top) - sc.clientHeight / 2;
      sc.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      setTimeout(() => { renderNoteCard(); renderMargin(); }, 260);
    }
  }
  renderNoteCard();
  renderMargin();
  updateHighlights();
}
function closeNoteCard() {
  openNoteId = null; noteEditing = false;
  if (noteCard) noteCard.classList.add('hidden');
  renderMargin();
  updateHighlights();
}
/* click outside the open card (and not on a dot / list entry) closes it */
document.addEventListener('mousedown', e => {
  if (!openNoteId) return;
  if (e.target.closest('#noteCard') || e.target.closest('.note-dot') ||
      e.target.closest('.note-lcard') || e.target.closest('.modal-overlay')) return;
  closeNoteCard();
});
function renderNoteCard() {
  if (!noteCard) return;
  const c = currentScene();
  const nt = openNoteId && c && (c.notes || []).find(n => n.id === openNoteId);
  if (!nt) { noteCard.classList.add('hidden'); return; }
  const ty = getNoteType(nt.typeId);
  noteCard.classList.remove('hidden');
  noteCard.classList.toggle('resolved', !!nt.resolved);
  if (noteEditing) {
    noteCard.innerHTML =
      `<div class="nc-arrow"></div>
       <div class="nc-head"><select id="ncType" class="control"></select></div>
       <textarea id="ncEditBody" class="control nc-editbody" rows="4"></textarea>
       <div class="nc-actions">
         <button id="ncCancelEdit" class="tbtn subtle">Cancel</button>
         <button id="ncSaveEdit" class="tbtn accent">Save</button>
       </div>`;
    buildTypeOptions($('#ncType'), nt.typeId);
    $('#ncEditBody').value = nt.content || '';
    $('#ncSaveEdit').onclick = () => {
      nt.typeId = $('#ncType').value;
      nt.content = $('#ncEditBody').value.trim();
      noteEditing = false; markDirty(); renderNoteCard(); renderNotes();
      toast('Note updated');
    };
    $('#ncCancelEdit').onclick = () => { noteEditing = false; renderNoteCard(); };
    setTimeout(() => $('#ncEditBody').focus(), 20);
  } else {
    noteCard.innerHTML =
      `<div class="nc-arrow"></div>
       <div class="nc-head">
         <span class="note-badge" style="--nc:${ty.color}">${ty.icon || '•'} ${esc(ty.name)}</span>
         ${nt.positionLost ? '<span class="nc-warn" title="Position may be inaccurate">⚠️</span>' : ''}
       </div>
       <div class="nc-quote">“${esc(nt.selectedText || '')}”</div>
       <div class="nc-body">${(esc(nt.content || '').replace(/\n/g, '<br>')) || '<span class="nc-empty">(no text)</span>'}</div>
       <div class="nc-time">${fmtNoteDate(nt.createdAt)}${nt.resolved ? ' · ✓ resolved' : ''}</div>
       <div class="nc-actions">
         <button id="ncResolve" class="tbtn">${nt.resolved ? 'Unresolve' : '✓ Resolve'}</button>
         <button id="ncEdit" class="tbtn">✎ Edit</button>
         <button id="ncDelete" class="tbtn nc-danger">🗑 Delete</button>
       </div>`;
    $('#ncResolve').onclick = () => toggleResolve(nt.id);
    $('#ncEdit').onclick = () => { noteEditing = true; renderNoteCard(); };
    $('#ncDelete').onclick = () => deleteNote(nt.id);
  }
  positionOpenCard();
}
function positionOpenCard() {
  if (!noteCard || noteCard.classList.contains('hidden') || !openNoteId) return;
  const c = currentScene();
  const nt = c && (c.notes || []).find(n => n.id === openNoteId);
  if (!nt) return;
  let rect;
  if (!mdMode) {
    const r = rangeFromOffsets(editor, nt.startOffset, nt.endOffset);
    if (r) rect = r.getBoundingClientRect();
  }
  if (!rect) { const er = editor.getBoundingClientRect(); rect = { top: er.top + 60, bottom: er.top + 60, left: er.left + 40, right: er.right - 40 }; }
  const w = noteCard.offsetWidth, h = noteCard.offsetHeight;
  let left = rect.right + 14;
  if (left + w > innerWidth - 10) left = rect.left - w - 14;
  if (left < 10) left = Math.max(10, innerWidth - w - 10);
  let top = rect.top - 6;
  if (top + h > innerHeight - 10) top = Math.max(10, innerHeight - h - 10);
  if (top < 48) top = 48;
  noteCard.style.left = left + 'px';
  noteCard.style.top = top + 'px';
}
function toggleResolve(id) {
  const c = currentScene();
  const nt = c && (c.notes || []).find(n => n.id === id);
  if (!nt) return;
  nt.resolved = !nt.resolved;
  if (!nt.resolved) delete nt.resolveReason;
  markDirty(); renderNoteCard(); renderNotes();
  toast(nt.resolved ? 'Note resolved' : 'Note reopened');
}
function deleteNote(id) {
  confirmModal('Delete note', 'Delete this note? This cannot be undone.', () => {
    const c = currentScene();
    if (!c) return;
    c.notes = (c.notes || []).filter(n => n.id !== id);
    if (openNoteId === id) closeNoteCard();
    markDirty(); renderNotes();
    toast('Note deleted');
  });
}

/* ================= NOTES PANEL (right sidebar) ================= */
function renderFilterPills() {
  const host = $('#noteFilters');
  if (!host) return;
  host.innerHTML = '';
  const notes = chapterNotes();
  const all = document.createElement('button');
  all.className = 'filter-pill all' + (noteTypeFilter.size === 0 ? ' active' : '');
  all.textContent = `All (${notes.length})`;
  all.onclick = () => { noteTypeFilter.clear(); renderNotes(); };
  host.appendChild(all);
  getNoteTypes().forEach(ty => {
    const count = notes.filter(n => n.typeId === ty.id).length;
    const b = document.createElement('button');
    b.className = 'filter-pill' + (noteTypeFilter.has(ty.id) ? ' active' : '');
    b.style.setProperty('--pc', ty.color);
    b.innerHTML = `${ty.icon || '•'} ${esc(ty.name)} (${count})`;
    b.onclick = () => { if (noteTypeFilter.has(ty.id)) noteTypeFilter.delete(ty.id); else noteTypeFilter.add(ty.id); renderNotes(); };
    host.appendChild(b);
  });
}
function renderNotesPanel() {
  const host = $('#noteList');
  if (!host) return;
  host.innerHTML = '';
  if (!novel) return;
  const notes = filteredNotes();
  if (!notes.length) {
    host.innerHTML = '<div class="note-empty"><div class="ne-icon">📝</div><p>No notes in this chapter</p></div>';
    return;
  }
  notes.forEach(nt => {
    const ty = getNoteType(nt.typeId);
    const card = document.createElement('div');
    card.className = 'note-lcard' + (nt.resolved ? ' resolved' : '') + (nt.id === openNoteId ? ' current' : '');
    card.style.setProperty('--nc', ty.color);
    card.innerHTML =
      `<div class="nl-strip"></div>
       <div class="nl-main">
         <div class="nl-top">
           <span class="nl-type">${ty.icon || '•'} ${esc(ty.name)}</span>
           ${nt.positionLost ? '<span class="nl-warn" title="Position may be inaccurate">⚠️</span>' : ''}
           ${nt.resolved ? '<span class="nl-check">✓</span>' : ''}
         </div>
         <div class="nl-quote">“${esc((nt.selectedText || '').slice(0, 40))}${(nt.selectedText || '').length > 40 ? '…' : ''}”</div>
         <div class="nl-body">${esc((nt.content || '').slice(0, 80))}${(nt.content || '').length > 80 ? '…' : ''}</div>
         <div class="nl-time">${fmtNoteDate(nt.createdAt)}</div>
       </div>`;
    card.onclick = () => openNoteCard(nt.id);
    host.appendChild(card);
  });
}
function renderNotes() {
  renderFilterPills();
  renderNotesPanel();
  renderMargin();
  updateHighlights();
  positionOpenCard();
}
const noteResolvedSel = $('#noteResolvedFilter');
if (noteResolvedSel) noteResolvedSel.addEventListener('change', e => { noteResolvedFilter = e.target.value; renderNotes(); });

/* ================= NOTE-TYPE SETTINGS ================= */
function setNoteTypeColor(ty, color) {
  if (!novel) return;
  if (ty.isDefault) { novel.settings.noteTypeColors[ty.id] = color; }
  else {
    const t = novel.settings.customNoteTypes.find(x => x.id === ty.id);
    if (t) t.color = color;
  }
  markDirty();
  ensureHighlightStyles();
  renderNoteTypeSettings();
  renderNotes();
}
function deleteCustomType(ty) {
  confirmModal('Delete type', `Delete the “${ty.name}” type? Its notes will become “Idea”.`, () => {
    novel.settings.customNoteTypes = novel.settings.customNoteTypes.filter(t => t.id !== ty.id);
    novel.chapters.forEach(c => (c.scenes || []).forEach(s => (s.notes || []).forEach(n => { if (n.typeId === ty.id) n.typeId = NOTE_FALLBACK_ID; })));
    noteTypeFilter.delete(ty.id);
    markDirty();
    ensureHighlightStyles();
    renderNoteTypeSettings();
    renderNotes();
    toast('Type deleted');
  });
}
function renderNoteTypeSettings() {
  const host = $('#noteTypeList');
  if (!host) return;
  host.innerHTML = '';
  if (!novel) { host.innerHTML = '<div class="empty-msg">Open a novel</div>'; return; }
  getNoteTypes().forEach(ty => {
    const row = document.createElement('div');
    row.className = 'nt-row';
    row.innerHTML =
      `<input type="color" class="nt-color" value="${ty.color}" title="Color">
       <span class="nt-icon">${ty.icon || '•'}</span>
       <span class="nt-name">${esc(ty.name)}</span>
       ${ty.isDefault
        ? '<span class="nt-lock" title="Default type — recolour only">🔒</span>'
        : '<button class="nt-btn nt-edit" title="Edit">✎</button><button class="nt-btn nt-del" title="Delete">🗑</button>'}`;
    row.querySelector('.nt-color').onchange = e => setNoteTypeColor(ty, e.target.value);
    if (!ty.isDefault) {
      row.querySelector('.nt-edit').onclick = () => showCustomTypeForm(ty, row);
      row.querySelector('.nt-del').onclick = () => deleteCustomType(ty);
    }
    host.appendChild(row);
  });
}
function showCustomTypeForm(existing, anchorRow) {
  const host = $('#noteTypeList');
  if (!host) return;
  const form = document.createElement('div');
  form.className = 'nt-form';
  const color = existing ? existing.color : '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  form.innerHTML =
    `<input type="text" class="control ntf-name" placeholder="Name" value="${existing ? esc(existing.name) : ''}">
     <div class="ntf-row">
       <input type="color" class="ntf-color" value="${color}" title="Color">
       <input type="text" class="control ntf-icon" maxlength="2" placeholder="Icon" value="${existing ? esc(existing.icon || '') : ''}">
     </div>
     <div class="ntf-actions">
       <button class="tbtn subtle ntf-cancel">Cancel</button>
       <button class="tbtn accent ntf-save">Save</button>
     </div>`;
  const cleanup = () => { renderNoteTypeSettings(); };
  form.querySelector('.ntf-cancel').onclick = cleanup;
  form.querySelector('.ntf-save').onclick = () => {
    const name = form.querySelector('.ntf-name').value.trim();
    if (!name) { toast('Enter a name'); return; }
    const col = form.querySelector('.ntf-color').value;
    const icon = form.querySelector('.ntf-icon').value.trim();
    if (existing) {
      const t = novel.settings.customNoteTypes.find(x => x.id === existing.id);
      if (t) { t.name = name; t.color = col; t.icon = icon; }
    } else {
      novel.settings.customNoteTypes.push({ id: uuid(), name, color: col, icon });
    }
    markDirty();
    ensureHighlightStyles();
    renderNoteTypeSettings();
    renderNotes();
    toast(existing ? 'Custom type updated' : 'Custom type created');
  };
  if (anchorRow && anchorRow.nextSibling) host.insertBefore(form, anchorRow.nextSibling);
  else host.appendChild(form);
  form.querySelector('.ntf-name').focus();
}
const btnAddNoteType = $('#btnAddNoteType');
if (btnAddNoteType) btnAddNoteType.addEventListener('click', () => showCustomTypeForm(null, null));

/* ================= NOTE-DISPLAY TOGGLES ================= */
function applyNoteDisplay() {
  const nd = (loadPrefs().noteDisplay) || {};
  noteDisplay.showMargin = nd.showMargin !== false;
  noteDisplay.highlightAnno = nd.highlightAnno !== false;
  noteDisplay.autoResolveEdit = !!nd.autoResolveEdit;
  if ($('#showMargin')) $('#showMargin').checked = noteDisplay.showMargin;
  if ($('#highlightAnno')) $('#highlightAnno').checked = noteDisplay.highlightAnno;
  if ($('#autoResolveEdit')) $('#autoResolveEdit').checked = noteDisplay.autoResolveEdit;
}
function saveNoteDisplay() {
  const p = loadPrefs();
  p.noteDisplay = { ...noteDisplay };
  savePrefs(p);
}
['showMargin', 'highlightAnno', 'autoResolveEdit'].forEach(key => {
  const el = $('#' + key);
  if (!el) return;
  el.addEventListener('change', e => {
    noteDisplay[key] = e.target.checked;
    saveNoteDisplay();
    renderNotes();
  });
});

/* ================= EXPORT NOTES ================= */
function buildNotesExport(kind) {
  const lines = [];
  novel.chapters.forEach(c => {
    (c.scenes || []).forEach(sc => {
      const notes = (sc.notes || []).slice().sort((a, b) => a.startOffset - b.startOffset);
      if (!notes.length) return;
      const heading = `${c.title} › ${sc.title}`;
      if (kind === 'md') {
        lines.push(`## ${heading}`, '');
        notes.forEach(n => {
          const ty = getNoteType(n.typeId);
          lines.push(`- **[${ty.name}]** “${n.selectedText}” — ${n.content || ''} _(${fmtNoteDate(n.createdAt)})_${n.resolved ? ' ✓' : ''}`);
        });
        lines.push('');
      } else {
        lines.push(`NOTES FOR: ${heading}`, '─'.repeat(42));
        notes.forEach(n => {
          const ty = getNoteType(n.typeId);
          lines.push(`[${ty.name}] “${n.selectedText}” — ${n.content || ''} (${fmtNoteDate(n.createdAt)})${n.resolved ? ' ✓' : ''}`);
        });
        lines.push('');
      }
    });
  });
  if (!lines.length) return kind === 'md' ? '# Notes\n\n_(no notes)_' : 'NOTES\n\n(no notes)';
  return (kind === 'md' ? '# Notes\n\n' : '') + lines.join('\n');
}
async function doExportNotes(kind) {
  if (!novel) { toast('No novel open'); return; }
  flushNovel();
  const content = buildNotesExport(kind);
  const name = (novel.title || 'novel') + '-notes.' + kind;
  if (hasTauri) {
    const path = await invoke('pick_save', { defaultName: name });
    if (!path) return;
    await invoke('write_text', { path, content });
  } else {
    downloadFile(name, content);
  }
  toast('Notes exported (' + kind.toUpperCase() + ')');
}

/* reposition floating notes UI when the layout shifts */
addEventListener('resize', scheduleNotesRender);
$('.editor-scroll').addEventListener('scroll', () => { positionOpenCard(); hideDotTooltip(); if (notePopup && !notePopup.classList.contains('hidden')) closeAddNote(); });

/* ================= CORKBOARD ================= */
let corkboardOpen = false;
let corkZoomLevel = 1;          // 0 = small, 1 = medium, 2 = large
let corkFilterStatus = 'all';
let corkFilterPov = '';
let corkSort = 'order';
let corkDrag = null;
let suppressCorkClick = false;

function charName(id) { const c = novel && novel.characters.find(x => x.id === id); return c ? (c.name || '(unnamed)') : ''; }
function locName(id) { const l = novel && novel.locations.find(x => x.id === id); return l ? (l.name || '(unnamed)') : ''; }
function hashStr(s) { let h = 0; for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

function openCorkboard() {
  if (!novel) return;
  saveCurrentScene();
  corkboardOpen = true;
  document.body.classList.add('corkboard-mode');
  $('#corkboard').classList.remove('hidden');
  $('#btnCorkboard').classList.add('active');
  fillSelect($('#corkPov'), [['', 'All POV'], ...novel.characters.map(c => [c.id, c.name || '(unnamed)'])], corkFilterPov);
  renderCorkboard();
}
function closeCorkboard() {
  corkboardOpen = false;
  document.body.classList.remove('corkboard-mode');
  $('#corkboard').classList.add('hidden');
  $('#btnCorkboard').classList.remove('active');
}
function toggleCorkboard() { corkboardOpen ? closeCorkboard() : openCorkboard(); }

function scenePasses(s) {
  if (corkFilterStatus !== 'all' && s.status !== corkFilterStatus) return false;
  if (corkFilterPov && s.povCharacter !== corkFilterPov) return false;
  return true;
}
function sortScenes(scenes) {
  const arr = scenes.slice();
  if (corkSort === 'title') arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else if (corkSort === 'words') arr.sort((a, b) => (b.wordCount || 0) - (a.wordCount || 0));
  else if (corkSort === 'status') arr.sort((a, b) => SCENE_STATUS.findIndex(x => x[0] === a.status) - SCENE_STATUS.findIndex(x => x[0] === b.status));
  else if (corkSort === 'time') arr.sort((a, b) => TIME_OF_DAY.findIndex(x => x[0] === a.timeOfDay) - TIME_OF_DAY.findIndex(x => x[0] === b.timeOfDay));
  return arr;
}
function renderCorkboard() {
  const grid = $('#corkGrid');
  if (!grid || !novel) return;
  grid.className = 'cork-grid zoom-' + corkZoomLevel;
  grid.innerHTML = '';
  novel.chapters.forEach(c => {
    const group = document.createElement('div');
    group.className = 'cork-group';
    group.dataset.chapterId = c.id;
    group.innerHTML = `<div class="cork-chap">📁 ${esc(c.title)} <span class="cork-count">${(c.scenes || []).length} scenes</span></div>`;
    const cards = document.createElement('div');
    cards.className = 'cork-cards';
    sortScenes((c.scenes || []).filter(scenePasses)).forEach(s => cards.appendChild(buildSceneCard(s, c)));
    const ghost = document.createElement('div');
    ghost.className = 'cork-card cork-ghost';
    ghost.dataset.chapterId = c.id;
    ghost.innerHTML = '<div class="cg-plus">＋</div><div>Add scene</div>';
    ghost.onclick = () => { if (addScene(c.id)) renderCorkboard(); };
    cards.appendChild(ghost);
    group.appendChild(cards);
    grid.appendChild(group);
  });
}
function buildSceneCard(s, c) {
  const st = statusMeta(s.status), tm = timeMeta(s.timeOfDay);
  const card = document.createElement('div');
  card.className = 'cork-card' + (s.id === currentSceneId ? ' current' : '');
  card.dataset.sceneId = s.id;
  card.dataset.chapterId = c.id;
  card.style.setProperty('--sc', st[2]);
  card.style.setProperty('--rot', (((hashStr(s.id) % 20) / 10) - 1).toFixed(2) + 'deg');
  const pov = s.povCharacter ? `<div class="cc-meta">👤 ${esc(charName(s.povCharacter))}</div>` : '';
  const loc = s.location ? `<div class="cc-meta">📍 ${esc(locName(s.location))}</div>` : '';
  card.innerHTML =
    `<div class="cc-badge" title="Click to cycle status"><span class="cc-dot"></span>${st[1]}</div>
     <div class="cc-title">${esc(s.title)}</div>
     <div class="cc-divider"></div>
     ${pov}${loc}
     <div class="cc-meta">${tm[2]} ${tm[1]}</div>
     <div class="cc-foot"><span>${s.wordCount || 0} words</span><span class="cc-date">${fmtNoteDate(s.modifiedAt || s.createdAt)}</span></div>
     <div class="cc-actions"><button class="cc-edit" title="Open in editor">Edit</button><button class="cc-del" title="Delete scene">Delete</button></div>`;
  let clickTimer = null;
  card.querySelector('.cc-badge').onclick = e => { e.stopPropagation(); cycleStatus(s); };
  card.querySelector('.cc-edit').onclick = e => { e.stopPropagation(); selectScene(s.id); closeCorkboard(); };
  card.querySelector('.cc-del').onclick = e => { e.stopPropagation(); deleteScene(s.id); setTimeout(renderCorkboard, 60); };
  card.querySelector('.cc-title').ondblclick = e => { e.stopPropagation(); if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } renameScene(s.id); setTimeout(renderCorkboard, 60); };
  card.onclick = e => {
    if (suppressCorkClick) return;
    if (e.target.closest('.cc-actions') || e.target.closest('.cc-badge')) return;
    if (clickTimer) return;
    clickTimer = setTimeout(() => { clickTimer = null; selectScene(s.id); closeCorkboard(); }, 230);
  };
  return card;
}
function cycleStatus(s) {
  const i = SCENE_STATUS.findIndex(x => x[0] === s.status);
  s.status = SCENE_STATUS[(i + 1) % SCENE_STATUS.length][0];
  markDirty(); renderCorkboard(); renderTree(); updateSceneMeta();
}
/* corkboard card drag (pointer-based; reorder within a chapter, move between chapters) */
$('#corkGrid').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const card = e.target.closest('.cork-card:not(.cork-ghost)');
  if (!card || e.target.closest('.cc-actions') || e.target.closest('.cc-badge')) return;
  corkDrag = { id: card.dataset.sceneId, el: card, startX: e.clientX, startY: e.clientY, started: false, target: null };
});
document.addEventListener('mousemove', e => {
  if (!corkDrag) return;
  if (!corkDrag.started) {
    if (Math.abs(e.clientX - corkDrag.startX) < 6 && Math.abs(e.clientY - corkDrag.startY) < 6) return;
    corkDrag.started = true;
    corkDrag.el.classList.add('cork-dragging');
  }
  e.preventDefault();
  $$('.cork-card').forEach(x => x.classList.remove('cork-drop'));
  $$('.cork-group').forEach(x => x.classList.remove('cork-group-drop'));
  corkDrag.target = null;
  const over = $$('.cork-card:not(.cork-ghost)').find(x => { if (x === corkDrag.el) return false; const r = x.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; });
  if (over) { over.classList.add('cork-drop'); const r = over.getBoundingClientRect(); corkDrag.target = { kind: 'card', id: over.dataset.sceneId, after: e.clientX > r.left + r.width / 2 }; }
  else { const grp = $$('.cork-group').find(x => { const r = x.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; }); if (grp) { grp.classList.add('cork-group-drop'); corkDrag.target = { kind: 'group', id: grp.dataset.chapterId }; } }
});
document.addEventListener('mouseup', () => {
  if (!corkDrag) return;
  const d = corkDrag; corkDrag = null;
  $$('.cork-card').forEach(x => x.classList.remove('cork-drop', 'cork-dragging'));
  $$('.cork-group').forEach(x => x.classList.remove('cork-group-drop'));
  if (!d.started || !d.target) return;
  applyCorkDrop(d.id, d.target);
  suppressCorkClick = true;
  setTimeout(() => (suppressCorkClick = false), 60);
});
function applyCorkDrop(sceneId, target) {
  const f = findScene(sceneId);
  if (!f) return;
  const from = f.chapter;
  if (target.kind === 'card') {
    const g = findScene(target.id);
    if (!g || target.id === sceneId) return;
    if (g.chapter.id !== from.id && from.scenes.length === 1) { toast('A chapter must keep at least one scene'); return; }
    const idx = from.scenes.findIndex(s => s.id === sceneId);
    const [moved] = from.scenes.splice(idx, 1);
    let di = g.chapter.scenes.findIndex(s => s.id === target.id);
    if (target.after) di += 1;
    g.chapter.scenes.splice(di, 0, moved);
  } else {
    const dest = findChapter(target.id);
    if (!dest || dest.id === from.id) return;
    if (from.scenes.length === 1) { toast('A chapter must keep at least one scene'); return; }
    const idx = from.scenes.findIndex(s => s.id === sceneId);
    const [moved] = from.scenes.splice(idx, 1);
    dest.scenes.push(moved);
  }
  markDirty(); renderCorkboard(); renderTree();
}
/* corkboard toolbar wiring */
$('#btnCorkboard').addEventListener('click', toggleCorkboard);
$('#corkBack').addEventListener('click', closeCorkboard);
$('#corkZoom').addEventListener('input', e => { corkZoomLevel = +e.target.value; renderCorkboard(); });
$('#corkStatus').addEventListener('change', e => { corkFilterStatus = e.target.value; renderCorkboard(); });
$('#corkPov').addEventListener('change', e => { corkFilterPov = e.target.value; renderCorkboard(); });
$('#corkSort').addEventListener('change', e => { corkSort = e.target.value; renderCorkboard(); });

/* ================= CHARACTER RELATIONSHIP GRAPH ================= */
const REL_TYPES = [
  ['family', 'Family', '#e74c3c'], ['friend', 'Friend', '#2ecc71'], ['enemy', 'Enemy', '#e67e22'],
  ['romance', 'Romance', '#e91e63'], ['colleague', 'Colleague', '#3498db'], ['mentor', 'Mentor', '#9b59b6'],
  ['rival', 'Rival', '#d35400'], ['custom', 'Custom', '#c9a96e']
];
const REL_STATUS = [['active', 'Active'], ['past', 'Past'], ['secret', 'Secret'], ['oneSided', 'One-sided']];
function relColor(t) { const r = REL_TYPES.find(x => x[0] === t); return r ? r[2] : '#c9a96e'; }
function relTypeName(t) { const r = REL_TYPES.find(x => x[0] === t); return r ? r[1] : 'Custom'; }

let graphOpen = false;
let gEventsInit = false;
let gCanvas = null, gCtx = null;
let gView = { x: 0, y: 0, zoom: 1 };
let gDragNode = null, gPanning = false, gLast = null, gMoved = false;
let gSelected = null, gHoverEdge = null, gFilter = 'all';
let gPanelRel = null;   // relationship being edited in the panel

function nodeRadius(ch) { return ch.role === 'main' ? 30 : ch.role === 'supporting' ? 25 : 21; }
function roleBadge(ch) { return ch.role === 'main' ? '★' : ch.role === 'supporting' ? '◆' : '●'; }
function graphChars() {
  if (!novel) return [];
  let chars = novel.characters.filter(c => !c.hiddenInGraph);
  if (gFilter === 'main') chars = chars.filter(c => c.role === 'main');
  else if (gFilter === 'withrel') chars = chars.filter(c => (c.relationships || []).length || novel.characters.some(o => (o.relationships || []).some(r => r.targetCharacterId === c.id)));
  else if (gFilter === 'withoutrel') chars = chars.filter(c => !((c.relationships || []).length || novel.characters.some(o => (o.relationships || []).some(r => r.targetCharacterId === c.id))));
  return chars;
}
function graphEdges(chars) {
  const ids = new Set(chars.map(c => c.id));
  const edges = [];
  chars.forEach(src => (src.relationships || []).forEach(r => {
    if (r.targetCharacterId && ids.has(r.targetCharacterId)) {
      const tgt = novel.characters.find(c => c.id === r.targetCharacterId);
      if (tgt) edges.push({ src, tgt, rel: r });
    }
  }));
  return edges;
}
function ensureGraphPositions() {
  const chars = novel.characters;
  const n = chars.length;
  chars.forEach((c, i) => {
    if (!c.graphPosition || typeof c.graphPosition.x !== 'number') {
      const ang = (i / Math.max(1, n)) * Math.PI * 2;
      c.graphPosition = { x: Math.cos(ang) * 220 + (Math.random() * 40 - 20), y: Math.sin(ang) * 220 + (Math.random() * 40 - 20) };
    }
  });
}
function w2s(x, y) { return { x: x * gView.zoom + gView.x, y: y * gView.zoom + gView.y }; }
function s2w(x, y) { return { x: (x - gView.x) / gView.zoom, y: (y - gView.y) / gView.zoom }; }

function openGraph() {
  if (!novel) return;
  graphOpen = true;
  $('#graphOverlay').classList.remove('hidden');
  gCanvas = $('#graphCanvas');
  gCtx = gCanvas.getContext('2d');
  if (!gEventsInit) { initGraphEvents(); gEventsInit = true; }
  ensureGraphPositions();
  fillSelect($('#graphFilter'), [['all', 'Show All'], ['main', 'Main Characters Only'], ['withrel', 'With Relationships'], ['withoutrel', 'Without Relationships']], gFilter);
  renderLegend();
  gSelected = null; gPanelRel = null;
  $('#graphPanel').classList.add('hidden');
  requestAnimationFrame(() => { gResize(); gCenterView(); });
}
function closeGraph() {
  graphOpen = false;
  $('#graphOverlay').classList.add('hidden');
  markDirty();   // positions may have changed
}
function gCenterView() {
  const chars = graphChars();
  if (!chars.length) { gView = { x: gCanvas.clientWidth / 2, y: gCanvas.clientHeight / 2, zoom: 1 }; drawGraph(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  chars.forEach(c => { minX = Math.min(minX, c.graphPosition.x); minY = Math.min(minY, c.graphPosition.y); maxX = Math.max(maxX, c.graphPosition.x); maxY = Math.max(maxY, c.graphPosition.y); });
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  gView.zoom = 1;
  gView.x = gCanvas.clientWidth / 2 - cx * gView.zoom;
  gView.y = gCanvas.clientHeight / 2 - cy * gView.zoom;
  drawGraph();
}
function gResize() {
  if (!gCanvas) return;
  const stage = $('.graph-stage');
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  gCanvas.width = r.width * dpr;
  gCanvas.height = r.height * dpr;
  gCanvas.style.width = r.width + 'px';
  gCanvas.style.height = r.height + 'px';
  gCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawGraph();
}
function drawGraph() {
  if (!gCtx) return;
  const W = gCanvas.clientWidth, H = gCanvas.clientHeight;
  gCtx.clearRect(0, 0, W, H);
  gCtx.fillStyle = '#1a1a1f';
  gCtx.fillRect(0, 0, W, H);
  drawGrid(W, H);
  const chars = graphChars();
  const edges = graphEdges(chars);
  const connected = new Set();
  if (gSelected) { edges.forEach(e => { if (e.src.id === gSelected || e.tgt.id === gSelected) { connected.add(e.src.id); connected.add(e.tgt.id); } }); connected.add(gSelected); }
  edges.forEach(e => drawEdge(e, connected));
  chars.forEach(ch => drawNode(ch, connected));
}
function drawGrid(W, H) {
  const step = 50 * gView.zoom;
  if (step < 12) return;
  const ox = gView.x % step, oy = gView.y % step;
  gCtx.fillStyle = '#2a2a35';
  for (let x = ox; x < W; x += step) for (let y = oy; y < H; y += step) { gCtx.beginPath(); gCtx.arc(x, y, 1, 0, Math.PI * 2); gCtx.fill(); }
}
function edgeDash(rel) {
  if (rel.status === 'past') return [8, 6];
  if (rel.status === 'secret') return [2, 5];
  if (rel.strength <= 3) return [5, 4];
  return [];
}
function drawEdge(e, connected) {
  const a = w2s(e.src.graphPosition.x, e.src.graphPosition.y);
  const b = w2s(e.tgt.graphPosition.x, e.tgt.graphPosition.y);
  const faded = gSelected && !(connected.has(e.src.id) && connected.has(e.tgt.id));
  const hovered = gHoverEdge && gHoverEdge.rel.id === e.rel.id;
  let width = e.rel.strength >= 9 ? 4 : e.rel.strength >= 7 ? 3 : e.rel.strength >= 4 ? 2 : 1;
  gCtx.save();
  gCtx.globalAlpha = faded ? 0.1 : hovered ? 1 : 0.75;
  gCtx.strokeStyle = e.rel.type === 'custom' && e.rel.color ? e.rel.color : relColor(e.rel.type);
  gCtx.lineWidth = (width + (hovered ? 1 : 0)) * gView.zoom;
  gCtx.setLineDash(edgeDash(e.rel).map(v => v * gView.zoom));
  if (e.rel.strength >= 9 && !faded) { gCtx.shadowColor = gCtx.strokeStyle; gCtx.shadowBlur = 8; }
  const rt = nodeRadius(e.tgt) * gView.zoom;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const ex = b.x - Math.cos(ang) * rt, ey = b.y - Math.sin(ang) * rt;
  gCtx.beginPath(); gCtx.moveTo(a.x, a.y); gCtx.lineTo(ex, ey); gCtx.stroke();
  gCtx.setLineDash([]);
  if (e.rel.status === 'oneSided' && !faded) { drawArrow(ex, ey, ang, gCtx.strokeStyle); }
  // label
  if (!faded && (hovered || gView.zoom > 0.6) && e.rel.subtype) {
    gCtx.globalAlpha = hovered ? 1 : 0.5;
    gCtx.fillStyle = '#e8e0d5';
    gCtx.font = (11 * Math.min(1.4, gView.zoom)) + 'px Inter, sans-serif';
    gCtx.textAlign = 'center';
    gCtx.fillText(e.rel.subtype, (a.x + b.x) / 2, (a.y + b.y) / 2 - 4);
  }
  gCtx.restore();
}
function drawArrow(x, y, ang, color) {
  const s = 9 * gView.zoom;
  gCtx.save(); gCtx.fillStyle = color; gCtx.translate(x, y); gCtx.rotate(ang);
  gCtx.beginPath(); gCtx.moveTo(0, 0); gCtx.lineTo(-s, -s * 0.5); gCtx.lineTo(-s, s * 0.5); gCtx.closePath(); gCtx.fill();
  gCtx.restore();
}
function drawNode(ch, connected) {
  const p = w2s(ch.graphPosition.x, ch.graphPosition.y);
  const r = nodeRadius(ch) * gView.zoom;
  const faded = gSelected && !connected.has(ch.id);
  const isSel = gSelected === ch.id;
  gCtx.save();
  gCtx.globalAlpha = faded ? 0.3 : 1;
  if (isSel) { gCtx.shadowColor = '#c9a96e'; gCtx.shadowBlur = 18; }
  gCtx.beginPath(); gCtx.arc(p.x, p.y, r * (isSel ? 1.12 : 1), 0, Math.PI * 2);
  gCtx.fillStyle = ch.color || '#c9a96e';
  gCtx.fill();
  gCtx.lineWidth = 2; gCtx.strokeStyle = isSel ? '#f0e2c8' : 'rgba(255,255,255,.5)'; gCtx.stroke();
  gCtx.shadowBlur = 0;
  // role badge
  gCtx.fillStyle = '#1a1a1f'; gCtx.font = (13 * gView.zoom) + 'px sans-serif'; gCtx.textAlign = 'center'; gCtx.textBaseline = 'middle';
  gCtx.fillText(roleBadge(ch), p.x, p.y);
  // name label
  gCtx.globalAlpha = faded ? 0.3 : 1;
  gCtx.fillStyle = '#ffffff'; gCtx.font = '14px Inter, sans-serif'; gCtx.textBaseline = 'top';
  gCtx.fillText(ch.name || '(unnamed)', p.x, p.y + r + 4);
  gCtx.restore();
}
function nodeAt(sx, sy) {
  const chars = graphChars();
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]; const p = w2s(ch.graphPosition.x, ch.graphPosition.y);
    if (Math.hypot(sx - p.x, sy - p.y) <= nodeRadius(ch) * gView.zoom + 2) return ch;
  }
  return null;
}
function edgeAt(sx, sy) {
  const chars = graphChars();
  const edges = graphEdges(chars);
  for (const e of edges) {
    const a = w2s(e.src.graphPosition.x, e.src.graphPosition.y);
    const b = w2s(e.tgt.graphPosition.x, e.tgt.graphPosition.y);
    if (distToSeg(sx, sy, a.x, a.y, b.x, b.y) < 6) return e;
  }
  return null;
}
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* ---- graph interactions ---- */
function graphMouse(e) { const r = gCanvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function initGraphEvents() {
  gCanvas.addEventListener('mousedown', e => {
    const m = graphMouse(e);
    const node = nodeAt(m.x, m.y);
    gMoved = false;
    if (node) { gDragNode = node; gLast = m; }
    else { gPanning = true; gLast = m; }
  });
  window.addEventListener('mousemove', e => {
    if (!graphOpen) return;
    if (gDragNode) {
      const m = graphMouse(e); gMoved = true;
      gDragNode.graphPosition.x += (m.x - gLast.x) / gView.zoom;
      gDragNode.graphPosition.y += (m.y - gLast.y) / gView.zoom;
      gLast = m; drawGraph();
    } else if (gPanning) {
      const m = graphMouse(e); gMoved = true;
      gView.x += m.x - gLast.x; gView.y += m.y - gLast.y; gLast = m; drawGraph();
    } else {
      const m = graphMouse(e); const eg = edgeAt(m.x, m.y);
      if ((eg && (!gHoverEdge || eg.rel.id !== gHoverEdge.rel.id)) || (!eg && gHoverEdge)) { gHoverEdge = eg; drawGraph(); }
      gCanvas.style.cursor = nodeAt(m.x, m.y) ? 'grab' : eg ? 'pointer' : 'default';
    }
  });
  window.addEventListener('mouseup', e => {
    if (!graphOpen) return;
    if (gDragNode) { if (gMoved) markDirty(); else onNodeClick(gDragNode); gDragNode = null; }
    else if (gPanning) { gPanning = false; if (!gMoved) onCanvasClick(e); }
  });
  gCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const m = graphMouse(e);
    const before = s2w(m.x, m.y);
    gView.zoom = Math.max(0.25, Math.min(3, gView.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    const after = w2s(before.x, before.y);
    gView.x += m.x - after.x; gView.y += m.y - after.y;
    drawGraph();
  }, { passive: false });
  gCanvas.addEventListener('dblclick', e => { const m = graphMouse(e); const node = nodeAt(m.x, m.y); if (node) openCharPanel(node); });
  gCanvas.addEventListener('contextmenu', e => {
    const m = graphMouse(e); const node = nodeAt(m.x, m.y);
    if (!node) return;
    e.preventDefault();
    ctx.innerHTML = '';
    ctx.appendChild(ctxItem('Edit Character', () => openCharPanel(node)));
    ctx.appendChild(ctxItem('Add Relationship', () => openRelPanel(null, node.id)));
    ctx.appendChild(ctxItem('Hide from Graph', () => { node.hiddenInGraph = true; markDirty(); drawGraph(); }));
    ctx.style.left = Math.min(e.clientX, innerWidth - 190) + 'px';
    ctx.style.top = e.clientY + 'px';
    ctx.classList.remove('hidden');
  });
}
function onNodeClick(node) { gSelected = gSelected === node.id ? null : node.id; gHoverEdge = null; drawGraph(); }
function onCanvasClick(e) {
  const m = graphMouse(e);
  const eg = edgeAt(m.x, m.y);
  if (eg) { openRelPanel(eg.rel, eg.src.id, eg.tgt.id); return; }
  gSelected = null; $('#graphPanel').classList.add('hidden'); drawGraph();
}

/* ---- relationship + character panels ---- */
function openRelPanel(rel, aId, bId) {
  const panel = $('#graphPanel');
  gPanelRel = rel;
  const a = novel.characters.find(c => c.id === (rel ? findRelSource(rel).id : aId));
  const b = novel.characters.find(c => c.id === (rel ? rel.targetCharacterId : bId));
  const charOpts = novel.characters.map(c => [c.id, c.name || '(unnamed)']);
  const dots = n => '●'.repeat(n) + '○'.repeat(10 - n);
  panel.classList.remove('hidden');
  panel.innerHTML =
    `<div class="gp-head">${rel ? 'Edit Relationship' : 'Add Relationship'}<button class="gp-x" id="gpClose">✕</button></div>
     <label class="field-label">Character A</label>
     <select id="relA" class="control" ${rel ? 'disabled' : ''}></select>
     <label class="field-label">Character B</label>
     <select id="relB" class="control" ${rel ? 'disabled' : ''}></select>
     <label class="field-label">Relationship type</label>
     <select id="relType" class="control"></select>
     <label class="field-label">Subtype</label>
     <input type="text" id="relSubtype" class="control" placeholder="e.g. father, best friend" />
     <label class="field-label">Description</label>
     <textarea id="relDesc" class="control" rows="2"></textarea>
     <label class="field-label">Strength: <span id="relStrengthDots">${dots(rel ? rel.strength : 5)}</span></label>
     <input type="range" id="relStrength" class="slider" min="1" max="10" value="${rel ? rel.strength : 5}" />
     <label class="field-label">Status</label>
     <select id="relStatus" class="control"></select>
     <label class="field-label">First appears in</label>
     <input type="text" id="relStart" class="control" placeholder="e.g. Chapter 3, Scene 2" />
     <label class="field-label">Notes</label>
     <textarea id="relNotes" class="control" rows="2"></textarea>
     <div class="gp-actions">
       ${rel ? '<button class="tbtn nc-danger" id="relDelete">Delete</button>' : ''}
       <button class="tbtn subtle" id="relCancel">Cancel</button>
       <button class="tbtn accent" id="relSave">Save</button>
     </div>`;
  fillSelect($('#relA'), charOpts, a ? a.id : (aId || (charOpts[0] && charOpts[0][0])));
  fillSelect($('#relB'), charOpts, b ? b.id : (bId || (charOpts[1] && charOpts[1][0])));
  fillSelect($('#relType'), REL_TYPES.map(t => [t[0], t[1]]), rel ? rel.type : 'friend');
  fillSelect($('#relStatus'), REL_STATUS, rel ? rel.status : 'active');
  $('#relSubtype').value = rel ? (rel.subtype || '') : '';
  $('#relDesc').value = rel ? (rel.description || '') : '';
  $('#relStart').value = rel ? (rel.startedAt || '') : '';
  $('#relNotes').value = rel ? (rel.notes || '') : '';
  $('#relStrength').addEventListener('input', e => { $('#relStrengthDots').textContent = dots(+e.target.value); });
  $('#gpClose').onclick = () => panel.classList.add('hidden');
  $('#relCancel').onclick = () => panel.classList.add('hidden');
  $('#relSave').onclick = () => saveRelFromPanel(rel);
  if (rel) $('#relDelete').onclick = () => deleteRel(rel);
}
function findRelSource(rel) { return novel.characters.find(c => (c.relationships || []).some(r => r.id === rel.id)); }
function saveRelFromPanel(rel) {
  const aId = $('#relA').value, bId = $('#relB').value;
  if (aId === bId) { toast('Pick two different characters'); return; }
  const data = {
    targetCharacterId: bId,
    type: $('#relType').value,
    subtype: $('#relSubtype').value.trim(),
    description: $('#relDesc').value.trim(),
    strength: +$('#relStrength').value,
    status: $('#relStatus').value,
    startedAt: $('#relStart').value.trim(),
    notes: $('#relNotes').value.trim()
  };
  if (rel) {
    const src = findRelSource(rel);
    Object.assign(rel, data);
    if (src && src.id !== aId) {   // source changed: move relationship
      src.relationships = src.relationships.filter(r => r.id !== rel.id);
      const na = novel.characters.find(c => c.id === aId);
      na.relationships = na.relationships || []; na.relationships.push(rel);
    }
    toast('Relationship updated');
  } else {
    const a = novel.characters.find(c => c.id === aId);
    a.relationships = a.relationships || [];
    a.relationships.push({ id: uuid(), ...data });
    toast('Relationship added');
  }
  markDirty();
  $('#graphPanel').classList.add('hidden');
  renderEntities('characters');
  drawGraph();
}
function deleteRel(rel) {
  confirmModal('Delete relationship', 'Delete this relationship?', () => {
    const src = findRelSource(rel);
    if (src) src.relationships = src.relationships.filter(r => r.id !== rel.id);
    markDirty(); $('#graphPanel').classList.add('hidden'); renderEntities('characters'); drawGraph();
    toast('Relationship deleted');
  });
}
function openCharPanel(ch) {
  const panel = $('#graphPanel');
  panel.classList.remove('hidden');
  const rels = (ch.relationships || []).map(r => {
    const t = novel.characters.find(c => c.id === r.targetCharacterId);
    return `<li><span class="gp-reldot" style="background:${relColor(r.type)}"></span>${esc(r.subtype || relTypeName(r.type))} → ${esc(t ? (t.name || '(unnamed)') : '?')}</li>`;
  }).join('') || '<li class="gp-empty">No relationships yet</li>';
  panel.innerHTML =
    `<div class="gp-head">Character<button class="gp-x" id="gpClose">✕</button></div>
     <label class="field-label">Name</label>
     <input type="text" id="gcName" class="control" value="${esc(ch.name || '')}" />
     <label class="field-label">Role</label>
     <select id="gcRole" class="control"></select>
     <label class="field-label">Node colour</label>
     <input type="color" id="gcColor" class="nt-color" value="${ch.color || '#c9a96e'}" />
     <div class="gp-rels"><div class="field-label">Relationships</div><ul>${rels}</ul></div>
     <div class="gp-actions">
       <button class="tbtn" id="gcAddRel">Add Relationship</button>
       <button class="tbtn subtle" id="gcProfile">View Full Profile</button>
       <button class="tbtn accent" id="gcSave">Save</button>
     </div>`;
  fillSelect($('#gcRole'), [['main', 'Main'], ['supporting', 'Supporting'], ['minor', 'Minor']], ch.role || 'main');
  $('#gpClose').onclick = () => panel.classList.add('hidden');
  $('#gcColor').oninput = e => { ch.color = e.target.value; markDirty(); drawGraph(); };
  $('#gcAddRel').onclick = () => openRelPanel(null, ch.id);
  $('#gcProfile').onclick = () => { closeGraph(); openCharacterInPanel(ch.id); };
  $('#gcSave').onclick = () => {
    ch.name = $('#gcName').value.trim() || ch.name;
    ch.role = $('#gcRole').value;
    markDirty(); renderEntities('characters'); drawGraph();
    panel.classList.add('hidden');
    toast('Character updated');
  };
}
function openCharacterInPanel(id) {
  const acc = $('.accordion[data-acc="chars"]');
  if (acc) acc.classList.add('open');
  const wrap = $$('#charList .entity')[novel.characters.findIndex(c => c.id === id)];
  if (wrap) { wrap.classList.add('open'); wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

/* ---- graph layouts ---- */
function circularLayout() {
  const chars = graphChars(); const n = chars.length; const R = 60 + n * 26;
  chars.forEach((c, i) => { const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2; c.graphPosition = { x: Math.cos(a) * R, y: Math.sin(a) * R }; });
  markDirty(); animateTo();
}
function forceLayout() {
  const chars = graphChars();
  if (!chars.length) return;
  const pos = {}; chars.forEach(c => (pos[c.id] = { x: c.graphPosition.x, y: c.graphPosition.y }));
  const edges = graphEdges(chars);
  let repulsion = 90000;
  const ideal = 160, attract = 0.02;
  for (let iter = 0; iter < 120; iter++) {
    for (let i = 0; i < chars.length; i++) for (let j = i + 1; j < chars.length; j++) {
      const A = pos[chars[i].id], B = pos[chars[j].id];
      let dx = A.x - B.x, dy = A.y - B.y; let dist = Math.max(Math.hypot(dx, dy), 1);
      const f = repulsion / (dist * dist);
      A.x += (dx / dist) * f; A.y += (dy / dist) * f; B.x -= (dx / dist) * f; B.y -= (dy / dist) * f;
    }
    edges.forEach(e => {
      const A = pos[e.src.id], B = pos[e.tgt.id]; if (!A || !B) return;
      let dx = B.x - A.x, dy = B.y - A.y; let dist = Math.max(Math.hypot(dx, dy), 1);
      const f = (dist - ideal) * attract * (e.rel.strength / 5);
      A.x += (dx / dist) * f * 0.5; A.y += (dy / dist) * f * 0.5; B.x -= (dx / dist) * f * 0.5; B.y -= (dy / dist) * f * 0.5;
    });
    repulsion *= 0.99;
  }
  chars.forEach(c => (c._target = pos[c.id]));
  markDirty(); animateTo();
}
function animateTo() {
  const chars = graphChars();
  const start = {}; chars.forEach(c => (start[c.id] = { x: c.graphPosition.x, y: c.graphPosition.y }));
  const target = {}; chars.forEach(c => (target[c.id] = c._target || { x: c.graphPosition.x, y: c.graphPosition.y }));
  const t0 = performance.now(); const dur = 900;
  function step(now) {
    const k = Math.min(1, (now - t0) / dur); const e = 1 - Math.pow(1 - k, 3);
    chars.forEach(c => { c.graphPosition.x = start[c.id].x + (target[c.id].x - start[c.id].x) * e; c.graphPosition.y = start[c.id].y + (target[c.id].y - start[c.id].y) * e; });
    drawGraph();
    if (k < 1 && graphOpen) requestAnimationFrame(step);
    else { chars.forEach(c => delete c._target); gCenterView(); }
  }
  requestAnimationFrame(step);
}

/* ---- legend ---- */
function renderLegend() {
  const body = $('#legendBody');
  body.innerHTML = REL_TYPES.map(t => `<div class="lg-row"><span class="lg-line" style="background:${t[2]}"></span>${t[1]}</div>`).join('');
}

/* ---- export PNG ---- */
function exportGraphPng() {
  if (!gCanvas) return;
  const url = gCanvas.toDataURL('image/png');
  const name = (novel.title || 'novel') + '-graph.png';
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  toast('Graph exported (' + name + ')');
}

/* ---- graph toolbar wiring ---- */
$('#btnGraphView').addEventListener('click', openGraph);
$('#graphClose').addEventListener('click', closeGraph);
$('#graphOverlay').addEventListener('mousedown', e => { if (e.target === $('#graphOverlay')) closeGraph(); });
$('#graphAddChar').addEventListener('click', () => {
  promptModal('Add character', 'Character name:', '', name => {
    if (!name) return;
    const c = ENTITY_DEFS.characters.empty(); c.name = name;
    c.graphPosition = { x: Math.random() * 200 - 100, y: Math.random() * 200 - 100 };
    novel.characters.push(c);
    markDirty(); renderEntities('characters'); renderLegend(); drawGraph();
    toast('Character added');
  });
});
$('#graphAddRel').addEventListener('click', () => { if (novel.characters.length < 2) { toast('Add at least two characters first'); return; } openRelPanel(null, novel.characters[0].id, novel.characters[1].id); });
$('#graphLayout').addEventListener('change', e => {
  if (e.target.value === 'auto') forceLayout();
  else if (e.target.value === 'circular') circularLayout();
  e.target.value = 'manual';
});
$('#graphFilter').addEventListener('change', e => { gFilter = e.target.value; gSelected = null; drawGraph(); });
$('#graphExport').addEventListener('click', exportGraphPng);
$('#graphReset').addEventListener('click', () => { novel.characters.forEach(c => (c.graphPosition = null)); ensureGraphPositions(); forceLayout(); });
$('#legendToggle').addEventListener('click', () => { const b = $('#legendBody'); const hidden = b.classList.toggle('collapsed'); $('#legendToggle').textContent = 'Legend ' + (hidden ? '▴' : '▾'); });
addEventListener('resize', () => { if (graphOpen) gResize(); });

/* ================= WORLD MAP ================= */
const LOC_TYPE_COLOR = { city: '#4a90d9', building: '#c9a96e', natural: '#5cb85c', other: '#8f887c' };
function locColor(l) { return LOC_TYPE_COLOR[l.type] || '#8f887c'; }

let mapOpen = false, mapEventsInit = false;
let mCanvas = null, mCtx = null;
let mView = { x: 0, y: 0, zoom: 1 };
let mImg = null;
let mDragPin = null, mPanning = false, mLast = null, mMoved = false;
let mActiveLayerId = '';           // '' = pin/pan mode; else a custom layer id -> drawing mode
let mDrawTool = 'pen', mDrawColor = '#c9a96e';
let mDrawing = null;               // in-progress drawing object
let mLocSearch = '';
let mRouteMode = null;             // { fromId } while placing a route (see routes section)

function worldMap() { return novel && novel.settings && novel.settings.worldMap; }
function mapImageSize() {
  const wm = worldMap();
  if (mImg && mImg.complete && mImg.naturalWidth) return { w: mImg.naturalWidth, h: mImg.naturalHeight };
  if (wm && wm.imageW) return { w: wm.imageW, h: wm.imageH };
  return { w: 1200, h: 800 };      // virtual canvas when no image is uploaded
}
function mw2s(x, y) { return { x: x * mView.zoom + mView.x, y: y * mView.zoom + mView.y }; }
function ms2w(x, y) { return { x: (x - mView.x) / mView.zoom, y: (y - mView.y) / mView.zoom }; }
function locRel(l) { const wm = worldMap(); return wm.locations[l.id] || null; }
function locWorld(l) { const sz = mapImageSize(); const p = locRel(l); const rx = p ? p.x : 0.5, ry = p ? p.y : 0.5; return { x: rx * sz.w, y: ry * sz.h }; }
function placedLocs() { const wm = worldMap(); return novel.locations.filter(l => wm.locations[l.id]); }
function pinScreenR() { return Math.max(9, Math.min(20, 13 * mView.zoom)); }

function openMap() {
  if (!novel) return;
  mapOpen = true;
  $('#mapOverlay').classList.remove('hidden');
  mCanvas = $('#mapCanvas');
  mCtx = mCanvas.getContext('2d');
  if (!mapEventsInit) { initMapEvents(); mapEventsInit = true; }
  mActiveLayerId = '';
  loadMapImage();
  renderMapLocList();
  renderMapLayers();
  renderMapLayerSelect();
  updateDrawToolsVisibility();
  hideMapDetails();
  cancelRouteMode();
  requestAnimationFrame(() => { mapResize(); mapFit(); });
}
function closeMap() {
  mapOpen = false;
  cancelRouteMode();
  $('#mapOverlay').classList.add('hidden');
  markDirty();   // pin positions / drawings may have changed
}
function loadMapImage() {
  const wm = worldMap();
  if (wm.backgroundImage) {
    mImg = new Image();
    mImg.onload = () => { wm.imageW = mImg.naturalWidth; wm.imageH = mImg.naturalHeight; mapDraw(); };
    mImg.src = wm.backgroundImage;
  } else { mImg = null; }
}
function mapResize() {
  if (!mCanvas) return;
  const stage = $('.map-stage');
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  mCanvas.width = r.width * dpr;
  mCanvas.height = r.height * dpr;
  mCanvas.style.width = r.width + 'px';
  mCanvas.style.height = r.height + 'px';
  mCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mapDraw();
}
function updateMapZoom() { const el = $('#mapZoomLabel'); if (el) el.textContent = Math.round(mView.zoom * 100) + '%'; }
function mapFit() {
  const sz = mapImageSize();
  const W = mCanvas.clientWidth, H = mCanvas.clientHeight;
  const pad = 40;
  const z = Math.min((W - pad) / sz.w, (H - pad) / sz.h);
  mView.zoom = Math.max(0.05, Math.min(4, z));
  mView.x = (W - sz.w * mView.zoom) / 2;
  mView.y = (H - sz.h * mView.zoom) / 2;
  updateMapZoom(); mapDraw();
}
function mapOriginal() {
  const sz = mapImageSize();
  const W = mCanvas.clientWidth, H = mCanvas.clientHeight;
  mView.zoom = 1;
  mView.x = (W - sz.w) / 2;
  mView.y = (H - sz.h) / 2;
  updateMapZoom(); mapDraw();
}
function mapZoomBy(factor) {
  const W = mCanvas.clientWidth / 2, H = mCanvas.clientHeight / 2;
  const before = ms2w(W, H);
  mView.zoom = Math.max(0.05, Math.min(6, mView.zoom * factor));
  const after = mw2s(before.x, before.y);
  mView.x += W - after.x; mView.y += H - after.y;
  updateMapZoom(); mapDraw();
}

/* ---- drawing the map ---- */
function mapDraw() {
  if (!mCtx) return;
  const W = mCanvas.clientWidth, H = mCanvas.clientHeight;
  const wm = worldMap();
  mCtx.clearRect(0, 0, W, H);
  mCtx.fillStyle = '#15151a';
  mCtx.fillRect(0, 0, W, H);
  const sz = mapImageSize();
  const tl = mw2s(0, 0);
  if (mImg && mImg.complete && mImg.naturalWidth && wm.baseLayers.background) {
    mCtx.drawImage(mImg, tl.x, tl.y, sz.w * mView.zoom, sz.h * mView.zoom);
  } else {
    mCtx.strokeStyle = '#33333f'; mCtx.setLineDash([7, 7]);
    mCtx.strokeRect(tl.x, tl.y, sz.w * mView.zoom, sz.h * mView.zoom);
    mCtx.setLineDash([]);
    if (!mImg) {
      mCtx.fillStyle = '#4a4a58'; mCtx.font = '13px Inter, sans-serif'; mCtx.textAlign = 'center';
      mCtx.fillText('No map image — click “Upload Map Image” to add one', tl.x + sz.w * mView.zoom / 2, tl.y + sz.h * mView.zoom / 2);
    }
  }
  wm.layers.forEach(l => { if (l.visible) drawLayer(l); });
  if (mDrawing) drawOneDrawing(mDrawing, 1);
  if (wm.baseLayers.routes) drawRoutes();
  if (wm.baseLayers.locations) drawPins();
}
function drawPins() {
  const wm = worldMap();
  const showLabels = wm.baseLayers.labels;
  placedLocs().forEach(l => {
    const p = mw2s(...Object.values(locWorld(l)));
    const r = pinScreenR();
    const cy = p.y - r * 1.5;
    mCtx.save();
    mCtx.fillStyle = locColor(l);
    mCtx.strokeStyle = 'rgba(0,0,0,.45)'; mCtx.lineWidth = 1.5;
    mCtx.beginPath();
    mCtx.arc(p.x, cy, r, Math.PI * 0.15, Math.PI * 0.85, true);   // top circle
    mCtx.lineTo(p.x, p.y);                                         // pointer tip
    mCtx.closePath();
    mCtx.fill(); mCtx.stroke();
    mCtx.beginPath(); mCtx.arc(p.x, cy, r * 0.42, 0, Math.PI * 2);
    mCtx.fillStyle = 'rgba(0,0,0,.35)'; mCtx.fill();
    if (showLabels) {
      const name = l.name || '(unnamed)';
      mCtx.font = '600 12px Inter, sans-serif'; mCtx.textAlign = 'center'; mCtx.textBaseline = 'top';
      const tw = mCtx.measureText(name).width;
      mCtx.fillStyle = 'rgba(20,20,26,.75)';
      mCtx.fillRect(p.x - tw / 2 - 4, p.y + 3, tw + 8, 16);
      mCtx.fillStyle = '#e8e0d5';
      mCtx.fillText(name, p.x, p.y + 5);
    }
    mCtx.restore();
  });
}
function pinAt(sx, sy) {
  const locs = placedLocs();
  for (let i = locs.length - 1; i >= 0; i--) {
    const l = locs[i];
    const p = mw2s(...Object.values(locWorld(l)));
    const r = pinScreenR();
    const cy = p.y - r * 1.5;
    if (Math.hypot(sx - p.x, sy - cy) <= r + 2 || (sy <= p.y && sy >= cy && Math.abs(sx - p.x) <= r)) return l;
  }
  return null;
}
function drawLayer(l) {
  mCtx.save();
  mCtx.globalAlpha = typeof l.opacity === 'number' ? l.opacity : 1;
  (l.drawings || []).forEach(d => drawOneDrawing(d, 1));
  mCtx.restore();
}
function drawOneDrawing(d, alpha) {
  mCtx.save();
  mCtx.globalAlpha *= alpha;
  mCtx.strokeStyle = d.color || '#c9a96e';
  mCtx.fillStyle = d.color || '#c9a96e';
  mCtx.lineWidth = Math.max(1, (d.width || 2) * mView.zoom);
  mCtx.lineJoin = 'round'; mCtx.lineCap = 'round';
  const P = (pt) => mw2s(pt.x, pt.y);
  if (d.tool === 'pen' && d.points && d.points.length) {
    mCtx.beginPath();
    d.points.forEach((pt, i) => { const s = P(pt); i ? mCtx.lineTo(s.x, s.y) : mCtx.moveTo(s.x, s.y); });
    mCtx.stroke();
  } else if (d.tool === 'line' && d.points && d.points.length >= 2) {
    const a = P(d.points[0]), b = P(d.points[1]);
    mCtx.beginPath(); mCtx.moveTo(a.x, a.y); mCtx.lineTo(b.x, b.y); mCtx.stroke();
  } else if (d.tool === 'rect' && d.points && d.points.length >= 2) {
    const a = P(d.points[0]), b = P(d.points[1]);
    mCtx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else if (d.tool === 'circle' && d.points && d.points.length >= 2) {
    const a = P(d.points[0]), b = P(d.points[1]);
    mCtx.beginPath(); mCtx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2); mCtx.stroke();
  } else if (d.tool === 'text' && d.points && d.points.length) {
    const s = P(d.points[0]);
    mCtx.font = '600 ' + Math.max(10, 16 * mView.zoom) + 'px Inter, sans-serif';
    mCtx.textAlign = 'left'; mCtx.textBaseline = 'middle';
    mCtx.fillText(d.text || '', s.x, s.y);
  }
  mCtx.restore();
}

/* ---- image upload ---- */
async function uploadMapImage() {
  const wm = worldMap();
  const apply = dataUrl => {
    wm.backgroundImage = dataUrl;
    loadMapImage();
    markDirty();
    setTimeout(() => mapFit(), 60);
    toast('Map image set');
  };
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg';
  inp.onchange = () => {
    const f = inp.files[0];
    if (!f) return;
    if (f.size > 12 * 1024 * 1024) { toast('Image is too large (max 12 MB)'); return; }
    const rd = new FileReader();
    rd.onload = () => apply(rd.result);
    rd.readAsDataURL(f);
  };
  inp.click();
}

/* ---- left panel: locations ---- */
function renderMapLocList() {
  const host = $('#mapLocList');
  if (!host || !novel) return;
  host.innerHTML = '';
  const wm = worldMap();
  const q = mLocSearch.trim().toLowerCase();
  const locs = novel.locations.filter(l => !q || (l.name || '').toLowerCase().includes(q));
  if (!novel.locations.length) { host.innerHTML = '<div class="map-empty">No locations yet. Add some in the Locations panel.</div>'; return; }
  if (!locs.length) { host.innerHTML = '<div class="map-empty">No matches.</div>'; return; }
  locs.forEach(l => {
    const placed = !!wm.locations[l.id];
    const row = document.createElement('div');
    row.className = 'map-loc-row' + (placed ? ' placed' : '');
    row.innerHTML =
      `<span class="mlr-dot" style="background:${locColor(l)}"></span>
       <span class="mlr-name">${esc(l.name || '(unnamed)')}</span>
       ${placed ? '<span class="mlr-pin" title="On map">📍</span>'
                : '<button class="mlr-place" title="Place on map">Place</button>'}`;
    if (placed) {
      row.querySelector('.mlr-name').onclick = () => { centerOnLoc(l); showLocDetails(l); };
      row.querySelector('.mlr-pin').onclick = () => { centerOnLoc(l); showLocDetails(l); };
    } else {
      row.querySelector('.mlr-place').onclick = () => placeLocation(l.id);
    }
    host.appendChild(row);
  });
}
function centerOnLoc(l) {
  const w = locWorld(l);
  const W = mCanvas.clientWidth / 2, H = mCanvas.clientHeight / 2;
  mView.x = W - w.x * mView.zoom; mView.y = H - w.y * mView.zoom;
  mapDraw();
}
function placeLocation(id, rel) {
  const wm = worldMap();
  if (!rel) {
    // drop at the current view centre (in relative image coords)
    const sz = mapImageSize();
    const c = ms2w(mCanvas.clientWidth / 2, mCanvas.clientHeight / 2);
    rel = { x: Math.max(0, Math.min(1, c.x / sz.w)), y: Math.max(0, Math.min(1, c.y / sz.h)) };
  }
  wm.locations[id] = { x: rel.x, y: rel.y, visible: true };
  markDirty(); renderMapLocList(); mapDraw();
}
function placeAllUnplaced() {
  const wm = worldMap();
  const unplaced = novel.locations.filter(l => !wm.locations[l.id]);
  if (!unplaced.length) { toast('All locations are already placed'); return; }
  const cols = Math.ceil(Math.sqrt(unplaced.length));
  unplaced.forEach((l, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const rows = Math.ceil(unplaced.length / cols);
    wm.locations[l.id] = { x: (c + 1) / (cols + 1), y: (r + 1) / (rows + 1), visible: true };
  });
  markDirty(); renderMapLocList(); mapDraw();
  toast('Placed ' + unplaced.length + ' location' + (unplaced.length > 1 ? 's' : ''));
}
function removePin(id) {
  const wm = worldMap();
  delete wm.locations[id];
  wm.routes = wm.routes.filter(r => r.fromLocationId !== id && r.toLocationId !== id);
  markDirty(); renderMapLocList(); mapDraw(); hideMapDetails();
  toast('Removed from map');
}

/* ---- location details card ---- */
function showLocDetails(l) {
  const el = $('#mapDetails');
  const desc = (l.description || '').trim();
  el.innerHTML =
    `<div class="md-head"><span class="md-dot" style="background:${locColor(l)}"></span>
       <span class="md-name">${esc(l.name || '(unnamed)')}</span>
       <button class="md-x" title="Close">✕</button></div>
     <div class="md-type">${esc(({ city: 'City', building: 'Building', natural: 'Natural', other: 'Other' }[l.type]) || 'Location')}</div>
     ${desc ? `<div class="md-desc">${esc(desc.slice(0, 220))}${desc.length > 220 ? '…' : ''}</div>` : ''}
     <div class="md-actions">
       <button class="tbtn" id="mdEdit">Edit in Locations</button>
       <button class="tbtn" id="mdRoute">Add Route</button>
       <button class="tbtn nc-danger" id="mdRemove">Remove Pin</button>
     </div>`;
  const p = mw2s(...Object.values(locWorld(l)));
  el.classList.remove('hidden');
  const stage = $('.map-stage').getBoundingClientRect();
  let left = p.x + 16, top = p.y - 10;
  if (left + el.offsetWidth > stage.width - 8) left = p.x - el.offsetWidth - 16;
  if (left < 8) left = 8;
  if (top + el.offsetHeight > stage.height - 8) top = Math.max(8, stage.height - el.offsetHeight - 8);
  el.style.left = left + 'px'; el.style.top = Math.max(8, top) + 'px';
  el.querySelector('.md-x').onclick = hideMapDetails;
  $('#mdEdit').onclick = () => { closeMap(); openLocationInPanel(l.id); };
  $('#mdRoute').onclick = () => startRouteFrom(l.id);
  $('#mdRemove').onclick = () => removePin(l.id);
}
function hideMapDetails() { const el = $('#mapDetails'); if (el) el.classList.add('hidden'); }
function openLocationInPanel(id) {
  const acc = $('.accordion[data-acc="locs"]');
  if (acc) acc.classList.add('open');
  const wrap = $$('#locList .entity')[novel.locations.findIndex(l => l.id === id)];
  if (wrap) { wrap.classList.add('open'); wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

/* ---- layers ---- */
function renderMapLayers() {
  const host = $('#mapLayerList');
  if (!host) return;
  const wm = worldMap();
  host.innerHTML = '';
  const base = [
    ['background', '🗺️ Background Image'], ['locations', '📍 Locations'],
    ['routes', '🛤️ Travel Routes'], ['labels', '🏷️ Labels']
  ];
  base.forEach(([key, label]) => {
    const row = document.createElement('div');
    row.className = 'map-layer-row base';
    row.innerHTML = `<button class="ml-eye" title="Toggle">${wm.baseLayers[key] ? '👁' : '🚫'}</button><span class="ml-name">${label}</span>`;
    row.querySelector('.ml-eye').onclick = () => { wm.baseLayers[key] = !wm.baseLayers[key]; markDirty(); renderMapLayers(); mapDraw(); };
    host.appendChild(row);
  });
  wm.layers.forEach(l => {
    const row = document.createElement('div');
    row.className = 'map-layer-row' + (l.id === mActiveLayerId ? ' active' : '');
    row.innerHTML =
      `<button class="ml-eye" title="Toggle">${l.visible ? '👁' : '🚫'}</button>
       <span class="ml-name" title="Double-click to rename">${esc(l.name)}</span>
       <input type="range" class="ml-op" min="0" max="1" step="0.1" value="${l.opacity}" title="Opacity">
       <button class="ml-draw" title="Draw on this layer">✏️</button>
       <button class="ml-del" title="Delete layer">🗑</button>`;
    row.querySelector('.ml-eye').onclick = () => { l.visible = !l.visible; markDirty(); renderMapLayers(); mapDraw(); };
    row.querySelector('.ml-op').oninput = e => { l.opacity = +e.target.value; markDirty(); mapDraw(); };
    row.querySelector('.ml-name').ondblclick = () => promptModal('Rename layer', 'Layer name:', l.name, v => { if (v) { l.name = v; markDirty(); renderMapLayers(); renderMapLayerSelect(); } });
    row.querySelector('.ml-draw').onclick = () => { mActiveLayerId = (mActiveLayerId === l.id ? '' : l.id); $('#mapActiveLayer').value = mActiveLayerId; updateDrawToolsVisibility(); renderMapLayers(); };
    row.querySelector('.ml-del').onclick = () => confirmModal('Delete layer', `Delete layer “${l.name}” and its drawings?`, () => {
      wm.layers = wm.layers.filter(x => x.id !== l.id);
      if (mActiveLayerId === l.id) mActiveLayerId = '';
      markDirty(); renderMapLayers(); renderMapLayerSelect(); updateDrawToolsVisibility(); mapDraw();
    });
    host.appendChild(row);
  });
  if (!wm.layers.length) host.insertAdjacentHTML('beforeend', '<div class="map-empty">No custom layers.</div>');
}
function renderMapLayerSelect() {
  const sel = $('#mapActiveLayer');
  if (!sel) return;
  const wm = worldMap();
  sel.innerHTML = '<option value="">— none (move/place) —</option>' +
    wm.layers.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  sel.value = mActiveLayerId;
}
function addMapLayer() {
  const wm = worldMap();
  wm.layers.push({ id: uuid(), name: 'Layer ' + (wm.layers.length + 1), visible: true, opacity: 1, drawings: [] });
  markDirty(); renderMapLayers(); renderMapLayerSelect();
}
function activeLayer() { return worldMap().layers.find(l => l.id === mActiveLayerId) || null; }
function updateDrawToolsVisibility() {
  const on = !!mActiveLayerId;
  $('#mapDrawTools').classList.toggle('hidden', !on);
  if (mCanvas) mCanvas.style.cursor = on ? 'crosshair' : 'default';
}

/* ---- drawing interactions ---- */
function eraseAt(w) {
  const layer = activeLayer();
  if (!layer) return;
  const thresh = 10 / mView.zoom;
  const before = layer.drawings.length;
  layer.drawings = layer.drawings.filter(d => !(d.points || []).some(pt => Math.hypot(pt.x - w.x, pt.y - w.y) < thresh));
  if (layer.drawings.length !== before) { markDirty(); mapDraw(); }
}

/* ---- map events ---- */
function mapMouse(e) { const r = mCanvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function initMapEvents() {
  mCanvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const m = mapMouse(e);
    mMoved = false;
    const layer = activeLayer();
    if (layer) {
      const w = ms2w(m.x, m.y);
      if (mDrawTool === 'eraser') { eraseAt(w); return; }
      if (mDrawTool === 'text') {
        promptModal('Add text', 'Text label:', '', v => { if (v) { layer.drawings.push({ tool: 'text', color: mDrawColor, width: 2, points: [w], text: v }); markDirty(); mapDraw(); } });
        return;
      }
      mDrawing = { tool: mDrawTool, color: mDrawColor, width: 2, points: [w] };
      return;
    }
    const pin = pinAt(m.x, m.y);
    if (mRouteMode) { if (pin) routePickTarget(pin.id); return; }
    if (pin) { mDragPin = pin; mLast = m; hideMapDetails(); }
    else { mPanning = true; mLast = m; }
  });
  window.addEventListener('mousemove', e => {
    if (!mapOpen) return;
    const m = mapMouse(e);
    if (mDrawing) {
      const w = ms2w(m.x, m.y);
      if (mDrawing.tool === 'pen') mDrawing.points.push(w);
      else mDrawing.points[1] = w;
      mMoved = true; mapDraw(); return;
    }
    if (mDragPin) {
      const sz = mapImageSize(); const w = ms2w(m.x, m.y);
      const wm = worldMap();
      wm.locations[mDragPin.id] = { x: Math.max(0, Math.min(1, w.x / sz.w)), y: Math.max(0, Math.min(1, w.y / sz.h)), visible: true };
      mMoved = true; mapDraw(); return;
    }
    if (mPanning) { mView.x += m.x - mLast.x; mView.y += m.y - mLast.y; mLast = m; mMoved = true; mapDraw(); return; }
    if (!activeLayer()) {
      const overPin = pinAt(m.x, m.y);
      const overRoute = overPin ? null : routeAt(m.x, m.y);
      const hid = overRoute ? overRoute.id : null;
      if (hid !== mHoverRoute) { mHoverRoute = hid; mapDraw(); }
      mCanvas.style.cursor = overPin ? 'pointer' : overRoute ? 'pointer' : (mRouteMode ? 'crosshair' : 'grab');
    }
  });
  window.addEventListener('mouseup', () => {
    if (!mapOpen) return;
    if (mDrawing) {
      const layer = activeLayer();
      const d = mDrawing; mDrawing = null;
      const enough = d.tool === 'pen' ? d.points.length > 1 : d.points.length >= 2;
      if (layer && enough) { layer.drawings.push(d); markDirty(); }
      mapDraw(); return;
    }
    if (mDragPin) { if (mMoved) markDirty(); else showLocDetails(mDragPin); mDragPin = null; return; }
    if (mPanning) {
      mPanning = false;
      if (!mMoved) { const rt = routeAt(mLast.x, mLast.y); if (rt) openRouteEditor(rt); else hideMapDetails(); }
    }
  });
  mCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const m = mapMouse(e);
    const before = ms2w(m.x, m.y);
    mView.zoom = Math.max(0.05, Math.min(6, mView.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    const after = mw2s(before.x, before.y);
    mView.x += m.x - after.x; mView.y += m.y - after.y;
    updateMapZoom(); mapDraw();
  }, { passive: false });
  mCanvas.addEventListener('dblclick', e => { const m = mapMouse(e); const pin = pinAt(m.x, m.y); if (pin) { closeMap(); openLocationInPanel(pin.id); } });
  mCanvas.addEventListener('contextmenu', e => {
    const m = mapMouse(e);
    const pin = pinAt(m.x, m.y);
    e.preventDefault();
    ctx.innerHTML = '';
    if (pin) {
      ctx.appendChild(ctxItem('Edit in Locations', () => { closeMap(); openLocationInPanel(pin.id); }));
      ctx.appendChild(ctxItem('Add Route from Here', () => startRouteFrom(pin.id)));
      ctx.appendChild(ctxItem('Remove from Map', () => removePin(pin.id), 'danger'));
    } else {
      const wm = worldMap();
      const unplaced = novel.locations.filter(l => !wm.locations[l.id]);
      const w = ms2w(m.x, m.y); const sz = mapImageSize();
      const rel = { x: Math.max(0, Math.min(1, w.x / sz.w)), y: Math.max(0, Math.min(1, w.y / sz.h)) };
      if (!unplaced.length) ctx.appendChild(ctxItem('All locations placed', () => {}, 'ctx-disabled'));
      else {
        const sub = document.createElement('div');
        sub.className = 'ctx-sub';
        sub.innerHTML = '<button class="ctx-sub-head">Place Location ▸</button>';
        const list = document.createElement('div'); list.className = 'ctx-sub-menu';
        unplaced.forEach(l => list.appendChild(ctxItem(l.name || '(unnamed)', () => placeLocation(l.id, rel))));
        sub.appendChild(list); ctx.appendChild(sub);
      }
    }
    ctx.style.left = Math.min(e.clientX, innerWidth - 200) + 'px';
    ctx.style.top = e.clientY + 'px';
    ctx.classList.remove('hidden');
  });
}

/* ---- export PNG ---- */
function exportMapPng() {
  if (!mCanvas) return;
  const url = mCanvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = (novel.title || 'novel') + '-map.png'; a.click();
  toast('Map exported as PNG');
}

/* ---- travel routes (rendering; creation wired in the routes section) ---- */
function drawRoutes() {
  const wm = worldMap();
  wm.routes.forEach(rt => {
    const a = novel.locations.find(l => l.id === rt.fromLocationId);
    const b = novel.locations.find(l => l.id === rt.toLocationId);
    if (!a || !b || !wm.locations[a.id] || !wm.locations[b.id]) return;
    const pa = mw2s(...Object.values(locWorld(a)));
    const pb = mw2s(...Object.values(locWorld(b)));
    const hovered = mHoverRoute === rt.id;
    mCtx.save();
    mCtx.strokeStyle = rt.color || '#c9a96e';
    mCtx.lineWidth = (hovered ? 4 : 2);
    mCtx.globalAlpha = hovered ? 1 : 0.9;
    mCtx.setLineDash(rt.terrain && /secret|passage/i.test(rt.terrain) ? [6, 6] : []);
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
    const nx = -(pb.y - pa.y), ny = (pb.x - pa.x);
    const len = Math.hypot(nx, ny) || 1;
    const cx = mx + (nx / len) * 22, cy = my + (ny / len) * 22;   // gentle curve
    mCtx.beginPath(); mCtx.moveTo(pa.x, pa.y); mCtx.quadraticCurveTo(cx, cy, pb.x, pb.y); mCtx.stroke();
    mCtx.setLineDash([]);
    if (!rt.bidirectional) { const ang = Math.atan2(pb.y - cy, pb.x - cx); drawRouteArrow(cx, cy, ang, mCtx.strokeStyle); }
    if (rt.name) {
      mCtx.font = '600 12px Inter, sans-serif'; mCtx.textAlign = 'center'; mCtx.textBaseline = 'bottom';
      const tw = mCtx.measureText(rt.name).width;
      mCtx.fillStyle = 'rgba(20,20,26,.72)'; mCtx.fillRect(cx - tw / 2 - 4, cy - 18, tw + 8, 16);
      mCtx.fillStyle = rt.color || '#c9a96e'; mCtx.fillText(rt.name, cx, cy - 4);
    }
    mCtx.restore();
  });
  if (mRouteMode) {
    const a = novel.locations.find(l => l.id === mRouteMode.fromId);
    if (a && worldMap().locations[a.id]) {
      const pa = mw2s(...Object.values(locWorld(a)));
      mCtx.save(); mCtx.fillStyle = '#c9a96e'; mCtx.globalAlpha = 0.9;
      mCtx.beginPath(); mCtx.arc(pa.x, pa.y - pinScreenR() * 1.5, pinScreenR() + 4, 0, Math.PI * 2); mCtx.stroke(); mCtx.restore();
    }
  }
}
function drawRouteArrow(x, y, ang, color) {
  const s = 9;
  mCtx.save(); mCtx.fillStyle = color; mCtx.translate(x, y); mCtx.rotate(ang);
  mCtx.beginPath(); mCtx.moveTo(0, 0); mCtx.lineTo(-s, -s * 0.5); mCtx.lineTo(-s, s * 0.5); mCtx.closePath(); mCtx.fill();
  mCtx.restore();
}
let mHoverRoute = null;
let routeEditing = null, routeCharSel = null;

/* Quadratic-curve control point used for both drawing and hit-testing a route. */
function routeControl(pa, pb) {
  const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
  const nx = -(pb.y - pa.y), ny = (pb.x - pa.x);
  const len = Math.hypot(nx, ny) || 1;
  return { x: mx + (nx / len) * 22, y: my + (ny / len) * 22 };
}
function routeEndpoints(rt) {
  const wm = worldMap();
  const a = novel.locations.find(l => l.id === rt.fromLocationId);
  const b = novel.locations.find(l => l.id === rt.toLocationId);
  if (!a || !b || !wm.locations[a.id] || !wm.locations[b.id]) return null;
  return { pa: mw2s(...Object.values(locWorld(a))), pb: mw2s(...Object.values(locWorld(b))) };
}
function routeAt(sx, sy) {
  const wm = worldMap();
  if (!wm.baseLayers.routes) return null;
  for (let i = wm.routes.length - 1; i >= 0; i--) {
    const rt = wm.routes[i];
    const e = routeEndpoints(rt);
    if (!e) continue;
    const c = routeControl(e.pa, e.pb);
    let prev = e.pa;
    for (let t = 1; t <= 12; t++) {
      const k = t / 12, ik = 1 - k;
      const x = ik * ik * e.pa.x + 2 * ik * k * c.x + k * k * e.pb.x;
      const y = ik * ik * e.pa.y + 2 * ik * k * c.y + k * k * e.pb.y;
      if (distToSeg(sx, sy, prev.x, prev.y, x, y) < 7) return rt;
      prev = { x, y };
    }
  }
  return null;
}
/* enter route mode: fromId may start null (pick a source first) */
function beginRoute() {
  if (placedLocs().length < 2) { toast('Place at least two locations on the map first'); return; }
  mActiveLayerId = ''; $('#mapActiveLayer').value = ''; updateDrawToolsVisibility();
  mRouteMode = { fromId: null };
  hideMapDetails(); updateMapHint(); mapDraw();
}
function startRouteFrom(fromId) {
  if (!worldMap().locations[fromId]) { toast('Place this location on the map first'); return; }
  mActiveLayerId = ''; $('#mapActiveLayer').value = ''; updateDrawToolsVisibility();
  mRouteMode = { fromId };
  hideMapDetails(); updateMapHint(); mapDraw();
}
function routePickTarget(pinId) {
  if (!mRouteMode) return;
  if (mRouteMode.fromId === null) { mRouteMode.fromId = pinId; updateMapHint(); mapDraw(); return; }
  if (pinId === mRouteMode.fromId) { toast('Pick a different destination'); return; }
  const rt = {
    id: uuid(), fromLocationId: mRouteMode.fromId, toLocationId: pinId,
    name: '', travelTime: '', distance: '', terrain: '', characterIds: [],
    color: '#c9a96e', notes: '', bidirectional: true
  };
  worldMap().routes.push(rt);
  cancelRouteMode();
  markDirty(); mapDraw();
  openRouteEditor(rt);
}
function cancelRouteMode() { mRouteMode = null; updateMapHint(); }
function updateMapHint() {
  const el = $('#mapHint');
  if (!el) return;
  if (!mRouteMode) { el.classList.add('hidden'); return; }
  el.textContent = mRouteMode.fromId === null
    ? 'Add Route: click the first location  (Esc to cancel)'
    : 'Add Route: click the destination location  (Esc to cancel)';
  el.classList.remove('hidden');
}

/* ---- route details editor ---- */
function openRouteEditor(rt) {
  routeEditing = rt;
  routeCharSel = new Set(rt.characterIds || []);
  const placed = placedLocs();
  const locOpts = placed.map(l => [l.id, l.name || '(unnamed)']);
  $('#routeTitle').textContent = 'Route Details';
  const form = $('#routeForm');
  form.innerHTML =
    `<label class="field-label">Route name</label>
     <input type="text" id="rfName" class="control" placeholder="e.g. The King's Road" />
     <div class="rf-row">
       <div class="rf-col"><label class="field-label">From</label><select id="rfFrom" class="control"></select></div>
       <div class="rf-col"><label class="field-label">To</label><select id="rfTo" class="control"></select></div>
     </div>
     <div class="rf-row">
       <div class="rf-col"><label class="field-label">Travel time</label><input type="text" id="rfTime" class="control" placeholder="3 days on horseback" /></div>
       <div class="rf-col"><label class="field-label">Distance</label><input type="text" id="rfDist" class="control" placeholder="200 miles" /></div>
     </div>
     <label class="field-label">Terrain</label>
     <input type="text" id="rfTerrain" class="control" placeholder="Mountain pass, dangerous in winter" />
     <label class="field-label">Used by characters</label>
     <div id="rfChars" class="rf-chars"></div>
     <label class="field-label">Notes</label>
     <textarea id="rfNotes" class="control" rows="2"></textarea>
     <div class="rf-row">
       <div class="rf-col"><label class="field-label">Line color</label><input type="color" id="rfColor" class="nt-color" /></div>
       <div class="rf-col"><label class="field-label">Direction</label>
         <label class="toggle-row"><input type="checkbox" id="rfBidir" /> <span>Bidirectional (no arrow)</span></label>
       </div>
     </div>
     <div class="modal-actions">
       <button class="tbtn nc-danger" id="rfDelete">Delete Route</button>
       <button class="tbtn subtle" id="rfCancel">Close</button>
       <button class="tbtn accent" id="rfSave">Save</button>
     </div>`;
  fillSelect($('#rfFrom'), locOpts, rt.fromLocationId);
  fillSelect($('#rfTo'), locOpts, rt.toLocationId);
  $('#rfName').value = rt.name || '';
  $('#rfTime').value = rt.travelTime || '';
  $('#rfDist').value = rt.distance || '';
  $('#rfTerrain').value = rt.terrain || '';
  $('#rfNotes').value = rt.notes || '';
  $('#rfColor').value = rt.color || '#c9a96e';
  $('#rfBidir').checked = rt.bidirectional !== false;
  const chost = $('#rfChars');
  if (!novel.characters.length) chost.innerHTML = '<span class="map-empty">No characters yet.</span>';
  else novel.characters.forEach(c => {
    const chip = document.createElement('button');
    chip.className = 'rf-char' + (routeCharSel.has(c.id) ? ' on' : '');
    chip.textContent = c.name || '(unnamed)';
    chip.onclick = () => { if (routeCharSel.has(c.id)) routeCharSel.delete(c.id); else routeCharSel.add(c.id); chip.classList.toggle('on'); };
    chost.appendChild(chip);
  });
  $('#rfDelete').onclick = () => deleteRoute(rt);
  $('#rfCancel').onclick = closeRouteEditor;
  $('#rfSave').onclick = () => {
    rt.name = $('#rfName').value.trim();
    rt.fromLocationId = $('#rfFrom').value;
    rt.toLocationId = $('#rfTo').value;
    rt.travelTime = $('#rfTime').value.trim();
    rt.distance = $('#rfDist').value.trim();
    rt.terrain = $('#rfTerrain').value.trim();
    rt.notes = $('#rfNotes').value.trim();
    rt.color = $('#rfColor').value;
    rt.bidirectional = $('#rfBidir').checked;
    rt.characterIds = [...routeCharSel];
    if (rt.fromLocationId === rt.toLocationId) { toast('A route needs two different locations'); return; }
    markDirty(); closeRouteEditor(); mapDraw();
    toast('Route saved');
  };
  $('#routeOverlay').classList.remove('hidden');
}
function closeRouteEditor() { routeEditing = null; $('#routeOverlay').classList.add('hidden'); }
function deleteRoute(rt) {
  confirmModal('Delete route', 'Delete this route?', () => {
    const wm = worldMap();
    wm.routes = wm.routes.filter(r => r.id !== rt.id);
    markDirty(); closeRouteEditor(); mapDraw();
    toast('Route deleted');
  });
}
$('#mapAddRoute').addEventListener('click', beginRoute);
$('#routeOverlay').addEventListener('mousedown', e => { if (e.target === $('#routeOverlay')) closeRouteEditor(); });

/* ---- map toolbar wiring ---- */
$('#btnWorldMap').addEventListener('click', openMap);
$('#mapClose').addEventListener('click', closeMap);
$('#mapUpload').addEventListener('click', uploadMapImage);
$('#mapFit').addEventListener('click', mapFit);
$('#mapOriginal').addEventListener('click', mapOriginal);
$('#mapZoomIn').addEventListener('click', () => mapZoomBy(1.2));
$('#mapZoomOut').addEventListener('click', () => mapZoomBy(1 / 1.2));
$('#mapExport').addEventListener('click', exportMapPng);
$('#mapPlaceAll').addEventListener('click', placeAllUnplaced);
$('#mapAddLayer').addEventListener('click', addMapLayer);
$('#mapLocSearch').addEventListener('input', e => { mLocSearch = e.target.value; renderMapLocList(); });
$('#mapActiveLayer').addEventListener('change', e => { mActiveLayerId = e.target.value; updateDrawToolsVisibility(); renderMapLayers(); });
$('#mapDrawColor').addEventListener('input', e => { mDrawColor = e.target.value; });
$('#mapClearLayer').addEventListener('click', () => { const l = activeLayer(); if (!l) { toast('Select a layer to draw on first'); return; } confirmModal('Clear layer', `Remove all drawings from “${l.name}”?`, () => { l.drawings = []; markDirty(); mapDraw(); }); });
$$('#mapDrawTools .map-tool').forEach(btn => btn.addEventListener('click', () => {
  mDrawTool = btn.dataset.tool;
  $$('#mapDrawTools .map-tool').forEach(b => b.classList.toggle('active', b === btn));
}));
$('#mapOverlay').addEventListener('mousedown', e => { if (e.target === $('#mapOverlay')) closeMap(); });
addEventListener('resize', () => { if (mapOpen) mapResize(); });

/* ================= KEYBOARD SHORTCUTS ================= */
function navigateNotes(dir) {
  const notes = filteredNotes();
  if (!notes.length) return;
  let idx = notes.findIndex(n => n.id === openNoteId);
  idx = idx === -1 ? (dir > 0 ? 0 : notes.length - 1) : (idx + dir + notes.length) % notes.length;
  openNoteCard(notes[idx].id);
}
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); if (graphOpen) closeGraph(); else openGraph(); return; }
  if (e.key === 'Escape' && graphOpen) { if (!$('#graphPanel').classList.contains('hidden')) { $('#graphPanel').classList.add('hidden'); } else closeGraph(); return; }
  if (e.key === 'Escape' && corkboardOpen) { closeCorkboard(); return; }
  if (e.key === 'Escape' && mapOpen) { if (mRouteMode) { cancelRouteMode(); mapDraw(); updateMapHint(); } else closeMap(); return; }
  if (mod && e.shiftKey && (e.key === 'M' || e.key === 'm' || e.key === 'ь')) { e.preventDefault(); openAddNote(); return; }
  if (e.key === 'Escape' && openNoteId) { closeNoteCard(); return; }
  if (e.key === 'Escape' && notePopup && !notePopup.classList.contains('hidden')) { closeAddNote(); return; }
  if (mod && openNoteId && e.key === 'ArrowDown') { e.preventDefault(); navigateNotes(1); return; }
  if (mod && openNoteId && e.key === 'ArrowUp') { e.preventDefault(); navigateNotes(-1); return; }
  if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); setFocus(!focusMode); return; }
  if (mod && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); doSave(true); return; }
  if (mod && e.key === 's') { e.preventDefault(); doSave(false); return; }
  if (mod && e.key === 'o') { e.preventDefault(); doOpen(); return; }
  if (mod && e.key === '\\') { e.preventDefault(); $('#toggleLeft').click(); return; }
  if (mod && e.key === '/') { e.preventDefault(); $('#toggleRight').click(); return; }
  if (e.key === 'Escape' && focusMode) { setFocus(false); return; }
  if (mod && (e.key === 'b' || e.key === 'i')) { updateToolbarState(); } // let native handle, refresh state
});

/* ================= MENU EVENTS FROM RUST ================= */
if (hasTauri) {
  listen('menu', e => {
    const p = e.payload;
    if (typeof p === 'string' && p.startsWith('recent:')) {
      const path = p.slice(7);
      guardUnsaved(() => loadFromPath(path), 'Discard unsaved changes and open this file?');
      return;
    }
    switch (p) {
      case 'new': newProject(); break;
      case 'open': doOpen(); break;
      case 'save': doSave(false); break;
      case 'save_as': doSave(true); break;
      case 'export_txt': doExport('txt'); break;
      case 'export_html': doExport('html'); break;
      case 'export_md': doExport('md'); break;
      case 'export_notes_txt': doExportNotes('txt'); break;
      case 'export_notes_md': doExportNotes('md'); break;
      case 'undo': document.execCommand('undo'); break;
      case 'redo': document.execCommand('redo'); break;
      case 'toggle_focus': setFocus(!focusMode); break;
      case 'toggle_panels': $('#toggleLeft').click(); $('#toggleRight').click(); break;
      case 'about': confirmModal('About NovelCraft', 'NovelCraft — a distraction-free novel writing studio. Built with Tauri.', () => {}); break;
    }
  });

  /* intercept OS-level close (Alt+F4, taskbar) -> route through our dialog */
  const win = TAURI.window.getCurrentWindow();
  win.onCloseRequested(ev => {
    ev.preventDefault();
    requestClose();
  });
  /* keep maximize icon in sync when the OS changes window state */
  win.onResized(() => refreshMaxIcon());
}

/* ================= WINDOW CONTROLS (frameless) ================= */
if (!hasTauri) $('#winControls').style.display = 'none'; // browser: no native controls
async function destroyWindow() {
  if (hasTauri) await invoke('close_window');
}
/* Three-option close flow */
function requestClose() {
  if (!dirty) { destroyWindow(); return; }
  $('#closeOverlay').classList.remove('hidden');
}
$('#closeSaveBtn').addEventListener('click', async () => {
  const ok = await doSave(false);
  if (ok) { $('#closeOverlay').classList.add('hidden'); destroyWindow(); }
  // if save was cancelled/failed, leave dialog & app open
});
$('#closeDiscardBtn').addEventListener('click', () => {
  dirty = false;
  $('#closeOverlay').classList.add('hidden');
  destroyWindow();
});
$('#closeCancelBtn').addEventListener('click', () => {
  $('#closeOverlay').classList.add('hidden');
});

async function refreshMaxIcon() {
  const btn = $('#winMax');
  if (!btn) return;
  let max = false;
  if (hasTauri) { try { max = await invoke('is_maximized'); } catch (_) {} }
  btn.innerHTML = max ? '&#10064;' : '&#9723;';   // ❐ restore  /  ◻ maximize
  btn.title = max ? 'Restore' : 'Maximize';
}
$('#winMin').addEventListener('click', () => invoke('minimize_window'));
$('#winClose').addEventListener('click', () => requestClose());
$('#winMax').addEventListener('click', async () => {
  if (!hasTauri) return;
  const max = await invoke('is_maximized');
  await invoke(max ? 'unmaximize_window' : 'maximize_window');
  refreshMaxIcon();
});

/* ================= SETTINGS TOGGLES ================= */
const PREF_KEY = 'novelcraft:prefs';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (_) {} }

async function applyNativeTitlebar(on) {
  document.body.classList.toggle('native-titlebar', on);
  if (hasTauri) { try { await invoke('set_decorations', { on }); } catch (_) {} }
  const p = loadPrefs(); p.nativeTitlebar = on; savePrefs(p);
  $('#nativeTitlebar').checked = on;
}
$('#nativeTitlebar').addEventListener('change', e => applyNativeTitlebar(e.target.checked));

function applyTypewriter(on) {
  typewriter = on;
  document.body.classList.toggle('typewriter', on);
  const p = loadPrefs(); p.typewriter = on; savePrefs(p);
  $('#typewriterToggle').checked = on;
}
$('#typewriterToggle').addEventListener('change', e => applyTypewriter(e.target.checked));

/* ================= STARTUP ================= */
async function startup() {
  refreshUI();               // no novel yet -> shows the empty state
  setSaved();

  // restore user preferences
  const prefs = loadPrefs();
  applyNativeTitlebar(!!prefs.nativeTitlebar);
  applyTypewriter(!!prefs.typewriter);
  applyNoteDisplay();
  ensureHighlightStyles();
  refreshMaxIcon();
  await renderRecentMenu();

  const recovery = await checkRecovery();   // 'restored' | 'declined' | null
  if (recovery === 'restored') return;      // recovered novel is already loaded
  if (recovery === 'declined') return;      // leave the start menu; user opens what they want

  // No recovery backup -> normal launch: auto-open the last file if there is one,
  // otherwise the start menu (empty state) stays shown for the user to choose.
  if (hasTauri) {
    try {
      const path = await invoke('get_last_file');
      if (path) await loadFromPath(path);
    } catch (_) {}
  }
}
startup();
