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
import { fmtNumber, t } from './i18n/index.js';

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
  if (!novel) { toast(t('compile.noNovel')); return; }
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
      row.innerHTML = `<span class="ca-t">🎬 ${esc(s.title)}</span><span class="ca-w">${s.wordCount || 0}</span><button class="ca-add" title="${escAttr(t('compile.addToCompilation'))}">＋</button>`;
      row.querySelector('.ca-add').onclick = e => { e.stopPropagation(); comp.items.push({ id: uuid(), type: 'scene', sceneId: s.id, chapterId: c.id }); renderComp(); };
      grp.appendChild(row);
    });
    host.appendChild(grp);
  });
  if (!host.children.length) host.innerHTML = `<div class="map-empty">${esc(t('compile.noScenesMatch'))}</div>`;
}

/* Rows carry their index into comp.items (data-idx); every change re-renders the list. */
function renderCompOrder() {
  const host = $('#compOrder');
  host.innerHTML = '';
  if (!comp.items.length) { host.innerHTML = `<div class="co-empty">${esc(t('compile.orderEmpty'))}</div>`; return; }
  comp.items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.dataset.idx = idx;
    if (it.type === 'part') {
      row.className = 'co-item co-part';
      row.innerHTML = `<span class="co-handle">⠿</span><span class="co-part-t">${esc(it.title || 'Part')}</span><button class="co-x" title="${escAttr(t('compile.remove'))}">✕</button>`;
      row.querySelector('.co-part-t').ondblclick = () => promptModal(t('compile.partTitle'), t('compile.partTitleText'), it.title, v => { it.title = v || it.title; renderComp(); });
    } else if (it.type === 'break') {
      row.className = 'co-item co-break';
      row.innerHTML = `<span class="co-handle">⠿</span><span class="co-break-t">${esc(t('compile.sectionBreak'))}</span><button class="co-x" title="${escAttr(t('compile.remove'))}">✕</button>`;
    } else {
      const f = findScene(it.sceneId);
      const words = f ? (f.scene.wordCount || 0) : 0;
      const ci = f ? novel.chapters.indexOf(f.chapter) + 1 : '?';
      row.className = 'co-item co-scene';
      row.innerHTML =
        `<span class="co-handle">⠿</span>
         <span class="co-title" title="${escAttr(t('compile.renameHint'))}">${esc(it.title || (f ? f.scene.title : t('compile.missing')))}</span>
         <span class="co-src">${esc(t('compile.fromChapter', { n: ci }))}</span>
         <span class="co-w">${words}</span>
         <button class="co-x" title="${escAttr(t('compile.removeFromCompilation'))}">✕</button>`;
      // it.title is an explicit override only; typing the scene's own title drops it again
      row.querySelector('.co-title').ondblclick = () => promptModal(t('compile.renameTitle'), t('compile.renameBody'), it.title || (f ? f.scene.title : ''), v => {
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
  $('#compTotal').textContent = t('compile.totalWords', { n: words, count: fmtNumber(words) });
  const pages = Math.max(1, Math.round(words / 300));   // ~300 words per manuscript page
  $('#compPages').textContent = t('compile.pages', { n: pages, count: fmtNumber(pages) });
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
  const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  // [value, label key] option lists, translated here at render time
  const opts = (list, cur) => list.map(([v, k]) => opt(v, t(k), cur)).join('');
  const L = k => esc(t(k));
  host.innerHTML =
    `<div class="cs-group">${L('compile.groupFormatting')}</div>
     <label class="field-label">${L('compile.language')}</label>
     <select class="control" data-cs="language">${[['', t('compile.autoDetect')], ...NOVEL_LANGUAGES].map(([v, label]) => opt(v, label, s.language || '')).join('')}</select>
     <label class="field-label">${L('compile.font')}</label>
     <select class="control" data-cs="font">
       ${COMP_FONT_OPTIONS.map(([v, label]) => opt(v, label, s.font)).join('')}
     </select>
     <div class="rf-row">
       <div class="rf-col"><label class="field-label">${L('compile.fontSize')}</label><select class="control" data-cs="fontSize">${[10, 11, 12, 14].map(v => opt(v, t('compile.pointSize', { n: v }), s.fontSize)).join('')}</select></div>
       <div class="rf-col"><label class="field-label">${L('compile.lineSpacing')}</label><select class="control" data-cs="lineSpacing">${[[1, t('compile.spacingSingle')], [1.5, '1.5'], [2, t('compile.spacingDouble')]].map(([v, label]) => opt(v, label, s.lineSpacing)).join('')}</select></div>
     </div>
     <div class="rf-row">
       <div class="rf-col"><label class="field-label">${L('compile.alignment')}</label><select class="control" data-cs="align">${opts([['left', 'compile.alignLeft'], ['justify', 'compile.alignJustify']], s.align)}</select></div>
       <div class="rf-col"><label class="field-label">${L('compile.firstLineIndent')}</label><select class="control" data-cs="indent">${opts([['none', 'compile.none'], ['indent', 'compile.indentSize']], s.indent)}</select></div>
     </div>
     <label class="field-label">${L('compile.paraSpacing')}</label>
     <select class="control" data-cs="paraSpacing">${opts([['none', 'compile.none'], ['space', 'compile.paraSpacingAfter']], s.paraSpacing)}</select>

     <div class="cs-group">${L('compile.groupContent')}</div>
     <label class="field-label">${L('compile.sceneChapterTitles')}</label>
     <select class="control" data-cs="sceneTitles">${opts([['yes', 'compile.titlesBoth'], ['chapters', 'compile.titlesChapters'], ['no', 'compile.titlesNone']], s.sceneTitles)}</select>
     <label class="toggle-row"><input type="checkbox" data-cs="includeParts"${s.includeParts ? ' checked' : ''}> <span>${L('compile.includeParts')}</span></label>
     <label class="field-label">${L('compile.sceneSeparator')}</label>
     <select class="control" data-cs="sceneSeparator">${[['***', '* * *'], ['blank', t('compile.sepBlank')], ['custom', t('compile.sepCustom')]].map(([v, label]) => opt(v, label, s.sceneSeparator)).join('')}</select>
     ${s.sceneSeparator === 'custom' ? `<input type="text" class="control" data-cs="sceneSepCustom" value="${escAttr(s.sceneSepCustom || '')}" placeholder="${escAttr(t('compile.sepCustomPlaceholder'))}">` : ''}
     <label class="field-label">${L('compile.numberChapters')}</label>
     <select class="control" data-cs="numberChapters">${[['arabic', t('compile.numberArabic')], ['plain', '1.'], ['none', t('compile.none')]].map(([v, label]) => opt(v, label, s.numberChapters)).join('')}</select>

     <div class="cs-group">${L('compile.groupTitlePage')}</div>
     <label class="toggle-row"><input type="checkbox" data-cs="titlePage"${s.titlePage ? ' checked' : ''}> <span>${L('compile.includeTitlePage')}</span></label>
     <label class="field-label">${L('compile.title')}</label><input type="text" class="control" data-cs="titleText" value="${escAttr(s.titleText || '')}">
     <label class="field-label">${L('compile.subtitle')}</label><input type="text" class="control" data-cs="subtitle" value="${escAttr(s.subtitle || '')}">
     <label class="field-label">${L('compile.author')}</label><input type="text" class="control" data-cs="author" value="${escAttr(s.author || '')}">
     <label class="field-label">${L('compile.date')}</label><input type="text" class="control" data-cs="dateText" value="${escAttr(s.dateText || '')}" placeholder="${escAttr(t('compile.datePlaceholder'))}">

     <div class="cs-group">${L('compile.groupToc')}</div>
     <label class="toggle-row"><input type="checkbox" data-cs="toc"${s.toc ? ' checked' : ''}> <span>${L('compile.includeToc')}</span></label>
     <label class="field-label">${L('compile.tocDepth')}</label>
     <select class="control" data-cs="tocDepth">${opts([['chapters', 'compile.tocChapters'], ['scenes', 'compile.tocScenes']], s.tocDepth)}</select>
     <label class="field-label">${L('compile.tocPosition')}</label>
     <select class="control" data-cs="tocPosition">${opts([['afterTitle', 'compile.tocAfterTitle'], ['end', 'compile.tocEnd']], s.tocPosition)}</select>

     <div class="cs-group">${L('compile.groupPage')}</div>
     <div class="rf-row">
       <div class="rf-col"><label class="field-label">${L('compile.pageSize')}</label><select class="control" data-cs="pageSize">${[['A4', 'A4'], ['Letter', t('compile.usLetter')]].map(([v, label]) => opt(v, label, s.pageSize)).join('')}</select></div>
       <div class="rf-col"><label class="field-label">${L('compile.margins')}</label><select class="control" data-cs="margins">${opts([['narrow', 'compile.marginsNarrow'], ['normal', 'compile.marginsNormal'], ['wide', 'compile.marginsWide']], s.margins)}</select></div>
     </div>
     <label class="field-label">${L('compile.pageNumbering')}</label>
     <select class="control" data-cs="pageNumber">${opts([['none', 'compile.none'], ['center', 'compile.pageNumCenter'], ['right', 'compile.pageNumRight']], s.pageNumber)}</select>`;
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
  sel.innerHTML = `<option value="__standard">${esc(t('compile.standardPreset'))}</option>` +
    presets.map(p => `<option value="${escAttr(String(p.id))}">${esc(p.name)}</option>`).join('');
}
export function loadPreset(id) {
  // The language is the novel's own setting, not part of a preset: keep showing the novel's.
  const language = novel.settings.language || null;
  if (id === '__standard') { comp.settings = { ...defaultCompSettings(), titleText: comp.settings.titleText, author: comp.settings.author, subtitle: comp.settings.subtitle, language }; renderComp(); toast(t('compile.loadedStandard')); return; }
  const p = (novel.settings.compilationPresets || []).find(x => x.id === id);
  if (p) { comp.settings = { ...defaultCompSettings(), ...p.settings, language }; renderComp(); toast(t('compile.loadedNamedPreset', { name: p.name })); }
}
function saveCompPreset() {
  promptModal(t('compile.savePresetTitle'), t('compile.presetName'), '', name => {
    if (!name) return;
    novel.settings.compilationPresets = novel.settings.compilationPresets || [];
    const existing = novel.settings.compilationPresets.find(p => p.name === name);
    if (existing) existing.settings = { ...comp.settings };
    else novel.settings.compilationPresets.push({ id: uuid(), name, settings: { ...comp.settings } });
    markDirty(); renderPresetSelect();
    toast(t('compile.presetSaved'));
  });
}

export function init() {
  /* ---- compile wiring ---- */
  $('#btnCompile').addEventListener('click', openCompile);
  $('#compClose').addEventListener('click', closeCompile);
  $('#compileOverlay').addEventListener('mousedown', e => { if (e.target === $('#compileOverlay')) closeCompile(); });
  $('#compSearch').addEventListener('input', renderCompAvailable);
  $('#compAddPart').addEventListener('click', () => promptModal(t('compile.addPartTitle'), t('compile.addPartBody'), 'Part ' + (comp.items.filter(i => i.type === 'part').length + 1), v => { comp.items.push({ id: uuid(), type: 'part', title: v || 'Part' }); renderComp(); }));
  $('#compAddBreak').addEventListener('click', () => { comp.items.push({ id: uuid(), type: 'break' }); renderComp(); });
  $('#compRestore').addEventListener('click', () => { comp.items = buildDefaultOrder(); renderComp(); toast(t('compile.restoredOrder')); });
  $('#compClear').addEventListener('click', () => confirmModal(t('compile.clearAllTitle'), t('compile.clearAllBody'), () => { comp.items = []; renderComp(); }));
  $('#compPreviewBtn').addEventListener('click', () => { compPreview = !compPreview; renderComp(); });
  $('#compPreset').addEventListener('change', e => loadPreset(e.target.value));
  $('#compSavePreset').addEventListener('click', saveCompPreset);
  $('#compExportBtn').addEventListener('click', e => { e.stopPropagation(); $('#compExportMenu').classList.toggle('open'); });
  document.addEventListener('click', () => $('#compExportMenu').classList.remove('open'));
  $('#compExportMenu').addEventListener('click', e => { const k = e.target.dataset.compExport; if (k) { $('#compExportMenu').classList.remove('open'); doCompExport(k); } });
}
