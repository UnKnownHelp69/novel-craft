/* Margin notes: anchoring them to the text, the add-note popup, margin dots, highlights, the
   expanded card, the notes panel and note types. */
import { hasTauri, invoke, pickPath } from './bridge.js';
import { $, editor } from './dom.js';
import { esc, escAttr, uuid } from './lib/text.js';
import { novel } from './state.js';
import { markDirty } from './dirty.js';
import { currentChapter, currentScene } from './tree.js';
import { flushNovel, safeColor } from './novel-file.js';
import { mdMode } from './editor.js';
import { confirmModal, toast } from './dialogs.js';
import { downloadFile } from './export.js';
import { loadPrefs, savePrefs } from './settings.js';

const DEFAULT_NOTE_TYPES = [
  { id: 'fix',       name: 'Fix',        color: '#e6b422', icon: '🟡' },
  { id: 'factcheck', name: 'Fact-check', color: '#4a90d9', icon: '🔵' },
  { id: 'expand',    name: 'Expand',     color: '#5cb85c', icon: '🟢' },
  { id: 'move',      name: 'Move',       color: '#9b59b6', icon: '🟣' },
  { id: 'idea',      name: 'Idea',       color: '#e74c3c', icon: '🔴' }
];
const NOTE_FALLBACK_ID = 'idea';

/* display prefs are app-level (localStorage), colors of default types are per-novel */
let noteDisplay = { showMargin: true, highlightAnno: true, autoResolveEdit: false };
export let openNoteId = null;             // id of the note whose card is open
export function setOpenNoteId(v) { openNoteId = v; }
let noteEditing = false;           // card is in edit mode
let noteResolvedFilter = 'hide';   // 'hide' | 'show' | 'only'
let noteTypeFilter = new Set();    // empty = all types
let pendingSelection = null;       // {start,end,text,rect} captured for the add popup (rect: client coords)
let notesRenderRAF = null;

const marginNotes = $('#marginNotes');
const noteCard = $('#noteCard');
export const notePopup = $('#notePopup');

/* Default types are fixed in code; a novel only stores colour overrides for them
   (settings.noteTypeColors). Custom types live whole in settings.customNoteTypes. Both are
   colour-checked by migrateNovel on load. */
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
function chapterNotes() { const s = currentScene(); return (s && s.notes) || []; }  // despite the name: notes live on scenes
/* Coalesces dot/highlight/card layout into one frame; called on every keystroke and resize. */
export function scheduleNotesRender() {
  if (notesRenderRAF) return;
  notesRenderRAF = requestAnimationFrame(() => { notesRenderRAF = null; renderMargin(); updateHighlights(); positionOpenCard(); });
}

/* ---- text-offset helpers ----
   A note's startOffset/endOffset (saved in the .novel) index editor.textContent: UTF-16 code
   units over all text nodes concatenated, with nothing between paragraphs, i.e. the same
   indices String.slice uses. selectedText is kept alongside so reconcileNotes can re-anchor
   the note after edits. The notes UI is visual-mode only; the markdown text has other offsets. */
/* A DOM boundary point may be (element, child index) rather than (text node, char), so count
   the text in a cloned prefix range instead of walking to the container. */
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
/* Inverse of charIndexFromPoint. null when the offsets run past the text (stale note). */
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
/* Locate annotated text after the surrounding prose has changed length. When the phrase occurs
   more than once, take the occurrence nearest `hint` (the old start) so the note stays on its copy. */
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
/* Re-anchor each note of scene `c` by its selectedText. Runs on every edit and whenever the scene
   enters the visual editor; it updates offsets in place and never marks dirty itself. A note
   whose text is gone keeps its old offsets and is flagged positionLost (optionally auto-resolved). */
