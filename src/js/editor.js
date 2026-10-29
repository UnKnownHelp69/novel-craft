/* The scene editor: input and paste handling, the formatting toolbar, markdown mode, and the
   document font and size. */
import { $, chapterList, editor, mdEditor } from './dom.js';
import { countWords, escAttr } from './lib/text.js';
import { parseInert, sanitizeSceneHTML, stripHtml } from './lib/html.js';
import { nowISO } from './lib/model.js';
import { isLoadingContent, novel, setLoadingContent } from './state.js';
import { markDirty, normalizeHTML, savedContent, savedMd } from './dirty.js';
import { chapterWordCount, currentChapter, currentScene } from './tree.js';
import { htmlToMd, mdToHtml } from './lib/markdown.js';
import { updateCounters } from './panels.js';
import { reconcileNotes, renderNotes, scheduleNotesRender } from './notes.js';
import { shortcutKey } from './lib/keys.js';

export let mdMode = false;
/* Pasted HTML goes through the same allowlist as file content (sanitizeSceneHTML): pastes
   from Word or the web otherwise bring their classes, styles, fonts and remote images into
   the scene. Plain-text pastes, including Ctrl+Shift+V, are left to the browser. The paste
   event itself does not say whether Shift was held, so the keydown just before it records
   that (shortcutKey(), so Ctrl+Shift+V also works on non-Latin layouts). */
let plainPasteRequested = false;
/* Patch the scene's and chapter's word counts in the tree in place: this runs on every
   keystroke, and re-rendering the tree would rebuild every row. */
function refreshSceneWordCount(s) {
  const el = chapterList.querySelector(`[data-scene-id="${CSS.escape(String(s.id))}"] .ts-words`);
  if (el) el.textContent = s.wordCount || 0;
  const c = currentChapter();
  if (c) {
    c.wordCount = chapterWordCount(c);
    const cw = chapterList.querySelector(`.tree-chapter[data-chapter-id="${CSS.escape(String(c.id))}"] .tc-words`);
    if (cw) cw.textContent = c.wordCount;
  }
}

function exec(cmd, val = null) {
  editor.focus();
  document.execCommand(cmd, false, val);
  markDirty();
  updateToolbarState();
}

