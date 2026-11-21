/* Bounded undo history for the open novel. Snapshots share unchanged branches and
   strings. Ordinary typing copies only the edited scene and its path to the root. */
import { currentSceneId, novel, setDirty, setNovel } from './state.js';
import { editor, mdEditor } from './dom.js';
import { currentChapter, currentScene } from './tree.js';
import { refreshUI } from './novel-file.js';
import { refreshSaveIndicator } from './dirty.js';
import { mdMode } from './editor.js';
import { corkboardOpen, renderCorkboard } from './corkboard.js';
import { graphOpen, openGraph } from './graph.js';
import { mapOpen, openMap } from './map.js';
import { compOpen, openCompile } from './compile.js';

let entries = [], index = -1, saved = null, group = null;
let selectedScene = null, beforeCaret = null;
const LIMIT = 80;

// Novel data is a JSON tree. Reuse the previous immutable node when every child matches.
function snapshot(value, old) {
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  let same = old != null && typeof old === 'object' && Array.isArray(value) === Array.isArray(old) &&
    Object.keys(old).length === keys.length;
  const children = keys.map(key => {
    const child = snapshot(value[key], old?.[key]);
    if (!Object.hasOwn(old ?? {}, key) || child !== old[key]) same = false;
    return [key, child];
  });
  if (same) return old;
  return Array.isArray(value) ? children.map(([, child]) => child) : Object.fromEntries(children);
}

function sceneSnapshot(scene, previous) {
  const chapter = currentChapter();
  const ci = novel.chapters.indexOf(chapter), si = chapter.scenes.indexOf(scene);
  const oldChapter = previous.chapters[ci];
  if (oldChapter?.scenes[si]?.id !== scene.id) return snapshot(novel, previous);
  const changed = snapshot(scene, oldChapter.scenes[si]);
  if (changed === oldChapter.scenes[si]) return previous;
  const scenes = oldChapter.scenes.slice();
  scenes[si] = changed;
  const chapters = previous.chapters.slice();
  chapters[ci] = { ...oldChapter, wordCount: chapter.wordCount, scenes };
  return { ...previous, chapters };
}

export function resetHistory() {
  entries = [{ model: snapshot(novel), sceneId: currentSceneId }];
  index = 0;
  saved = entries[0];
  selectedScene = currentSceneId;
  group = null;
}

export function finishTyping() { group = null; }
export function rememberSelection() {
  finishTyping();
  selectedScene = currentSceneId;
}
export function forgetSavedHistory() { saved = null; }

function caretPosition() {
  if (mdMode && document.activeElement === mdEditor) return { source: mdEditor.selectionEnd };
  const sel = getSelection();
  if (mdMode || !sel.focusNode || !editor.contains(sel.focusNode)) return null;
  const path = [];
  for (let node = sel.focusNode; node !== editor; node = node.parentNode) {
    path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
  }
  return { path, offset: sel.focusOffset };
}
export function rememberCaret() { beforeCaret = caretPosition(); }

function restoreCaret(caret) {
  if (mdMode) {
    mdEditor.focus();
    const offset = caret?.source ?? mdEditor.value.length;
    mdEditor.setSelectionRange(offset, offset);
    return;
  }
  editor.focus();
  const node = caret?.path?.reduce((parent, i) => parent?.childNodes[i], editor);
  if (node) {
    getSelection().collapse(node, Math.min(caret.offset, node.nodeType === 3 ? node.length : node.childNodes.length));
  } else {
    getSelection().selectAllChildren(editor);
    getSelection().collapseToEnd();
  }
}
export function saveHistory() {
  if (index < 0) return;
  finishTyping();
  entries[index].model = snapshot(novel, entries[index].model);
  saved = entries[index];
}
export function recordHistory(scene) {
  if (!novel || index < 0) return;
  const previous = entries[index].model;
  const model = scene ? sceneSnapshot(scene, previous) : snapshot(novel, previous);
  if (model === previous) return;
  const now = performance.now();
  const extend = scene && group?.scene === scene && group.mode === mdMode && now - group.time < 750;
  const entry = { model, sceneId: currentSceneId, undoScene: extend ? entries[index].undoScene : selectedScene };
  if (scene) {
    entry.beforeCaret = extend ? entries[index].beforeCaret : beforeCaret;
    entry.afterCaret = caretPosition();
  }
  beforeCaret = null;
  selectedScene = currentSceneId;
  if (extend) entries[index] = entry;
  else {
    entries.splice(index + 1, entries.length, entry);
    if (entries.length > LIMIT) entries.shift();
    index = entries.length - 1;
  }
  group = scene ? { scene, mode: mdMode, time: now } : null;
}

// Text fields and auxiliary dialogs own their native editing history.
export function handlesHistory() {
  const field = document.activeElement;
  if (field !== editor && field !== mdEditor &&
      (field?.isContentEditable || field?.matches('input, textarea, select'))) return false;
  return !!novel && !document.querySelector('#modalOverlay:not(.hidden), #closeOverlay:not(.hidden), #backupOverlay:not(.hidden), #routeOverlay:not(.hidden), #notePopup:not(.hidden)');
}

export function stepHistory(redo) {
  const next = index + (redo ? 1 : -1);
  if (next < 0 || next >= entries.length) return;
  const focused = document.activeElement === editor || document.activeElement === mdEditor;
  finishTyping();
  const action = redo ? entries[next] : entries[index];
  const sceneId = redo ? action.sceneId : action.undoScene;
  const caret = redo ? action.afterCaret : action.beforeCaret;
  index = next;
  const entry = entries[index];
  setNovel(structuredClone(entry.model));
  refreshUI(sceneId);
  selectedScene = currentSceneId;
  if (corkboardOpen) renderCorkboard();
  if (graphOpen) openGraph();
  if (mapOpen) openMap();
  if (compOpen) openCompile();
  setDirty(entry !== saved);
  refreshSaveIndicator(true);
  if (focused && currentScene()) restoreCaret(caret);
}
