/* Character relationship graph, drawn on a canvas. */
import { $, $$ } from './dom.js';
import { esc, escAttr, uuid } from './lib/text.js';
import { novel } from './state.js';
import { markDirty } from './dirty.js';
import { fillSelect } from './tree.js';
import { safeColor } from './novel-file.js';
import { ENTITY_DEFS, renderEntities } from './entities.js';
import { ctx, ctxItem, showCtx } from './context-menu.js';
import { confirmModal, promptModal, toast } from './dialogs.js';

const REL_TYPES = [
  ['family', 'Family', '#e74c3c'], ['friend', 'Friend', '#2ecc71'], ['enemy', 'Enemy', '#e67e22'],
  ['romance', 'Romance', '#e91e63'], ['colleague', 'Colleague', '#3498db'], ['mentor', 'Mentor', '#9b59b6'],
  ['rival', 'Rival', '#d35400'], ['custom', 'Custom', '#c9a96e']
];
const REL_STATUS = [['active', 'Active'], ['past', 'Past'], ['secret', 'Secret'], ['oneSided', 'One-sided']];
function relColor(t) { const r = REL_TYPES.find(x => x[0] === t); return r ? r[2] : '#c9a96e'; }
function relTypeName(t) { const r = REL_TYPES.find(x => x[0] === t); return r ? r[1] : 'Custom'; }

/* Coordinates: character.graphPosition {x,y} (saved in the .novel) is in world units, CSS px at
   zoom 1 around an arbitrary origin. gView maps world to canvas CSS px: screen = world*zoom + (x,y)
   (w2s/s2w). The DPR scaling of the backing store is set in gResize, so all drawing and
   hit-testing works in CSS px relative to the canvas.
   Relationships are directed: each lives on its source character's `relationships[]` and names
   the other end by targetCharacterId. */
export let graphOpen = false;
let gEventsInit = false;
let gCanvas = null, gCtx = null;
let gView = { x: 0, y: 0, zoom: 1 };
let gDragNode = null, gPanning = false, gLast = null, gMoved = false;   // gMoved: drag vs click on mouseup
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
/* Seed missing positions on a jittered 220-unit circle; this writes to the novel, hence markDirty. */
function ensureGraphPositions() {
  const chars = novel.characters;
  const n = chars.length;
  let changed = false;
  chars.forEach((c, i) => {
    if (!c.graphPosition || typeof c.graphPosition.x !== 'number') {
      const ang = (i / Math.max(1, n)) * Math.PI * 2;
      c.graphPosition = { x: Math.cos(ang) * 220 + (Math.random() * 40 - 20), y: Math.sin(ang) * 220 + (Math.random() * 40 - 20) };
      changed = true;
    }
  });
  if (changed) markDirty();
}
function w2s(x, y) { return { x: x * gView.zoom + gView.x, y: y * gView.zoom + gView.y }; }
function s2w(x, y) { return { x: (x - gView.x) / gView.zoom, y: (y - gView.y) / gView.zoom }; }

