/* The open novel as a file (one .novel file = one novel): new, open, load with migration of
   older files, recent files and the title in the top bar. */
import { hasTauri, invoke, pickPath } from './bridge.js';
import { $, editor } from './dom.js';
import { countWords, uuid } from './lib/text.js';
import { parseInert, sanitizeChildren, stripHtml, textFromNode } from './lib/html.js';
import { blankChapter, blankScene, blankWorldMap, newNovel, nowISO } from './lib/model.js';
import {
  currentFilePath, dirty, novel, setCurrentChapterId, setCurrentFilePath, setCurrentSceneId,
  setLoadingContent, setNovel
} from './state.js';
import { markDirty, setSaved, snapshotSaved } from './dirty.js';
import { loadSceneIntoEditor, renderTree, saveCurrentScene } from './tree.js';
import { applyDocFont, applyFontSize } from './editor.js';
import { renderEntities } from './entities.js';
import { updateCounters } from './panels.js';
import { confirmModal, toast } from './dialogs.js';
import { downloadFile } from './export.js';
import {
  closeAddNote, ensureHighlightStyles, renderNoteCard, renderNotes, renderNoteTypeSettings,
  setOpenNoteId
} from './notes.js';
import { closeCompile, compOpen, setComp } from './compile.js';

export function baseName(p) { return p ? p.replace(/\\/g, '/').split('/').pop() : ''; }
function updateWindowTitle() {
  const t = novel ? (novel.title || 'Untitled Novel') : 'No Novel';
  document.title = 'NovelCraft — ' + t;
  if (hasTauri) { try { invoke('set_window_title', { title: t }); } catch (_) {} }
}
export function updateFilePathIndicator() {
  const el = $('#filePathIndicator');
  if (!novel) { el.textContent = ''; el.title = ''; el.classList.remove('unsaved'); return; }
  if (currentFilePath) {
    el.textContent = baseName(currentFilePath);
    el.title = currentFilePath;
    el.classList.remove('unsaved');
  } else {
    el.textContent = '• Unsaved';
    el.title = 'This novel has not been saved to a file yet';
    el.classList.add('unsaved');
  }
}
export function flushNovel() { if (novel) saveCurrentScene(); }   // editor -> current scene, before serializing

/* Render the whole UI for the current `novel` (or the empty state) and select its first scene.
   isLoadingContent is held for the whole pass, so nothing it fills in marks the novel dirty. */
export function refreshUI() {
  const has = !!novel;
  setLoadingContent(true);
  editor.setAttribute('contenteditable', has ? 'true' : 'false');
  $('#emptyState').classList.toggle('hidden', has);
  $('#chaptersSection').classList.toggle('hidden', !has);
  $('#novelTitle').textContent = has ? (novel.title || 'Untitled Novel') : '—';
  if (has) {
    setCurrentChapterId(novel.chapters[0] && novel.chapters[0].id);
    setCurrentSceneId(novel.chapters[0] && novel.chapters[0].scenes[0] && novel.chapters[0].scenes[0].id);
    applyFontSize(novel.settings.fontSize || 18);
    applyDocFont(novel.settings.defaultFont || 'Georgia, serif');
  } else {
    setCurrentChapterId(null);
    setCurrentSceneId(null);
  }
  loadSceneIntoEditor();
  renderTree();
  renderEntities('characters');
  renderEntities('locations');
  renderEntities('races');
  updateCounters();
  updateWindowTitle();
  updateFilePathIndicator();
  setOpenNoteId(null);
  closeAddNote();
  ensureHighlightStyles();
  renderNoteTypeSettings();
  renderNotes();
  renderNoteCard();
  setLoadingContent(false);
}

/* Only the file keys are written: anything else migrateNovel() carried over from the loaded
   object (e.g. a library-era `id`) stays in memory and is dropped on save. */
