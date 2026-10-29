/* The Compile dialog: what goes into the book, in what order, with which settings and
   presets. compile-export.js turns the result into documents. */
import { $, $$ } from './dom.js';
import { esc, escAttr, uuid } from './lib/text.js';
import { novel } from './state.js';
import { markDirty } from './dirty.js';
import { findScene, saveCurrentScene } from './tree.js';
import { confirmModal, promptModal, toast } from './dialogs.js';
import { NOVEL_LANGUAGES } from './lib/language.js';
import { COMP_FONT_OPTIONS, doCompExport, renderCompPreview } from './compile-export.js';

export let compOpen = false;
let compEventsInit = false;
/* { items, settings } of the open novel's compilation. In memory only and reset when another
   novel loads; just the named presets (novel.settings.compilationPresets) reach the file.
   items: { type: 'scene', sceneId, chapterId, title? } | { type: 'part', title } | { type: 'break' } */
export let comp = null;
export function setComp(v) { comp = v; }
let compPreview = false;
let compDrag = null;


function defaultCompSettings() {
  return {
    font: 'Georgia, serif', fontSize: 12, lineSpacing: 1.5, align: 'left',
    indent: 'indent', paraSpacing: 'none',
    sceneTitles: 'no', includeParts: true, sceneSeparator: '***', sceneSepCustom: '',
    numberChapters: 'arabic', pageNumber: 'none', startPage: 1,
    titlePage: true, titleText: '', author: '', subtitle: '', dateText: '',
    toc: false, tocDepth: 'chapters', tocPosition: 'afterTitle',
    pageSize: 'A4', margins: 'normal'
  };
}
const STANDARD_PRESET = defaultCompSettings();

function buildDefaultOrder() {
  const items = [];
  novel.chapters.forEach(c => (c.scenes || []).forEach(s => {
    // no `title`: scene items show the live scene title unless renamed in the compilation
    items.push({ id: uuid(), type: 'scene', sceneId: s.id, chapterId: c.id });
  }));
  return items;
}
/* Drop items whose scene was deleted since the compilation was last open. */
function syncCompItems() {
  comp.items = comp.items.filter(it => it.type !== 'scene' || findScene(it.sceneId));
}

export function openCompile() {
  if (!novel) { toast('No novel open'); return; }
  saveCurrentScene();
  if (!comp) comp = { items: buildDefaultOrder(), settings: defaultCompSettings() };
  else syncCompItems();
  if (!comp.settings.titleText) comp.settings.titleText = novel.title || '';
  comp.settings.language = novel.settings.language || null;   // null renders as Auto-detect
  compPreview = false;
  $('#compileOverlay').classList.remove('hidden');
  if (!compEventsInit) { initCompEvents(); compEventsInit = true; }
  renderPresetSelect();
  renderComp();
}
export function closeCompile() { compOpen = false; $('#compileOverlay').classList.add('hidden'); }

function renderComp() {
  compOpen = true;
  renderCompAvailable();
  renderCompOrder();
  renderCompSettings();
  updateCompTotals();
  $('#compPreviewBtn').classList.toggle('active', compPreview);
  $('#compOrder').classList.toggle('hidden', compPreview);
  $('.compile-order-tools').style.display = compPreview ? 'none' : '';
  $('#compPreview').classList.toggle('hidden', !compPreview);
  if (compPreview) renderCompPreview();
}

function renderCompAvailable() {
  const host = $('#compAvailable');
  const q = ($('#compSearch').value || '').trim().toLowerCase();
  host.innerHTML = '';
  novel.chapters.forEach(c => {
    const scenes = (c.scenes || []).filter(s => !q || (s.title || '').toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q));
    if (!scenes.length) return;
    const grp = document.createElement('div');
    grp.className = 'ca-group';
    grp.innerHTML = `<div class="ca-chap">📁 ${esc(c.title)}</div>`;
    scenes.forEach(s => {
      const row = document.createElement('div');
      row.className = 'ca-scene';
      row.dataset.sceneId = s.id;
      row.dataset.chapterId = c.id;
      row.innerHTML = `<span class="ca-t">🎬 ${esc(s.title)}</span><span class="ca-w">${s.wordCount || 0}</span><button class="ca-add" title="Add to compilation">＋</button>`;
      row.querySelector('.ca-add').onclick = e => { e.stopPropagation(); comp.items.push({ id: uuid(), type: 'scene', sceneId: s.id, chapterId: c.id }); renderComp(); };
      grp.appendChild(row);
    });
    host.appendChild(grp);
  });
  if (!host.children.length) host.innerHTML = '<div class="map-empty">No scenes match.</div>';
}

