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
function blankChapter(n) {
  return { id: uuid(), order: n, title: `Chapter ${n + 1}`, content: '', markdownContent: '', wordCount: 0 };
}
/* One .novel file = ONE novel. Structure matches the original spec:
   { version, title, settings, chapters[], characters[], locations[], races[] } */
function newNovel(title) {
  return {
    version: '1.0',
    title: title || 'Untitled Novel',
    settings: { fontSize: 18, defaultFont: 'Georgia, serif', wordGoal: 80000 },
    chapters: [blankChapter(0)],
    characters: [],
    locations: [],
    races: []
  };
}

let novel = null;              // the currently-open novel (null = none open)
let currentChapterId = null;
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
  novel.chapters.forEach(c => {
    savedContent[c.id] = normalizeHTML(c.content);
    savedMd[c.id] = c.markdownContent || '';
  });
}
function setSaving() {
  const ind = $('#saveIndicator');
  ind.textContent = 'Saving…';
  ind.classList.add('saving');
}

/* ================= CHAPTERS ================= */
function currentChapter() {
  if (!novel) return null;
  return novel.chapters.find(c => c.id === currentChapterId) || novel.chapters[0];
}
function renumber() {
  if (novel) novel.chapters.forEach((c, i) => (c.order = i));
}
function renderChapters() {
  chapterList.innerHTML = '';
  if (!novel) return;
  renumber();
  novel.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'chapter-item' + (c.id === currentChapterId ? ' active' : '');
    li.dataset.id = c.id;
    li.innerHTML = `<div class="ci-top"><span class="ci-num">${i + 1}.</span>
      <span class="ci-title">${esc(c.title)}</span></div>
      <div class="ci-words">${c.wordCount} words</div>`;
    chapterList.appendChild(li);
  });
}
function selectChapter(id, saveFirst = true) {
  if (saveFirst) saveCurrentChapter();
  currentChapterId = id;
  loadChapterIntoEditor();
  renderChapters();       // re-render highlights the active chapter
  updateCounters();
  localBackup();
}
// Requested aliases (clearer intent)
const loadChapter = id => selectChapter(id, true);
function loadChapterIntoEditor() {
  const wasLoading = isLoadingContent;
  isLoadingContent = true;               // programmatic editor population must not mark dirty
  const c = currentChapter();
  if (!c) {
    $('#chapterTitle').textContent = '';
    editor.innerHTML = '';
    mdEditor.value = '';
  } else {
    $('#chapterTitle').textContent = c.title;
    if (mdMode) mdEditor.value = c.markdownContent || htmlToMd(c.content);
    else editor.innerHTML = c.content || '';
  }
  isLoadingContent = wasLoading;
}
function saveCurrentChapter() {
  const c = currentChapter();
  if (!c) return;
  if (mdMode) {
    c.markdownContent = mdEditor.value;
    c.content = mdToHtml(mdEditor.value);
  } else {
    c.content = editor.innerHTML;
    c.markdownContent = htmlToMd(c.content);
  }
  c.wordCount = countWords(stripHtml(c.content));
}
function addChapter() {
  if (!novel) { addNovel(); return; }
  saveCurrentChapter();
  const c = blankChapter(novel.chapters.length);
  novel.chapters.push(c);
  currentChapterId = c.id;
  loadChapterIntoEditor();
  renderChapters();
  updateCounters();
  markDirty();
  toast('Chapter added');
}
function duplicateChapter(id) {
  const src = novel.chapters.find(c => c.id === id);
  if (!src) return;
  const copy = { ...src, id: uuid(), title: src.title + ' (copy)' };
  const idx = novel.chapters.findIndex(c => c.id === id);
  novel.chapters.splice(idx + 1, 0, copy);
  renderChapters();
  markDirty();
  toast('Chapter duplicated');
}
function deleteChapter(id) {
  if (novel.chapters.length === 1) {
    toast('Cannot delete the last chapter');
    return;
  }
  confirmModal('Delete chapter', 'Delete this chapter? This cannot be undone.', () => {
    const idx = novel.chapters.findIndex(c => c.id === id);
    novel.chapters.splice(idx, 1);
    if (currentChapterId === id) currentChapterId = novel.chapters[Math.max(0, idx - 1)].id;
    loadChapterIntoEditor();
    renderChapters();
    updateCounters();
    markDirty();
    toast('Chapter deleted');
  });
}
function renameChapter(id) {
  const c = novel.chapters.find(x => x.id === id);
  if (!c) return;
  promptModal('Rename chapter', 'New title:', c.title, val => {
    c.title = val || c.title;
    if (id === currentChapterId) $('#chapterTitle').textContent = c.title;
    renderChapters();
    markDirty();
  });
}