function toFileObject(n) {
  return {
    version: '1.0',
    title: n.title || 'Untitled Novel',
    settings: n.settings,
    chapters: n.chapters,
    characters: n.characters,
    locations: n.locations,
    races: n.races
  };
}
export function serializeNovel(n) { return JSON.stringify(toFileObject(n), null, 2); }

/* --- migrate-novel:start --- test/migrate-novel.test.js lifts this block and runs it with
   Node stand-ins for its DOM-bound helpers (stripHtml, toast). --- */
/* Backward-compat: files that stored a Russian default-type name as the typeId. */
const RU_NOTE_NAME_TO_ID = {
  'Исправить': 'fix', 'Проверить факт': 'factcheck', 'Развить мысль': 'expand',
  'Перенести': 'move', 'Идея': 'idea'
};
/* Colours from a file end up in style attributes and <style> rules; only #rrggbb gets there
   (which is all <input type=color> ever produces). */
export function safeColor(c, fallback) { return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : fallback; }
/* Normalize any loaded object (current, older or hand-edited file) into a valid in-memory
   novel. Fills defaults and validates what later code interpolates (colours, counts); scene
   HTML is not touched here, sanitizeNovelHTML() does that. */
function migrateNovel(d) {
  d = d || {};
  const base = newNovel(d.title);
  const n = { ...base, ...d };
  n.version = '1.0';
  n.title = d.title || 'Untitled Novel';
  n.settings = { ...base.settings, ...(d.settings || {}) };
  if (!Array.isArray(n.settings.customNoteTypes)) n.settings.customNoteTypes = [];
  if (!n.settings.noteTypeColors || typeof n.settings.noteTypeColors !== 'object') n.settings.noteTypeColors = {};
  n.settings.customNoteTypes.forEach(t => { if (!t.id) t.id = uuid(); t.color = safeColor(t.color, '#c9a96e'); });
  Object.keys(n.settings.noteTypeColors).forEach(k => {
    if (!safeColor(n.settings.noteTypeColors[k], null)) delete n.settings.noteTypeColors[k];
  });
  const wm = { ...blankWorldMap(), ...(n.settings.worldMap || {}) };
  if (typeof wm.locations !== 'object' || !wm.locations) wm.locations = {};
  if (!Array.isArray(wm.routes)) wm.routes = [];
  if (!Array.isArray(wm.layers)) wm.layers = [];
  wm.baseLayers = { ...blankWorldMap().baseLayers, ...(wm.baseLayers || {}) };
  wm.layers.forEach(l => {
    l.id = l.id || uuid();
    l.name = l.name || 'Layer';
    if (typeof l.visible !== 'boolean') l.visible = true;
    if (typeof l.opacity !== 'number') l.opacity = 1;
    if (!Array.isArray(l.drawings)) l.drawings = [];
  });
  wm.routes.forEach(r => {
    r.id = r.id || uuid();
    if (!Array.isArray(r.characterIds)) r.characterIds = [];
    r.color = safeColor(r.color, '#c9a96e');
    if (typeof r.bidirectional !== 'boolean') r.bidirectional = true;
  });
  n.settings.worldMap = wm;
  if (!Array.isArray(n.settings.compilationPresets)) n.settings.compilationPresets = [];
  // Presets may still name the retired 'word' numbering ("Chapter One"); its nearest equivalent is "Chapter 1".
  n.settings.compilationPresets.forEach(p => {
    if (p && p.settings && p.settings.numberChapters === 'word') p.settings.numberChapters = 'arabic';
  });
  // Unset (null) means "auto-detect from the text" — files older than the setting get that
  // too, rather than being pinned to English just for predating it.
  if (typeof n.settings.language !== 'string' || !n.settings.language) n.settings.language = null;
  if (!Array.isArray(n.chapters) || !n.chapters.length) n.chapters = [blankChapter(0)];
  let migratedToScenes = false;
  const normNote = nt => {
    nt.id = nt.id || uuid();
    if (nt.typeId && RU_NOTE_NAME_TO_ID[nt.typeId]) nt.typeId = RU_NOTE_NAME_TO_ID[nt.typeId];
    nt.typeId = nt.typeId || 'idea';
    nt.content = nt.content || '';
    nt.selectedText = nt.selectedText || '';
    // offsets into the scene's plain text (editor.textContent); reconcileNotes() re-finds selectedText when they drift
    nt.startOffset = nt.startOffset || 0;
    nt.endOffset = nt.endOffset || 0;
    nt.createdAt = nt.createdAt || nowISO();
    nt.resolved = !!nt.resolved;
  };
  const normScene = (s, j) => {
    s.id = s.id || uuid();
    s.title = s.title || `Scene ${j + 1}`;
    s.order = j;
    s.content = s.content || '';
    s.markdownContent = s.markdownContent || '';
    // a stored count is only a cache: anything but a positive integer is recounted
    s.wordCount = Number.isInteger(s.wordCount) && s.wordCount > 0 ? s.wordCount : countWords(stripHtml(s.content));
    if (s.povCharacter === undefined) s.povCharacter = null;
    if (s.location === undefined) s.location = null;
    s.timeOfDay = s.timeOfDay || 'unknown';
    s.status = s.status || 'draft';
    if (!Array.isArray(s.notes)) s.notes = [];
    s.notes.forEach(normNote);
    s.createdAt = s.createdAt || nowISO();
    s.modifiedAt = s.modifiedAt || nowISO();
  };
  n.chapters.forEach((c, i) => {
    c.id = c.id || uuid();
    c.order = i;
    c.title = c.title || `Chapter ${i + 1}`;
    if (typeof c.collapsed !== 'boolean') c.collapsed = false;
    if (!Array.isArray(c.scenes) || !c.scenes.length) {
      // legacy chapter: wrap its content (+notes) into a single default scene
      const s = blankScene(0);
      s.title = 'Scene 1';
      s.content = c.content || '';
      s.markdownContent = c.markdownContent || '';
      s.wordCount = countWords(stripHtml(s.content));
      s.notes = Array.isArray(c.notes) ? c.notes : [];
      c.scenes = [s];
      migratedToScenes = true;
    } else if (Array.isArray(c.notes) && c.notes.length) {
      // Chapter-level notes left on a chapter that has scenes go to its first scene, as in
      // the legacy wrap above, rather than being lost to the delete below.
      const dest = c.scenes[0];
      if (!Array.isArray(dest.notes)) dest.notes = [];
      dest.notes.push(...c.notes);
    }
    delete c.content; delete c.markdownContent; delete c.notes;
    c.scenes.forEach(normScene);
    c.wordCount = c.scenes.reduce((sum, s) => sum + (s.wordCount || 0), 0);
  });
  if (migratedToScenes) setTimeout(() => toast('Migrated chapters to the new scene structure'), 400);
  ['characters', 'locations', 'races'].forEach(k => {
    if (!Array.isArray(n[k])) n[k] = [];
    n[k].forEach(e => { if (!e.id) e.id = uuid(); });
  });
  // Relationship graph data. graphPosition null = not placed yet (the graph lays it out);
  // strength is 1-10.
  n.characters.forEach(ch => {
    // older files keep `relationships` as free text: it moves to relationshipNotes
    if (typeof ch.relationships === 'string') { ch.relationshipNotes = ch.relationships; ch.relationships = []; }
    if (!Array.isArray(ch.relationships)) ch.relationships = [];
    ch.relationships.forEach(r => {
      r.id = r.id || uuid();
      r.type = r.type || 'friend';
      r.strength = typeof r.strength === 'number' ? r.strength : 5;
      r.status = r.status || 'active';
    });
    if (!ch.graphPosition || typeof ch.graphPosition.x !== 'number') ch.graphPosition = null;
    if (ch.hiddenInGraph === undefined) ch.hiddenInGraph = false;
    if (ch.color !== undefined && !safeColor(ch.color, null)) delete ch.color;
  });
  return n;
}
/* --- migrate-novel:end --- */