export function updateToolbarState() {
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
export function toggleMarkdownMode() {
  const s = currentScene();
  if (!s) return;
  setLoadingContent(true);   // switching views is not an edit
  if (!mdMode) {
    // visual -> markdown
    s.content = editor.innerHTML;
    mdEditor.value = htmlToMd(s.content);
    s.markdownContent = mdEditor.value;
    editor.classList.add('hidden');
    mdEditor.classList.remove('hidden');
    $('#btnMarkdownMode').classList.add('active');
    mdMode = true;
  } else {
    // markdown -> visual
    if (mdEditor.value !== htmlToMd(s.content)) {
      s.content = mdToHtml(mdEditor.value);
    }
    s.markdownContent = mdEditor.value;
    editor.innerHTML = s.content || '';
    mdEditor.classList.add('hidden');
    editor.classList.remove('hidden');
    $('#btnMarkdownMode').classList.remove('active');
    mdMode = false;
    reconcileNotes(s);   // note offsets are positions in editor.textContent, re-anchor them
  }
  setLoadingContent(false);
  renderNotes();   // margin dots / highlights only exist in visual mode
}

/* ---- document font and size ---- */
export function applyFontSize(px) {
  document.documentElement.style.setProperty('--fs', px + 'px');
  $('#fsVal').textContent = px;
  $('#fontSize').value = px;
  if (novel) novel.settings.fontSize = px;
}
export function applyDocFont(font) {
  document.documentElement.style.setProperty('--doc-font', font);
  $('#docFontSelect').value = font;
  if (novel) novel.settings.defaultFont = font;
}

export function init() {
  editor.addEventListener('input', () => {
    if (isLoadingContent) return;          // programmatic innerHTML writes are not edits
    const s = currentScene();
    if (!s) return;
    s.content = editor.innerHTML;
    s.wordCount = countWords(stripHtml(s.content));
    s.modifiedAt = nowISO();
    updateCounters();
    refreshSceneWordCount(s);
    reconcileNotes(s);            // keep note offsets valid as text shifts
    scheduleNotesRender();
    // compared normalized: input that leaves the scene as saved (markup the browser reshuffles
    // without a visible change) does not mark the novel dirty
    if (normalizeHTML(s.content) !== (savedContent[s.id] || '')) markDirty();
  });
  editor.addEventListener('keydown', e => {
    plainPasteRequested = (e.ctrlKey || e.metaKey) && e.shiftKey && shortcutKey(e) === 'v';
  });
  editor.addEventListener('paste', e => {
    const plain = plainPasteRequested;
    plainPasteRequested = false;
    const cd = e.clipboardData;
    const html = !plain && cd && cd.getData('text/html');
    if (!html) return;
    e.preventDefault();
    const clean = sanitizeSceneHTML(html);
    const root = parseInert(clean);
    if (root.textContent.trim() || root.querySelector('img')) { document.execCommand('insertHTML', false, clean); return; }
    // "Copy image" puts a remote <img> (dropped by the policy) next to the bitmap itself:
    // paste the bitmap as inline data instead.
    const file = [...(cd.files || [])].find(f => /^image\/(?:png|jpe?g|gif|webp)$/.test(f.type));
    if (file) {
      // The read is async: remember the caret now and put it back before inserting.
      const sel = getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const reader = new FileReader();
      reader.onload = () => {
        // through the policy too: it only keeps base64 data: URLs of the four types above
        const img = sanitizeSceneHTML(`<img src="${escAttr(String(reader.result))}">`);
        if (!img) return;
        editor.focus();
        if (range) { sel.removeAllRanges(); sel.addRange(range); }
        document.execCommand('insertHTML', false, img);
      };
      reader.readAsDataURL(file);
      return;
    }
    // Nothing readable survived (an emoji or a formula rendered as a remote <img alt>, say):
    // the plain-text flavour of the same copy is the next best thing.
    const plainText = cd.getData('text/plain');
    if (plainText.trim()) { document.execCommand('insertText', false, plainText); return; }
    // Structure only (line breaks, empty paragraphs) still goes in; nothing at all must not
    // replace the selection with nothing.
    if (clean) document.execCommand('insertHTML', false, clean);
  });
  mdEditor.addEventListener('input', () => {
    if (isLoadingContent) return;
    const s = currentScene();
    if (!s) return;
    s.markdownContent = mdEditor.value;
    // count the rendered text, not the raw markdown, so both modes agree (and match saveCurrentScene)
    s.wordCount = countWords(stripHtml(mdToHtml(mdEditor.value)));
    s.modifiedAt = nowISO();
    updateCounters();
    refreshSceneWordCount(s);
    if (s.markdownContent !== (savedMd[s.id] || '')) markDirty();
  });
  $('#fmtBold').addEventListener('click', () => exec('bold'));
  $('#fmtItalic').addEventListener('click', () => exec('italic'));
  $('#styleSelect').addEventListener('change', e => {
    exec('formatBlock', e.target.value === 'P' ? 'P' : e.target.value);
  });
  $('#fontSelect').addEventListener('change', e => {
    editor.focus();
    // writes <font face>, which the html-policy keeps (face checked against FONT_FAMILY_RE)
    document.execCommand('fontName', false, e.target.value);
    markDirty();
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) updateToolbarState();
  });
  /* Markdown mode. htmlToMd() keeps only h1-h3, paragraphs, bold/italic and line breaks,
     so the round trip is lossy: the HTML is rebuilt from the markdown only when the markdown
     text was actually changed; otherwise the scene's HTML (images, fonts, ...) stays as it was.
     saveCurrentScene() applies the same rule. */
  $('#btnMarkdownMode').addEventListener('click', toggleMarkdownMode);
  $('#fontSize').addEventListener('input', e => {
    applyFontSize(+e.target.value);
    markDirty();
  });
  $('#docFontSelect').addEventListener('change', e => {
    applyDocFont(e.target.value);
    markDirty();
  });
}
