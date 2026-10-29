/* Panel chrome: word counters and the goal, the accordion sections, the panel toggles and
   focus mode. */
import { $, $$, editor, mdEditor } from './dom.js';
import { stripHtml } from './lib/html.js';
import { novel } from './state.js';
import { markDirty } from './dirty.js';
import { chapterWordCount, currentChapter } from './tree.js';
import { mdMode } from './editor.js';
import { mdToHtml } from './lib/markdown.js';
import { promptModal } from './dialogs.js';
import { corkboardOpen } from './corkboard.js';

export let focusMode = false;

export function updateCounters() {
  const goal = novel ? (novel.settings.wordGoal || 80000) : 80000;
  const c = currentChapter();
  const chapWords = c ? chapterWordCount(c) : 0;
  const total = novel ? novel.chapters.reduce((s, x) => s + chapterWordCount(x), 0) : 0;
  // the character counts are for the scene in the editor, read live from whichever view is shown
  const txt = !novel ? '' : mdMode ? stripHtml(mdToHtml(mdEditor.value)) : stripHtml(editor.innerHTML);
  $('#statChapWords').textContent = chapWords;
  $('#statTotalWords').textContent = total;
  $('#statChars').textContent = txt.length;
  $('#statCharsNs').textContent = txt.replace(/\s/g, '').length;
  const pct = Math.min(100, Math.round((total / goal) * 100));
  $('#progressBar').style.width = pct + '%';
  $('#goalLabel').textContent = `${pct}% of ${goal.toLocaleString()}`;
}

/* ---- focus mode ---- */
export function setFocus(on) {
  focusMode = on;
  document.body.classList.toggle('focus', on);
  // focus mode hides the top bar (and its Focus button): the exit button is the mouse way out
  const exit = $('#exitFocus');
  exit.classList.toggle('hidden', !on);
  exit.classList.remove('peek');
  if (on && !corkboardOpen) (mdMode ? mdEditor : editor).focus();
  else if (on && document.activeElement && document.activeElement.closest('#topbar, #leftPanel, #rightPanel')) document.activeElement.blur();
}

export function init() {
  $('#btnGoal').addEventListener('click', () => {
    if (!novel) return;
    promptModal('Word goal', 'Target total words:', String(novel.settings.wordGoal), v => {
      const n = parseInt(v, 10);
      if (n > 0 && n !== novel.settings.wordGoal) {
        novel.settings.wordGoal = n;
        updateCounters();
        markDirty();
      }
    });
  });
  // accordion sections
  $$('.acc-head').forEach(h =>
    h.addEventListener('click', () => h.parentElement.classList.toggle('open'))
  );
  // panel toggles
  $('#toggleLeft').addEventListener('click', () => {
    $('#leftPanel').classList.toggle('collapsed');
    $('#toggleLeft').textContent = $('#leftPanel').classList.contains('collapsed') ? '▶' : '◀';
  });
  $('#toggleRight').addEventListener('click', () => {
    $('#rightPanel').classList.toggle('collapsed');
    $('#toggleRight').textContent = $('#rightPanel').classList.contains('collapsed') ? '◀' : '▶';
  });
  $('#btnFocus').addEventListener('click', () => setFocus(!focusMode));
  $('#exitFocus').addEventListener('click', () => setFocus(false));
  $('#exitFocus').addEventListener('mousedown', e => e.preventDefault());   // the caret stays where it was
  /* The exit button peeks in when the pointer reaches the top 8px of the window and stays while
     the pointer is within its own height + 8px, so moving onto it does not hide it again. */
  document.addEventListener('mousemove', e => {
    if (!focusMode) return;
    const exit = $('#exitFocus');
    exit.classList.toggle('peek', e.clientY < (exit.classList.contains('peek') ? exit.offsetHeight + 8 : 8));
  });
}