/* Clean every scene's HTML (see sanitizeSceneHTML). This is the one gate all file content
   passes on its way in — opening, recovery and library splits — so the editor, previews and
   exports only ever see allowlisted markup. */
function sanitizeNovelHTML(n) {
  (n.chapters || []).forEach(c => (c.scenes || []).forEach(sc => {
    const root = parseInert(sc.content);
    sanitizeChildren(root);
    sc.content = root.innerHTML;
    // Every scene is recounted: a stored count is only a cache, and the file may have been
    // written by a version that counted words by other rules.
    sc.wordCount = countWords(textFromNode(root));
  }));
  return n;
}

/* Put a loaded novel object into the UI as the current file. */
export function setCurrentNovel(n, path) {
  setNovel(sanitizeNovelHTML(migrateNovel(n)));
  setCurrentFilePath(path || null);
  // Compile state belongs to the previous novel (its order, title, author); openCompile()
  // rebuilds it for this one. Ctrl+O / the menu work while the dialog is up, so close it too.
  setComp(null);
  if (compOpen) closeCompile();
  refreshUI();
  snapshotSaved();
  setSaved();
}

/* Handle an old multi-novel (library) file by splitting it into separate files. */
async function handleLibraryFile(data, path) {
  const novels = (data.novels || []).map(d => sanitizeNovelHTML(migrateNovel(d)));
  if (!novels.length) { setCurrentNovel(newNovel(), null); return; }
  const active = novels.find(n => n.id === data.activeNovelId) || novels[0];
  const others = novels.filter(n => n !== active);
  
  if (!others.length) {
    setCurrentNovel(active, path);
    return;
  }
  
  setCurrentNovel(active, null);   // open as unsaved so we don't silently overwrite the library file
  
  confirmModal('Multiple novels found',
    `This file contains ${novels.length} novels, but NovelCraft now uses one file per novel. ` +
    `Save all ${novels.length} as separate .novel files now?`,
    async () => {
      for (const n of novels) {
        const content = serializeNovel(n);
        if (hasTauri) {
          const p = await pickPath('pick_save', { defaultName: (n.title || 'novel') + '.novel' });
          if (p) { 
            try {
              await invoke('save_novel', { path: p, content }); 
              await addRecent(p); 
              if (n === active) {
                setCurrentFilePath(p);
                await invoke('set_last_file', { path: p });
                updateFilePathIndicator();
              }
            } catch (e) {
              console.error(e);
              toast('Save failed for ' + n.title);
            }
          }
        } else {
          downloadFile((n.title || 'novel') + '.novel', content);
        }
      }
      toast('Split into separate files');
    });
}

