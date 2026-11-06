/* Context menus. showCtx() places every one in the app (tree, graph, map); the tree's
   scene/chapter menu is built here. */
import { $, chapterList } from './dom.js';
import { novel } from './state.js';
import {
  addScene, deleteChapter, deleteScene, duplicateChapter, duplicateScene, moveSceneToChapter,
  renameChapter, renameScene, setAllCollapsed
} from './tree.js';
import { esc } from './lib/text.js';
import { t } from './i18n/index.js';

export const ctx = $('#ctxMenu');
function hideCtx() { ctx.classList.add('hidden'); ctx.innerHTML = ''; }
export function ctxItem(label, handler, cls) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', () => { hideCtx(); handler(); });
  return b;
}
/* Show the menu at (x, y), or above y when it would run off the bottom of the window. A "▸"
   submenu opens to the right of the menu, or to the left when it would run off the window
   there, and moves up as far as it would run off the bottom. */
export function showCtx(x, y) {
  ctx.style.left = x + 'px';
  ctx.classList.remove('hidden');
  const h = ctx.offsetHeight;
  ctx.style.top = (y + h > innerHeight ? Math.max(0, y - h) : y) + 'px';
  const right = ctx.getBoundingClientRect().right;
  ctx.querySelectorAll('.ctx-sub-menu').forEach(list => {
    list.style.display = 'flex';   // shown only on hover: lay it out once to measure it
    list.parentElement.classList.toggle('ctx-sub-left', right + list.offsetWidth > innerWidth);
    list.style.top = Math.min(0, innerHeight - list.getBoundingClientRect().bottom) + 'px';
    list.style.display = '';
    // hover intent: a pointer heading for an item further down cuts across the menu for a moment,
    // so the submenu closes a little after the pointer leaves it, not at once
    const sub = list.parentElement;
    let closing = null;
    sub.addEventListener('pointerenter', () => { clearTimeout(closing); sub.classList.add('open'); });
    sub.addEventListener('pointerleave', () => { closing = setTimeout(() => sub.classList.remove('open'), 300); });
  });
}

export function init() {
  chapterList.addEventListener('contextmenu', e => {
    const sceneEl = e.target.closest('.tree-scene');
    const chapRow = e.target.closest('.tc-row');
    if (!sceneEl && !chapRow) return;
    e.preventDefault();
    ctx.innerHTML = '';
    if (sceneEl) {
      const id = sceneEl.dataset.sceneId;
      ctx.appendChild(ctxItem(t('common.rename'), () => renameScene(id)));
      ctx.appendChild(ctxItem(t('ctx.duplicate'), () => duplicateScene(id)));
      ctx.appendChild(ctxItem(t('common.delete'), () => deleteScene(id), 'danger'));
      const others = novel.chapters.filter(c => !(c.scenes || []).some(s => s.id === id));
      if (others.length) {
        const sub = document.createElement('div');
        sub.className = 'ctx-sub';
        sub.innerHTML = `<button class="ctx-sub-head">${esc(t('ctx.moveToChapter'))} ▸</button>`;
        const list = document.createElement('div');
        list.className = 'ctx-sub-menu';
        others.forEach(c => list.appendChild(ctxItem(c.title, () => moveSceneToChapter(id, c.id))));
        sub.appendChild(list);
        ctx.appendChild(sub);
      }
    } else {
      const id = chapRow.dataset.chapterId;
      ctx.appendChild(ctxItem(t('common.rename'), () => renameChapter(id)));
      ctx.appendChild(ctxItem(t('ctx.duplicate'), () => duplicateChapter(id)));
      ctx.appendChild(ctxItem(t('ctx.addScene'), () => addScene(id)));
      ctx.appendChild(ctxItem(t('common.delete'), () => deleteChapter(id), 'danger'));
      ctx.appendChild(ctxItem(t('ctx.collapseAll'), () => setAllCollapsed(true)));
      ctx.appendChild(ctxItem(t('ctx.expandAll'), () => setAllCollapsed(false)));
    }
    showCtx(Math.min(e.clientX, innerWidth - 190), e.clientY);   // 190px: room for the menu (showCtx only fits it vertically)
  });
  // a click on a "▸" head opens nothing by itself (its submenu shows on hover): keep the menu up
  document.addEventListener('click', e => { if (!e.target.closest('#ctxMenu .ctx-sub-head')) hideCtx(); });
}
