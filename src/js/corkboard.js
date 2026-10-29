/* Corkboard: the scenes of a chapter as index cards, filtered, sorted and reordered by drag. */
import { $, $$ } from './dom.js';
import { esc } from './lib/text.js';
import { currentSceneId, novel } from './state.js';
import { markDirty } from './dirty.js';
import {
  addScene, deleteScene, fillSelect, findChapter, findScene, renameScene, renderTree,
  saveCurrentScene, SCENE_STATUS, selectScene, statusMeta, TIME_OF_DAY, timeMeta,
  updateSceneMeta
} from './tree.js';
import { toast } from './dialogs.js';
import { fmtNoteDate } from './notes.js';

export let corkboardOpen = false;
let corkZoomLevel = 1;          // 0 = small, 1 = medium, 2 = large
let corkFilterStatus = 'all';
let corkFilterPov = '';
let corkSort = 'order';         // display only; drops always edit the real scene order
let corkDrag = null;
let suppressCorkClick = false;  // swallows the click that follows a drop

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
export function closeCorkboard() {
  corkboardOpen = false;
  document.body.classList.remove('corkboard-mode');
  $('#corkboard').classList.add('hidden');
  $('#btnCorkboard').classList.remove('active');
}
export function toggleCorkboard() { corkboardOpen ? closeCorkboard() : openCorkboard(); }

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
export function renderCorkboard() {
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
  // tilt of -1..+0.9deg from the id, so a card keeps its angle across re-renders
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
  // A single click opens the scene only after 230ms, so a double-click on the title can
  // rename it instead of leaving the corkboard.
  let clickTimer = null;
  card.querySelector('.cc-badge').onclick = e => { e.stopPropagation(); cycleStatus(s); };
  card.querySelector('.cc-edit').onclick = e => { e.stopPropagation(); selectScene(s.id); closeCorkboard(); };
  card.querySelector('.cc-del').onclick = e => { e.stopPropagation(); deleteScene(s.id); };
  card.querySelector('.cc-title').ondblclick = e => { e.stopPropagation(); if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } renameScene(s.id); };
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
/* Indices are into chapter.scenes (the real order), whatever sort/filter the board shows.
   Invariant: a chapter always keeps at least one scene. */
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

export function init() {
  /* Corkboard card drag: mouse events, not the HTML5 Drag API (unreliable in the webview, see
     chapter reordering). A 6px threshold separates a click from a drag. Dropping on a card inserts
     before/after it by which half is under the pointer; dropping elsewhere in a chapter's row
     appends to that chapter. */
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
  /* corkboard toolbar wiring */
  $('#btnCorkboard').addEventListener('click', toggleCorkboard);
  $('#corkBack').addEventListener('click', closeCorkboard);
  $('#corkZoom').addEventListener('input', e => { corkZoomLevel = +e.target.value; renderCorkboard(); });
  $('#corkStatus').addEventListener('change', e => { corkFilterStatus = e.target.value; renderCorkboard(); });
  $('#corkPov').addEventListener('change', e => { corkFilterPov = e.target.value; renderCorkboard(); });
  $('#corkSort').addEventListener('change', e => { corkSort = e.target.value; renderCorkboard(); });
}