/* --- open / new / load --- */
/* The backend reads only paths the user picked this session or that are in the recent list /
   last file (GrantedPaths); any other path is rejected and ends up as "Could not open file". */
export async function loadFromPath(path) {
  try {
    const content = await invoke('read_text', { path });
    const data = JSON.parse(content);
    if (data && Array.isArray(data.novels)) await handleLibraryFile(data, path);
    else setCurrentNovel(data, path);
    if (hasTauri) { await invoke('set_last_file', { path }); await addRecent(path); }
    toast('Opened ' + baseName(path));
  } catch (e) {
    console.error(e);
    toast('Could not open file');
  }
}
export function guardUnsaved(action, msg) {
  if (dirty) confirmModal('Unsaved changes', msg, action);
  else action();
}
export function openNovelFile() {
  guardUnsaved(async () => {
    if (hasTauri) {
      const path = await pickPath('pick_open');
      if (path) await loadFromPath(path);
    } else {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.novel,application/json';
      inp.onchange = () => {
        const f = inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const data = JSON.parse(rd.result);
            if (data && Array.isArray(data.novels)) handleLibraryFile(data, null);
            else setCurrentNovel(data, null);
            toast('Opened ' + f.name);
          } catch { toast('Invalid file'); }
        };
        rd.readAsText(f);
      };
      inp.click();
    }
  }, 'Discard unsaved changes and open another novel?');
}
export function newNovelFile() {
  guardUnsaved(async () => {
    const n = newNovel();
    if (hasTauri) {
      // prompt for the file location up front and create the file
      const path = await pickPath('pick_save', { defaultName: 'Untitled Novel.novel' });
      if (!path) return;               // cancelled -> keep current novel
      setCurrentNovel(n, path);
      await invoke('save_novel', { path, content: serializeNovel(novel) });
      await invoke('set_last_file', { path });
      await addRecent(path);
      toast('Created ' + baseName(path));
    } else {
      setCurrentNovel(n, null);        // browser: unsaved until first Save
      toast('New novel');
    }
  }, 'Discard unsaved changes and create a new novel?');
}