export function reconcileNotes(c) {
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
/* The editor selection as note offsets, or null in markdown mode / outside the editor. */
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
export function fmtNoteDate(iso) {
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
function hexToRgba(hex, a) {   // anything but #rrggbb falls back to the accent gold
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return `rgba(201,169,110,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
/* Clamp a floating element to the viewport near a client rect. Shown, measured and placed in
   one task, so it never paints at the old spot. No visibility:hidden while measuring: the
   controls inside transition `all`, so their inherited visibility would animate back from
   hidden and stay hidden (unfocusable) until the next frame. */
function positionFloat(el, rect) {
  el.classList.remove('hidden');
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + w > innerWidth - 10) left = innerWidth - w - 10;
  if (left < 10) left = 10;
  if (top + h > innerHeight - 10) top = Math.max(10, rect.top - h - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

/* ---- add-note popup ---- */
export function openAddNote(sel) {
  const s = sel || getSelectionInEditor();
  if (!s) { toast('Select text to annotate'); return; }
  if (!novel || !currentScene()) return;
  pendingSelection = s;
  buildTypeOptions($('#npType'));
  $('#npContent').value = '';
  positionFloat(notePopup, s.rect);
  // focus now, not on a timer: a key typed in between would replace the selection in the scene
  $('#npContent').focus();
}
export function closeAddNote() { if (notePopup) { notePopup.classList.add('hidden'); } pendingSelection = null; }
export function confirmAddNote() {
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

/* editor right-click -> "Add Note" */
const editorCtx = $('#editorCtx');

/* ---- note filtering ---- */
export function filteredNotes() {
  let notes = chapterNotes().slice();
  if (noteTypeFilter.size) notes = notes.filter(n => noteTypeFilter.has(n.typeId));
  if (noteResolvedFilter === 'hide') notes = notes.filter(n => !n.resolved);
  else if (noteResolvedFilter === 'only') notes = notes.filter(n => n.resolved);
  notes.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  return notes;
}

/* ---- margin dots ---- */
/* Dots live inside #editorWrap, which scrolls with the text, so `top` is relative to it and
   they need re-layout only when lines reflow (edits, resize), not on scroll. */
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
  dotTip.innerHTML = `<b style="color:${safeColor(ty.color, '#c9a96e')}">${esc(ty.icon || '')} ${esc(ty.name)}</b>` +
    `<div class="nt-content">${esc((nt.content || '(no text)').slice(0, 50))}</div>` +
    `<div class="nt-date">${fmtNoteDate(nt.createdAt)}</div>`;
  document.body.appendChild(dotTip);
  const r = dot.getBoundingClientRect();
  dotTip.style.top = r.top + 'px';
  dotTip.style.left = (r.left - dotTip.offsetWidth - 10) + 'px';
}
function hideDotTooltip() { if (dotTip) { dotTip.remove(); dotTip = null; } }

/* ---- annotated-text highlighting (CSS Custom Highlight API) ---- */
/* Highlights paint over Ranges without touching the editor DOM, so the scene HTML, the saved
   snapshot (dirty flag), caret and undo stack are unaffected. One registry entry per note type
   plus `note-active` for the open note; webviews without the API just show no underline.
   Type ids and colours come from the .novel and end up in generated CSS text: ids are reduced
   to identifier characters and colours go through safeColor, so a crafted type cannot inject CSS. */
function cssHlName(id) { return 'note-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '_'); }
export function ensureHighlightStyles() {
  let st = document.getElementById('noteHiliteStyles');
  if (!st) { st = document.createElement('style'); st.id = 'noteHiliteStyles'; document.head.appendChild(st); }
  st.textContent = getNoteTypes().map(ty =>
    `::highlight(${cssHlName(ty.id)}){text-decoration:underline;text-decoration-color:${safeColor(ty.color, '#c9a96e')};text-decoration-thickness:2px;text-underline-offset:3px;}`
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

/* ---- expanded note card ---- */
export function openNoteCard(id, scroll = true) {
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
      // the card is position:fixed: place it again once the smooth scroll has (roughly) settled
      setTimeout(() => { renderNoteCard(); renderMargin(); }, 260);
    }
  }
  renderNoteCard();
  renderMargin();
  updateHighlights();
}
export function closeNoteCard() {
  openNoteId = null; noteEditing = false;
  if (noteCard) noteCard.classList.add('hidden');
  renderMargin();
  updateHighlights();
}
export function renderNoteCard() {
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
         <span class="note-badge" style="--nc:${safeColor(ty.color, '#c9a96e')}">${esc(ty.icon || '•')} ${esc(ty.name)}</span>
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
/* Beside the annotated text: right of it, flipped left when it would overflow. Without a range
   (markdown mode, stale offsets) it falls back to a spot near the top of the editor. 48 = 40px top bar + gap. */
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

/* ---- notes panel (right sidebar) ---- */
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
    b.innerHTML = `${esc(ty.icon || '•')} ${esc(ty.name)} (${count})`;
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
           <span class="nl-type">${esc(ty.icon || '•')} ${esc(ty.name)}</span>
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
export function renderNotes() {
  renderFilterPills();
  renderNotesPanel();
  renderMargin();
  updateHighlights();
  positionOpenCard();
}
const noteResolvedSel = $('#noteResolvedFilter');

/* ---- note-type settings ---- */
/* The ::highlight rules are generated per type, so every type/colour change calls
   ensureHighlightStyles before re-rendering. */
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
export function renderNoteTypeSettings() {
  const host = $('#noteTypeList');
  if (!host) return;
  host.innerHTML = '';
  if (!novel) { host.innerHTML = '<div class="empty-msg">Open a novel</div>'; return; }
  getNoteTypes().forEach(ty => {
    const row = document.createElement('div');
    row.className = 'nt-row';
    row.innerHTML =
      `<input type="color" class="nt-color" value="${safeColor(ty.color, '#c9a96e')}" title="Color">
       <span class="nt-icon">${esc(ty.icon || '•')}</span>
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
  const color = safeColor(existing ? existing.color : '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'), '#c9a96e');
  form.innerHTML =
    `<input type="text" class="control ntf-name" placeholder="Name" value="${existing ? escAttr(existing.name) : ''}">
     <div class="ntf-row">
       <input type="color" class="ntf-color" value="${color}" title="Color">
       <input type="text" class="control ntf-icon" maxlength="2" placeholder="Icon" value="${existing ? escAttr(existing.icon || '') : ''}">
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

/* ---- note-display toggles ---- */
export function applyNoteDisplay() {
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

/* ---- export notes ---- */
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
export async function doExportNotes(kind) {
  if (!novel) { toast('No novel open'); return; }
  flushNovel();
  const content = buildNotesExport(kind);
  const name = (novel.title || 'novel') + '-notes.' + kind;
  if (hasTauri) {
    const path = await pickPath('pick_save', { defaultName: name });
    if (!path) return;
    try {
      await invoke('write_text', { path, content });
    } catch (e) {
      console.error(e);
      toast('Export failed');
      return;
    }
  } else {
    downloadFile(name, content);
  }
  toast('Notes exported (' + kind.toUpperCase() + ')');
}

export function init() {
  if (notePopup) {
    $('#npAdd').addEventListener('click', confirmAddNote);
    $('#npCancel').addEventListener('click', closeAddNote);
    $('#npContent').addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); confirmAddNote(); }
      if (e.key === 'Escape') { e.preventDefault(); closeAddNote(); }
    });
  }
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
  /* Click outside the open card closes it. Dots and list entries open a card themselves, and
     modals are excluded so the Delete confirmation does not close the card under it. */
  document.addEventListener('mousedown', e => {
    if (!openNoteId) return;
    if (e.target.closest('#noteCard') || e.target.closest('.note-dot') ||
        e.target.closest('.note-lcard') || e.target.closest('.modal-overlay')) return;
    closeNoteCard();
  });
  if (noteResolvedSel) noteResolvedSel.addEventListener('change', e => { noteResolvedFilter = e.target.value; renderNotes(); });
  if (btnAddNoteType) btnAddNoteType.addEventListener('click', () => showCustomTypeForm(null, null));
  ['showMargin', 'highlightAnno', 'autoResolveEdit'].forEach(key => {
    const el = $('#' + key);
    if (!el) return;
    el.addEventListener('change', e => {
      noteDisplay[key] = e.target.checked;
      saveNoteDisplay();
      renderNotes();
    });
  });
  /* Resize reflows the text, so everything is re-laid out. Scrolling only moves the fixed-position
     card; the dot tooltip is dropped and the add popup closed (its selection rect is now stale). */
  addEventListener('resize', scheduleNotesRender);
  $('.editor-scroll').addEventListener('scroll', () => { positionOpenCard(); hideDotTooltip(); if (notePopup && !notePopup.classList.contains('hidden')) closeAddNote(); });
}