/* ---- pointer-based chapter reorder + click-to-select ----
   HTML5 drag-and-drop is unreliable in the desktop webview (compounded by the
   global `user-select:none`), so we drive it with mouse events instead. A short
   movement threshold distinguishes a click (select chapter) from a drag. */
let chDrag = null; // { id, el, startX, startY, started, overId, after }
function clearDropMarkers() {
  $$('.chapter-item').forEach(x => x.classList.remove('drop-before', 'drop-after'));
}
chapterList.addEventListener('mousedown', e => {
  if (e.button !== 0) return;                       // left button only
  const li = e.target.closest('.chapter-item');
  if (!li) return;
  chDrag = { id: li.dataset.id, el: li, startX: e.clientX, startY: e.clientY, started: false, overId: null, after: false };
});
document.addEventListener('mousemove', e => {
  if (!chDrag) return;
  if (!chDrag.started) {
    if (Math.abs(e.clientX - chDrag.startX) < 5 && Math.abs(e.clientY - chDrag.startY) < 5) return;
    chDrag.started = true;
    chDrag.el.classList.add('dragging');
  }
  e.preventDefault();
  const items = $$('.chapter-item');
  clearDropMarkers();
  chDrag.overId = null;
  const over = items.find(x => {
    const r = x.getBoundingClientRect();
    return e.clientY >= r.top && e.clientY <= r.bottom;
  });
  if (over && over !== chDrag.el) {
    const r = over.getBoundingClientRect();
    chDrag.after = e.clientY > r.top + r.height / 2;
    chDrag.overId = over.dataset.id;
    over.classList.add(chDrag.after ? 'drop-after' : 'drop-before');
  } else if (!over && items.length) {
    // pointer past the ends of the list -> drop at start or end
    const last = items[items.length - 1];
    const first = items[0];
    if (e.clientY > last.getBoundingClientRect().bottom && last !== chDrag.el) {
      chDrag.overId = last.dataset.id; chDrag.after = true;
      last.classList.add('drop-after');
    } else if (e.clientY < first.getBoundingClientRect().top && first !== chDrag.el) {
      chDrag.overId = first.dataset.id; chDrag.after = false;
      first.classList.add('drop-before');
    }
  }
});
document.addEventListener('mouseup', () => {
  if (!chDrag) return;
  const st = chDrag;
  chDrag = null;
  clearDropMarkers();
  st.el.classList.remove('dragging');
  if (!st.started) {
    // no meaningful movement -> treat as a click (select the chapter)
    if (st.id !== currentChapterId) selectChapter(st.id);
    return;
  }
  if (st.overId && st.overId !== st.id) {
    const from = novel.chapters.findIndex(c => c.id === st.id);
    const moved = novel.chapters.splice(from, 1)[0];
    let to = novel.chapters.findIndex(c => c.id === st.overId);
    if (st.after) to += 1;
    novel.chapters.splice(to, 0, moved);
    renderChapters();
    markDirty();
  }
});