export function openGraph() {
  if (!novel) return;
  graphOpen = true;
  $('#graphOverlay').classList.remove('hidden');
  gCanvas = $('#graphCanvas');
  gCtx = gCanvas.getContext('2d');
  if (!gEventsInit) { initGraphEvents(); gEventsInit = true; }   // once; window handlers bail while closed
  ensureGraphPositions();
  fillSelect($('#graphFilter'), [['all', 'Show All'], ['main', 'Main Characters Only'], ['withrel', 'With Relationships'], ['withoutrel', 'Without Relationships']], gFilter);
  renderLegend();
  gSelected = null; gPanelRel = null;
  $('#graphPanel').classList.add('hidden');
  requestAnimationFrame(() => { gResize(); gCenterView(); });
}
export function closeGraph() {
  graphOpen = false;
  $('#graphOverlay').classList.add('hidden');
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
export function drawGraph() {
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
function drawGrid(W, H) {   // a dot every 50 world units, anchored to the world origin
  const step = 50 * gView.zoom;
  if (step < 12) return;
  const ox = gView.x % step, oy = gView.y % step;
  gCtx.fillStyle = '#2a2a35';
  for (let x = ox; x < W; x += step) for (let y = oy; y < H; y += step) { gCtx.beginPath(); gCtx.arc(x, y, 1, 0, Math.PI * 2); gCtx.fill(); }
}
function edgeDash(rel) {   // status wins over strength (1-10); lengths in world units
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
  // stop at the target's rim so a one-sided arrow tip touches the node instead of hiding under it
  const rt = nodeRadius(e.tgt) * gView.zoom;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const ex = b.x - Math.cos(ang) * rt, ey = b.y - Math.sin(ang) * rt;
  gCtx.beginPath(); gCtx.moveTo(a.x, a.y); gCtx.lineTo(ex, ey); gCtx.stroke();
  gCtx.setLineDash([]);
  if (e.rel.status === 'oneSided' && !faded) { drawArrow(ex, ey, ang, gCtx.strokeStyle); }
  // subtype label: only when hovered or zoomed in enough to read it
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
  // role glyph inside the node
  gCtx.fillStyle = '#1a1a1f'; gCtx.font = (13 * gView.zoom) + 'px sans-serif'; gCtx.textAlign = 'center'; gCtx.textBaseline = 'middle';
  gCtx.fillText(roleBadge(ch), p.x, p.y);
  // name: fixed 14px at every zoom so it stays legible
  gCtx.globalAlpha = faded ? 0.3 : 1;
  gCtx.fillStyle = '#ffffff'; gCtx.font = '14px Inter, sans-serif'; gCtx.textBaseline = 'top';
  gCtx.fillText(ch.name || '(unnamed)', p.x, p.y + r + 4);
  gCtx.restore();
}
function nodeAt(sx, sy) {   // screen coords; last-drawn (topmost) node wins
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
export function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* ---- graph interactions ----
   mousedown on a node starts a node drag, anywhere else a pan. On mouseup without movement the
   node drag becomes a click (toggle selection) and the pan becomes a background click, which is
   where edge clicks are detected. move/up listen on window so a drag can leave the canvas. */
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
  // zoom about the cursor: keep the world point under it fixed. passive:false so preventDefault works.
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
    showCtx(Math.min(e.clientX, innerWidth - 190), e.clientY);
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
export function openCharPanel(ch) {
  const panel = $('#graphPanel');
  panel.classList.remove('hidden');
  const rels = (ch.relationships || []).map(r => {
    const t = novel.characters.find(c => c.id === r.targetCharacterId);
    return `<li><span class="gp-reldot" style="background:${relColor(r.type)}"></span>${esc(r.subtype || relTypeName(r.type))} → ${esc(t ? (t.name || '(unnamed)') : '?')}</li>`;
  }).join('') || '<li class="gp-empty">No relationships yet</li>';
  panel.innerHTML =
    `<div class="gp-head">Character<button class="gp-x" id="gpClose">✕</button></div>
     <label class="field-label">Name</label>
     <input type="text" id="gcName" class="control" value="${escAttr(ch.name || '')}" />
     <label class="field-label">Role</label>
     <select id="gcRole" class="control"></select>
     <label class="field-label">Node colour</label>
     <input type="color" id="gcColor" class="nt-color" value="${safeColor(ch.color, '#c9a96e')}" />
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
/* Relies on #charList rendering one .entity per character in novel.characters order. */
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
/* Simple O(n²) spring embedder over the visible characters: 120 rounds of inverse-square
   repulsion (cooling 1% a round) plus springs pulling linked pairs toward 160 world units,
   stiffer for stronger relationships. Results go to the transient `_target` that animateTo tweens to. */
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
/* 900ms ease-out tween of graphPosition toward each `_target` (characters without one stay put),
   then deletes `_target` (not part of the file format) and re-centres the view. */
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

export function renderLegend() {
  const body = $('#legendBody');
  body.innerHTML = REL_TYPES.map(t => `<div class="lg-row"><span class="lg-line" style="background:${t[2]}"></span>${t[1]}</div>`).join('');
}

function exportGraphPng() {
  if (!gCanvas) return;
  const url = gCanvas.toDataURL('image/png');
  const name = (novel.title || 'novel') + '-graph.png';
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  toast('Graph exported (' + name + ')');
}

export function init() {
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
  // the layout select is an action menu: run the layout, then show 'manual' again so it can be re-picked
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
}