/* Rows carry their index into comp.items (data-idx); every change re-renders the list. */
function renderCompOrder() {
  const host = $('#compOrder');
  host.innerHTML = '';
  if (!comp.items.length) { host.innerHTML = '<div class="co-empty">Empty. Drag or add scenes from the left, or “Restore Default Order”.</div>'; return; }
  comp.items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.dataset.idx = idx;
    if (it.type === 'part') {
      row.className = 'co-item co-part';
      row.innerHTML = `<span class="co-handle">⠿</span><span class="co-part-t">${esc(it.title || 'Part')}</span><button class="co-x" title="Remove">✕</button>`;
      row.querySelector('.co-part-t').ondblclick = () => promptModal('Part title', 'Text:', it.title, v => { it.title = v || it.title; renderComp(); });
    } else if (it.type === 'break') {
      row.className = 'co-item co-break';
      row.innerHTML = `<span class="co-handle">⠿</span><span class="co-break-t">— section break —</span><button class="co-x" title="Remove">✕</button>`;
    } else {
      const f = findScene(it.sceneId);
      const words = f ? (f.scene.wordCount || 0) : 0;
      const ci = f ? novel.chapters.indexOf(f.chapter) + 1 : '?';
      row.className = 'co-item co-scene';
      row.innerHTML =
        `<span class="co-handle">⠿</span>
         <span class="co-title" title="Double-click to rename for the compilation">${esc(it.title || (f ? f.scene.title : '(missing)'))}</span>
         <span class="co-src">from Ch. ${ci}</span>
         <span class="co-w">${words}</span>
         <button class="co-x" title="Remove from compilation">✕</button>`;
      // it.title is an explicit override only; typing the scene's own title drops it again
      row.querySelector('.co-title').ondblclick = () => promptModal('Rename in compilation', 'Title (does not change the original scene):', it.title || (f ? f.scene.title : ''), v => {
        if (v) { if (f && v === f.scene.title) delete it.title; else it.title = v; }
        renderComp();
      });
    }
    row.querySelector('.co-x').onclick = () => { comp.items.splice(idx, 1); renderComp(); };
    host.appendChild(row);
  });
}
function updateCompTotals() {
  let words = 0;
  comp.items.forEach(it => { if (it.type === 'scene') { const f = findScene(it.sceneId); if (f) words += f.scene.wordCount || 0; } });
  $('#compTotal').textContent = 'Compiled document: ' + words.toLocaleString() + ' words';
  $('#compPages').textContent = '~' + Math.max(1, Math.round(words / 300)) + ' pages';   // ~300 words per manuscript page
}

/* Drag & drop into and within the order list, on pointer events like the chapter tree (the
   HTML5 Drag API is unreliable in the webview). A press only becomes a drag after 5px, so a
   click or a double-click (rename) on a row stays one; 'new' drags come from the available list.
   The drop index is the first row whose vertical midpoint lies below the pointer. */
function initCompEvents() {
  const order = $('#compOrder');
  const avail = $('#compAvailable');
  const start = (e, data) => { compDrag = { ...data, startX: e.clientX, startY: e.clientY, started: false, targetIdx: null }; };
  order.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const row = e.target.closest('.co-item');
    if (!row || e.target.closest('.co-x')) return;
    start(e, { mode: 'move', idx: +row.dataset.idx, el: row });
  });
  avail.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const row = e.target.closest('.ca-scene');
    if (!row || e.target.closest('.ca-add')) return;
    start(e, { mode: 'new', sceneId: row.dataset.sceneId, chapterId: row.dataset.chapterId, el: row });
  });
  document.addEventListener('mousemove', e => {
    if (!compDrag) return;
    if (!compDrag.started) {
      if (Math.abs(e.clientX - compDrag.startX) < 5 && Math.abs(e.clientY - compDrag.startY) < 5) return;
      compDrag.started = true;
      compDrag.el.classList.add('co-dragging');
    }
    e.preventDefault();
    $$('#compOrder .co-item').forEach(x => x.classList.remove('co-drop-before', 'co-drop-after'));
    const rows = $$('#compOrder .co-item');
    let ti = comp.items.length;
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { r.classList.add('co-drop-before'); ti = +r.dataset.idx; break; }
    }
    if (ti === comp.items.length && rows.length) rows[rows.length - 1].classList.add('co-drop-after');
    compDrag.targetIdx = ti;
  });
  document.addEventListener('mouseup', () => {
    if (!compDrag) return;
    const d = compDrag; compDrag = null;
    $$('#compOrder .co-item').forEach(x => x.classList.remove('co-drop-before', 'co-drop-after', 'co-dragging'));
    if (d.el) d.el.classList.remove('co-dragging');
    if (!d.started || d.targetIdx === null) return;
    if (d.mode === 'new') {
      const item = { id: uuid(), type: 'scene', sceneId: d.sceneId, chapterId: d.chapterId };
      comp.items.splice(d.targetIdx, 0, item);
    } else {
      let ti = d.targetIdx;
      const [moved] = comp.items.splice(d.idx, 1);
      if (ti > d.idx) ti -= 1;   // targetIdx counted the moved row, which is gone now
      comp.items.splice(ti, 0, moved);
    }
    renderComp();
  });
}