/* --- recent files --- */
async function getRecent() {
  if (!hasTauri) return [];
  try { return (await invoke('get_recent_files')) || []; } catch { return []; }
}
export async function addRecent(path) {
  if (hasTauri) { try { await invoke('add_recent_file', { path }); } catch (_) {} }
  await renderRecentMenu();
}
export async function renderRecentMenu() {
  const menu = $('#recentMenu');
  const list = await getRecent();
  menu.innerHTML = '';
  if (!list.length) {
    menu.innerHTML = '<button class="rm-empty" disabled>No recent files</button>';
    return;
  }
  list.slice(0, 5).forEach(p => {
    const b = document.createElement('button');
    b.textContent = baseName(p);
    b.title = p;
    b.addEventListener('click', () => {
      menu.classList.remove('open');
      guardUnsaved(() => loadFromPath(p), 'Discard unsaved changes and open this file?');
    });
    menu.appendChild(b);
  });
}

/* novel title inline edit (top bar) */
export const nvTitle = $('#novelTitle');
function commitNovelTitle() {
  nvTitle.contentEditable = 'false';
  if (!novel) return;
  const v = nvTitle.textContent.trim();
  if (v && v !== novel.title) {
    novel.title = v;
    updateWindowTitle();
    // in place, not updateBreadcrumb(): this runs on blur, often from a press on another breadcrumb
    // part, and rebuilding the breadcrumb would detach that button before its click
    const bcNovel = $('#breadcrumb .bc-novel');
    if (bcNovel) bcNovel.textContent = v;
    markDirty();
  }
  else nvTitle.textContent = novel.title;
}

export function init() {
  /* buttons */
  $('#btnNewNovel').addEventListener('click', newNovelFile);
  $('#btnOpenNovel').addEventListener('click', openNovelFile);
  $('#esNew').addEventListener('click', newNovelFile);
  $('#esOpen').addEventListener('click', openNovelFile);
  $('#btnRecent').addEventListener('click', e => {
    e.stopPropagation();
    $('#recentMenu').classList.toggle('open');
  });
  document.addEventListener('click', () => $('#recentMenu').classList.remove('open'));
  nvTitle.addEventListener('dblclick', () => {
    if (!novel) return;
    nvTitle.contentEditable = 'true';
    nvTitle.focus();
    document.execCommand('selectAll', false, null);
  });
  nvTitle.addEventListener('blur', commitNovelTitle);
  // A press on a breadcrumb part while the title is being edited must not commit it right then: the
  // new title relabels the novel part and shifts the other parts out from under the pointer, so the
  // click would be lost. The part's click handler commits it instead.
  $('#breadcrumb').addEventListener('mousedown', e => { if (document.activeElement === nvTitle && e.target.closest('.bc-part')) e.preventDefault(); });
  nvTitle.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); nvTitle.blur(); }
  });
}
