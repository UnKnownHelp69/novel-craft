/* World map, drawn on a canvas: location pins, drawing layers and travel routes. */
import { $, $$ } from './dom.js';
import { esc, escAttr, uuid } from './lib/text.js';
import { novel } from './state.js';
import { markDirty } from './dirty.js';
import { fillSelect } from './tree.js';
import { ctx, ctxItem, showCtx } from './context-menu.js';
import { confirmModal, promptModal, toast } from './dialogs.js';
import { distToSeg } from './graph.js';

/* Three coordinate spaces:
   - relative: pin positions in novel.settings.worldMap.locations[id] = { x, y } in 0..1 of the
     image, so pins stay put if the background image is replaced by one of another size;
   - world: image pixels (relative × mapImageSize()); drawing points are stored in these;
   - screen: CSS pixels from the canvas's top-left (mouse coords, everything mCtx draws).
   screen = world × mView.zoom + (mView.x, mView.y); see mw2s / ms2w. */
const LOC_TYPE_COLOR = { city: '#4a90d9', building: '#c9a96e', natural: '#5cb85c', other: '#8f887c' };
function locColor(l) { return LOC_TYPE_COLOR[l.type] || '#8f887c'; }

export let mapOpen = false;
let mapEventsInit = false;
let mCanvas = null, mCtx = null;
let mView = { x: 0, y: 0, zoom: 1 };
let mImg = null;
let mDragPin = null, mPanning = false, mLast = null, mMoved = false;
let mActiveLayerId = '';           // '' = pin/pan mode; else a custom layer id -> drawing mode
let mDrawTool = 'pen', mDrawColor = '#c9a96e';
let mDrawing = null;               // shape being drawn, pushed to the active layer on mouseup
let mLocSearch = '';
export let mRouteMode = null;             // { fromId } while placing a route; fromId null = source not picked yet

function worldMap() { return novel && novel.settings && novel.settings.worldMap; }
/* World-space size. imageW/imageH are saved with the file so pins land correctly while the
   data-URL image is still decoding. */
function mapImageSize() {
  const wm = worldMap();
  if (mImg && mImg.complete && mImg.naturalWidth) return { w: mImg.naturalWidth, h: mImg.naturalHeight };
  if (wm && wm.imageW) return { w: wm.imageW, h: wm.imageH };
  return { w: 1200, h: 800 };      // virtual canvas when no image is uploaded
}
function mw2s(x, y) { return { x: x * mView.zoom + mView.x, y: y * mView.zoom + mView.y }; }
function ms2w(x, y) { return { x: (x - mView.x) / mView.zoom, y: (y - mView.y) / mView.zoom }; }
function locRel(l) { const wm = worldMap(); return wm.locations[l.id] || null; }
/* Returns { x, y } in that key order: callers spread it with mw2s(...Object.values(locWorld(l))). */
function locWorld(l) { const sz = mapImageSize(); const p = locRel(l); const rx = p ? p.x : 0.5, ry = p ? p.y : 0.5; return { x: rx * sz.w, y: ry * sz.h }; }
function placedLocs() { const wm = worldMap(); return novel.locations.filter(l => wm.locations[l.id]); }
/* Pin head radius in screen px: follows zoom but clamped so pins stay clickable when zoomed
   out and don't swamp the map when zoomed in. drawPins, pinAt and drawRoutes share it. */
function pinScreenR() { return Math.max(9, Math.min(20, 13 * mView.zoom)); }