/* Every control is bound by its data-cs attribute to the comp.settings key of that name. */
function renderCompSettings() {
  const s = comp.settings;
  const host = $('#compSettingsBody');
  const opt = (v, t, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`;
  host.innerHTML =
    `<div class="cs-group">Formatting</div>
     <label class="field-label">Language</label>
     <select class="control" data-cs="language">${[['', 'Auto-detect'], ...NOVEL_LANGUAGES].map(([v, t]) => opt(v, t, s.language || '')).join('')}</select>
     <label class="field-label">Font</label>
     <select class="control" data-cs="font">
       ${COMP_FONT_OPTIONS.map(([v, t]) => opt(v, t, s.font)).join('')}
     </select>
     <div class="rf-row">
       <div class="rf-col"><label class="field-label">Font size</label><select class="control" data-cs="fontSize">${[10, 11, 12, 14].map(v => opt(v, v + 'pt', s.fontSize)).join('')}</select></div>
       <div class="rf-col"><label class="field-label">Line spacing</label><select class="control" data-cs="lineSpacing">${[[1, 'Single'], [1.5, '1.5'], [2, 'Double']].map(([v, t]) => opt(v, t, s.lineSpacing)).join('')}</select></div>
     </div>
     <div class="rf-row">
       <div class="rf-col"><label class="field-label">Alignment</label><select class="control" data-cs="align">${[['left', 'Left'], ['justify', 'Justified']].map(([v, t]) => opt(v, t, s.align)).join('')}</select></div>
       <div class="rf-col"><label class="field-label">First-line indent</label><select class="control" data-cs="indent">${[['none', 'None'], ['indent', '1.27 cm']].map(([v, t]) => opt(v, t, s.indent)).join('')}</select></div>
     </div>
     <label class="field-label">Paragraph spacing</label>
     <select class="control" data-cs="paraSpacing">${[['none', 'None'], ['space', '6pt after']].map(([v, t]) => opt(v, t, s.paraSpacing)).join('')}</select>

     <div class="cs-group">Content</div>
     <label class="field-label">Scene / chapter titles</label>
     <select class="control" data-cs="sceneTitles">${[['yes', 'Chapter + scene titles'], ['chapters', 'Only chapter titles'], ['no', 'No titles']].map(([v, t]) => opt(v, t, s.sceneTitles)).join('')}</select>
     <label class="toggle-row"><input type="checkbox" data-cs="includeParts"${s.includeParts ? ' checked' : ''}> <span>Include part dividers</span></label>
     <label class="field-label">Scene separator</label>
     <select class="control" data-cs="sceneSeparator">${[['***', '* * *'], ['blank', 'Blank line'], ['custom', 'Custom…']].map(([v, t]) => opt(v, t, s.sceneSeparator)).join('')}</select>
     ${s.sceneSeparator === 'custom' ? `<input type="text" class="control" data-cs="sceneSepCustom" value="${escAttr(s.sceneSepCustom || '')}" placeholder="Separator text">` : ''}
     <label class="field-label">Number chapters</label>
     <select class="control" data-cs="numberChapters">${[['arabic', 'Chapter 1'], ['plain', '1.'], ['none', 'None']].map(([v, t]) => opt(v, t, s.numberChapters)).join('')}</select>

     <div class="cs-group">Title page</div>
     <label class="toggle-row"><input type="checkbox" data-cs="titlePage"${s.titlePage ? ' checked' : ''}> <span>Include title page</span></label>
     <label class="field-label">Title</label><input type="text" class="control" data-cs="titleText" value="${escAttr(s.titleText || '')}">
     <label class="field-label">Subtitle</label><input type="text" class="control" data-cs="subtitle" value="${escAttr(s.subtitle || '')}">
     <label class="field-label">Author</label><input type="text" class="control" data-cs="author" value="${escAttr(s.author || '')}">
     <label class="field-label">Date</label><input type="text" class="control" data-cs="dateText" value="${escAttr(s.dateText || '')}" placeholder="e.g. 2026">

     <div class="cs-group">Table of contents</div>
     <label class="toggle-row"><input type="checkbox" data-cs="toc"${s.toc ? ' checked' : ''}> <span>Include table of contents</span></label>
     <label class="field-label">TOC depth</label>
     <select class="control" data-cs="tocDepth">${[['chapters', 'Chapters only'], ['scenes', 'Chapters + scenes']].map(([v, t]) => opt(v, t, s.tocDepth)).join('')}</select>
     <label class="field-label">TOC position</label>
     <select class="control" data-cs="tocPosition">${[['afterTitle', 'After title page'], ['end', 'End of document']].map(([v, t]) => opt(v, t, s.tocPosition)).join('')}</select>

     <div class="cs-group">Page (PDF)</div>
     <div class="rf-row">
       <div class="rf-col"><label class="field-label">Page size</label><select class="control" data-cs="pageSize">${[['A4', 'A4'], ['Letter', 'US Letter']].map(([v, t]) => opt(v, t, s.pageSize)).join('')}</select></div>
       <div class="rf-col"><label class="field-label">Margins</label><select class="control" data-cs="margins">${[['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']].map(([v, t]) => opt(v, t, s.margins)).join('')}</select></div>
     </div>
     <label class="field-label">Page numbering</label>
     <select class="control" data-cs="pageNumber">${[['none', 'None'], ['center', 'Bottom center'], ['right', 'Bottom right']].map(([v, t]) => opt(v, t, s.pageNumber)).join('')}</select>`;
  host.querySelectorAll('[data-cs]').forEach(el => {
    const key = el.dataset.cs;
    const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (['fontSize', 'lineSpacing', 'startPage'].includes(key)) v = parseFloat(v);
      if (key === 'language') {
        // The language belongs to the novel, not to this compile: write it back (null =
        // auto-detect) so it is saved with the file and the quick Export uses it too.
        v = v || null;
        if ((novel.settings.language || null) !== v) { novel.settings.language = v; markDirty(); }
      }
      s[key] = v;
      if (key === 'sceneSeparator') renderCompSettings();       // toggles the custom field
      if (compPreview) renderCompPreview();
      updateCompTotals();
    });
  });
}

/* ---- presets ---- */
function renderPresetSelect() {
  const sel = $('#compPreset');
  const presets = novel.settings.compilationPresets || [];
  sel.innerHTML = '<option value="__standard">Standard Manuscript</option>' +
    presets.map(p => `<option value="${escAttr(String(p.id))}">${esc(p.name)}</option>`).join('');
}
export function loadPreset(id) {
  // The language is the novel's own setting, not part of a preset: keep showing the novel's.
  const language = novel.settings.language || null;
  if (id === '__standard') { comp.settings = { ...defaultCompSettings(), titleText: comp.settings.titleText, author: comp.settings.author, subtitle: comp.settings.subtitle, language }; renderComp(); toast('Loaded Standard Manuscript'); return; }
  const p = (novel.settings.compilationPresets || []).find(x => x.id === id);
  if (p) { comp.settings = { ...defaultCompSettings(), ...p.settings, language }; renderComp(); toast('Loaded “' + p.name + '”'); }
}
function saveCompPreset() {
  promptModal('Save preset', 'Preset name:', '', name => {
    if (!name) return;
    novel.settings.compilationPresets = novel.settings.compilationPresets || [];
    const existing = novel.settings.compilationPresets.find(p => p.name === name);
    if (existing) existing.settings = { ...comp.settings };
    else novel.settings.compilationPresets.push({ id: uuid(), name, settings: { ...comp.settings } });
    markDirty(); renderPresetSelect();
    toast('Preset saved');
  });
}

export function init() {
  /* ---- compile wiring ---- */
  $('#btnCompile').addEventListener('click', openCompile);
  $('#compClose').addEventListener('click', closeCompile);
  $('#compileOverlay').addEventListener('mousedown', e => { if (e.target === $('#compileOverlay')) closeCompile(); });
  $('#compSearch').addEventListener('input', renderCompAvailable);
  $('#compAddPart').addEventListener('click', () => promptModal('Add part divider', 'Part title:', 'Part ' + (comp.items.filter(i => i.type === 'part').length + 1), v => { comp.items.push({ id: uuid(), type: 'part', title: v || 'Part' }); renderComp(); }));
  $('#compAddBreak').addEventListener('click', () => { comp.items.push({ id: uuid(), type: 'break' }); renderComp(); });
  $('#compRestore').addEventListener('click', () => { comp.items = buildDefaultOrder(); renderComp(); toast('Restored default order'); });
  $('#compClear').addEventListener('click', () => confirmModal('Clear all', 'Remove every item from the compilation order?', () => { comp.items = []; renderComp(); }));
  $('#compPreviewBtn').addEventListener('click', () => { compPreview = !compPreview; renderComp(); });
  $('#compPreset').addEventListener('change', e => loadPreset(e.target.value));
  $('#compSavePreset').addEventListener('click', saveCompPreset);
  $('#compExportBtn').addEventListener('click', e => { e.stopPropagation(); $('#compExportMenu').classList.toggle('open'); });
  document.addEventListener('click', () => $('#compExportMenu').classList.remove('open'));
  $('#compExportMenu').addEventListener('click', e => { const k = e.target.dataset.compExport; if (k) { $('#compExportMenu').classList.remove('open'); doCompExport(k); } });
}