/* "+" add-chapter button */
$('#btnAddChapter').addEventListener('click', addChapter);

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
    applyFontSize(novel.settings.fontSize || 18);
    applyDocFont(novel.settings.defaultFont || 'Georgia, serif');
  } else {
    currentChapterId = null;
  }
  loadChapterIntoEditor();
  renderChapters();
  renderEntities('characters');
  renderEntities('locations');
  renderEntities('races');
  updateCounters();
  updateWindowTitle();
  updateFilePathIndicator();
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
  if (!Array.isArray(n.chapters) || !n.chapters.length) n.chapters = [blankChapter(0)];
  n.chapters.forEach((c, i) => {
    c.id = c.id || uuid();
    c.order = i;
    c.title = c.title || `Chapter ${i + 1}`;
    c.content = c.content || '';
    c.markdownContent = c.markdownContent || '';
    c.wordCount = c.wordCount || countWords(stripHtml(c.content));
  });
  ['characters', 'locations', 'races'].forEach(k => {
    if (!Array.isArray(n[k])) n[k] = [];
    n[k].forEach(e => { if (!e.id) e.id = uuid(); });
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
  const c = currentChapter();
  if (!c) return;
  c.content = editor.innerHTML;
  c.wordCount = countWords(stripHtml(c.content));
  updateCounters();
  refreshChapterWordCount(c);
  // only mark dirty if the content really differs from the last saved snapshot (Bug 2B)
  if (normalizeHTML(c.content) !== (savedContent[c.id] || '')) markDirty();
});
mdEditor.addEventListener('input', () => {
  if (isLoadingContent) return;
  const c = currentChapter();
  if (!c) return;
  c.markdownContent = mdEditor.value;
  c.wordCount = countWords(mdEditor.value);
  updateCounters();
  refreshChapterWordCount(c);
  if (c.markdownContent !== (savedMd[c.id] || '')) markDirty();
});
function refreshChapterWordCount(c) {
  const li = chapterList.querySelector(`[data-id="${c.id}"] .ci-words`);
  if (li) li.textContent = c.wordCount + ' words';
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
  const c = currentChapter();
  if (!c) return;
  isLoadingContent = true;   // switching views is not an edit (Bug 2C)
  if (!mdMode) {
    // visual -> markdown
    c.content = editor.innerHTML;
    mdEditor.value = htmlToMd(c.content);
    c.markdownContent = mdEditor.value;
    editor.classList.add('hidden');
    mdEditor.classList.remove('hidden');
    $('#btnMarkdownMode').classList.add('active');
    mdMode = true;
  } else {
    // markdown -> visual
    c.markdownContent = mdEditor.value;
    c.content = mdToHtml(mdEditor.value);
    editor.innerHTML = c.content;
    mdEditor.classList.add('hidden');
    editor.classList.remove('hidden');
    $('#btnMarkdownMode').classList.remove('active');
    mdMode = false;
  }
  isLoadingContent = false;
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
    empty: () => ({ id: uuid(), name: '', role: 'main', age: '', appearance: '', personality: '', bio: '', history: '', motivation: '', relationships: '', notes: '' }),
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
      { key: 'relationships', label: 'Relationships', type: 'textarea' },
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
        renderEntities(kind);
        markDirty();
        toast('Deleted');
      });
    });
    body.appendChild(del);
    wrap.appendChild(head);
    wrap.appendChild(body);
    host.appendChild(wrap);
  });
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
  const chapWords = c ? c.wordCount || 0 : 0;
  const total = novel ? novel.chapters.reduce((s, x) => s + (x.wordCount || 0), 0) : 0;
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

/* ================= CHAPTER TITLE INLINE EDIT ================= */
const chTitle = $('#chapterTitle');
chTitle.addEventListener('dblclick', () => {
  chTitle.contentEditable = 'true';
  chTitle.focus();
  document.execCommand('selectAll', false, null);
});
chTitle.addEventListener('blur', commitTitle);
chTitle.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); chTitle.blur(); }
});
function commitTitle() {
  chTitle.contentEditable = 'false';
  const c = currentChapter();
  if (!c) return;
  const v = chTitle.textContent.trim();
  if (v) { c.title = v; renderChapters(); markDirty(); }
  else chTitle.textContent = c.title;
}

/* ================= CONTEXT MENU ================= */
const ctx = $('#ctxMenu');
let ctxTargetId = null;
chapterList.addEventListener('contextmenu', e => {
  const li = e.target.closest('.chapter-item');
  if (!li) return;
  e.preventDefault();
  ctxTargetId = li.dataset.id;
  ctx.style.left = e.clientX + 'px';
  ctx.style.top = e.clientY + 'px';
  ctx.classList.remove('hidden');
});
document.addEventListener('click', () => ctx.classList.add('hidden'));
ctx.addEventListener('click', e => {
  const act = e.target.dataset.ctx;
  if (!act || !ctxTargetId) return;
  if (act === 'rename') renameChapter(ctxTargetId);
  if (act === 'duplicate') duplicateChapter(ctxTargetId);
  if (act === 'delete') deleteChapter(ctxTargetId);
});

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
  if (n === novel) saveCurrentChapter();
  if (kind === 'txt') {
    return n.chapters.map(c => c.title.toUpperCase() + '\n\n' + stripHtml(c.content).trim()).join('\n\n\n');
  }
  if (kind === 'md') {
    return n.chapters.map(c => '# ' + c.title + '\n\n' + (c.markdownContent || htmlToMd(c.content)).trim()).join('\n\n---\n\n');
  }
  if (kind === 'html') {
    const body = n.chapters
      .map(c => `<section><h1>${esc(c.title)}</h1>\n${c.content}</section>`)
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

/* ================= KEYBOARD SHORTCUTS ================= */
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
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