export function openMap() {
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
export function closeMap() {
  mapOpen = false;
  cancelRouteMode();
  $('#mapOverlay').classList.add('hidden');
}
function loadMapImage() {
  const wm = worldMap();
  if (wm.backgroundImage) {
    mImg = new Image();
    mImg.onload = () => { wm.imageW = mImg.naturalWidth; wm.imageH = mImg.naturalHeight; mapDraw(); };
    mImg.src = wm.backgroundImage;
  } else { mImg = null; }
}
/* The backing store is devicePixelRatio× the CSS size for crisp lines, and the dpr transform
   lets every draw call work in CSS px — so layout math uses clientWidth/clientHeight,
   never canvas.width/height. */
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
/* Zoom about the viewport centre: re-pan so the world point under it stays under it
   (the wheel handler does the same about the cursor). */
function mapZoomBy(factor) {
  const W = mCanvas.clientWidth / 2, H = mCanvas.clientHeight / 2;
  const before = ms2w(W, H);
  mView.zoom = Math.max(0.05, Math.min(6, mView.zoom * factor));
  const after = mw2s(before.x, before.y);
  mView.x += W - after.x; mView.y += H - after.y;
  updateMapZoom(); mapDraw();
}

/* ---- drawing the map ---- */
/* Paint order (bottom to top): background, custom layers, shape in progress, routes, pins.
   With the background layer hidden or the image not loaded, the map bounds are outlined. */
export function mapDraw() {
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
/* A pin is a teardrop whose tip sits on the location point; its head is a circle of radius r
   centred 1.5r above it. The label hangs below the tip. */
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
/* Hit-test in screen px: the head circle (+2 px slack) or the box between head centre and tip.
   Walks backwards so the pin drawn last (on top) wins. */
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
/* Drawing format (layer.drawings[]): { tool, color, width, points: [{x, y}] in world px, text? }.
   pen = polyline through all points; line/rect/circle = [start, end] (circle is the ellipse
   inscribed in their bounding box); text = [anchor]. Width and text size are world units, so
   they scale with zoom (with a screen-px floor). */
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
/* The image is embedded in the .novel file as a base64 data URL (~4/3 of its size), hence the
   size cap. SVG is safe here: drawn through an <img>/Image() it runs no scripts. */
async function uploadMapImage() {
  const wm = worldMap();
  const apply = dataUrl => {
    wm.backgroundImage = dataUrl;
    loadMapImage();
    markDirty();
    setTimeout(() => mapFit(), 60);   // give the new image a moment to decode so the fit uses its size
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
    // locColor() only returns constants from LOC_TYPE_COLOR, so it is safe unescaped in style=
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
    // drop at the view centre, clamped onto the image
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
  // spread them over a near-square grid inset from the image edges
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
  // a route needs both ends on the map, so routes touching this pin go with it
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
  // Position in stage px (= canvas screen px; the canvas fills the stage) beside the pin,
  // flipped/clamped to stay inside. Unhide first: offsetWidth/Height are 0 while hidden.
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
  // #locList renders one .entity per location in novel.locations order
  const wrap = $$('#locList .entity')[novel.locations.findIndex(l => l.id === id)];
  if (wrap) { wrap.classList.add('open'); wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

/* ---- layers ---- */
/* Base layers are fixed visibility toggles (wm.baseLayers); custom layers (wm.layers) hold
   drawings, and selecting one to draw on switches the canvas from pin/pan to drawing mode. */
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
    wm.layers.map(l => `<option value="${escAttr(String(l.id))}">${esc(l.name)}</option>`).join('');
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
/* Deletes whole drawings with a stored point within 10 screen px of world point w. Only stored
   points count: a line/rect/circle is hit only near its two stored points, not along its outline. */
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
/* mousedown precedence: an active drawing layer → draw; route mode → pick pins; else drag a pin
   or pan. Move/up listen on window so a drag continues outside the canvas. mMoved tells a
   click from a drag: a pin click opens its card, a click off pins edits the route under it, if any. */
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
      else mDrawing.points[1] = w;   // shapes keep only [start, current]
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
      // a click without movement leaves no second point: discard it
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
    showCtx(Math.min(e.clientX, innerWidth - 200), e.clientY);
  });
}

/* ---- export PNG ---- */
/* Exports the canvas as it is on screen (current pan/zoom, at devicePixelRatio resolution),
   not the whole map at image resolution. */
function exportMapPng() {
  if (!mCanvas) return;
  const url = mCanvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = (novel.title || 'novel') + '-map.png'; a.click();
  toast('Map exported as PNG');
}

/* ---- travel routes: rendering ---- */
/* A route is a quadratic curve between the two pin tips, its control point 22 screen px off
   the midpoint, perpendicular to A→B, so routes A→B and B→A bow apart instead of overlapping.
   The one-way arrow and the name sit at the control point. */
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
    // free-text terrain mentioning a secret/passage draws dashed
    mCtx.setLineDash(rt.terrain && /secret|passage/i.test(rt.terrain) ? [6, 6] : []);
    // same control point as routeControl(), which routeAt hit-tests against: keep them in sync
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
    const nx = -(pb.y - pa.y), ny = (pb.x - pa.x);
    const len = Math.hypot(nx, ny) || 1;
    const cx = mx + (nx / len) * 22, cy = my + (ny / len) * 22;
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
  if (mRouteMode) {   // ring around the chosen source pin's head
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
// Declared here but read by mapDraw/mousemove above; those only run once the map is open.
let mHoverRoute = null;
let routeEditing = null, routeCharSel = null;   // routeCharSel: character picks, committed on Save

/* Control point (screen px) of a route's curve, for hit-testing; drawRoutes inlines the same math. */
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
/* Hit-test in screen px: flatten each Bézier into 12 segments, accept within 7 px. Topmost
   (last drawn) route wins; hidden routes can't be hit. */
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
/* Route mode from the toolbar: two clicks (source, then destination). startRouteFrom (pin card /
   context menu) already knows the source. Either way drawing mode is switched off. */
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
export function cancelRouteMode() { mRouteMode = null; updateMapHint(); }
export function updateMapHint() {
  const el = $('#mapHint');
  if (!el) return;
  if (!mRouteMode) { el.classList.add('hidden'); return; }
  el.textContent = mRouteMode.fromId === null
    ? 'Add Route: click the first location  (Esc to cancel)'
    : 'Add Route: click the destination location  (Esc to cancel)';
  el.classList.remove('hidden');
}

/* ---- route details editor ---- */
/* Edits rt in place, but only on Save; Close discards. From/To offer only placed locations. */
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
export function closeRouteEditor() { routeEditing = null; $('#routeOverlay').classList.add('hidden'); }
function deleteRoute(rt) {
  confirmModal('Delete route', 'Delete this route?', () => {
    const wm = worldMap();
    wm.routes = wm.routes.filter(r => r.id !== rt.id);
    markDirty(); closeRouteEditor(); mapDraw();
    toast('Route deleted');
  });
}

export function init() {
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
}
