/* The shared modal (confirm / prompt) and toasts. */
import { $ } from './dom.js';

/* One shared dialog: opening it replaces any pending callback. Cancel runs no callback, so a
   caller that must hear about Cancel listens on #modalCancel itself (see checkRecovery). */
let modalCb = null;
export function confirmModal(title, body, onOk) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modalInput').classList.add('hidden');
  modalCb = () => onOk();
  $('#modalOverlay').classList.remove('hidden');
}
export function promptModal(title, body, value, onOk) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  const inp = $('#modalInput');
  inp.classList.remove('hidden');
  inp.value = value || '';
  modalCb = () => onOk(inp.value);
  $('#modalOverlay').classList.remove('hidden');
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
}

/* ---- toasts ---- */
export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toastHost').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));   // a frame later, so the .toast transition runs
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);   // after the .2s fade-out in styles.css
  }, 2200);
}

/* A toast with one action button (e.g. Undo). It stays longer than a plain toast, and the
   action runs at most once, only while the toast is up. Returns a function that dismisses it. */
export function toastAction(msg, label, onAction, ms = 8000) {
  const t = document.createElement('div');
  t.className = 'toast toast-action';
  const text = document.createElement('span');
  text.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-btn';
  btn.textContent = label;
  let live = true;
  const dismiss = () => { live = false; t.classList.remove('show'); setTimeout(() => t.remove(), 250); };
  btn.addEventListener('click', () => { if (!live) return; dismiss(); onAction(); });
  t.append(text, btn);
  $('#toastHost').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { if (live) dismiss(); }, ms);
  return () => { if (live) dismiss(); };
}

export function init() {
  $('#modalOk').addEventListener('click', () => {
    $('#modalOverlay').classList.add('hidden');
    if (modalCb) modalCb();
    modalCb = null;
  });
  $('#modalCancel').addEventListener('click', () => {
    $('#modalOverlay').classList.add('hidden');
    modalCb = null;
  });
  $('#modalOverlay').addEventListener('mousedown', e => { if (e.target === e.currentTarget) e.preventDefault(); });   // keep focus in the field
  $('#modalInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#modalOk').click();
  });
}
