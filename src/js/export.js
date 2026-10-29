/* The top bar's file buttons and its quick exports of the whole novel (TXT, Markdown, HTML). */
import { hasTauri, invoke, pickPath } from './bridge.js';
import { $ } from './dom.js';
import { esc, escAttr } from './lib/text.js';
import { sanitizeSceneHTML, stripHtml } from './lib/html.js';
import { novel } from './state.js';
import { saveCurrentScene } from './tree.js';
import { htmlToMd } from './lib/markdown.js';
import { toast } from './dialogs.js';
import { doOpen, doSave, newProject } from './save.js';
import { resolveLanguage } from './lib/language.js';
import { doExportNotes } from './notes.js';

/* Text exports: 'txt', 'md' or 'html' (anything else returns undefined). Scenes were
   sanitized on load and paste already; the HTML export sanitizes them again and escapes the
   titles, since the file is opened in a full browser. */
export function buildExport(kind, n) {
  if (!n) return '';
  if (n === novel) saveCurrentScene();   // the editor holds the newest text of the open scene
  const scenesOf = c => c.scenes || [];
  if (kind === 'txt') {
    return n.chapters.map(c =>
      c.title.toUpperCase() + '\n\n' +
      scenesOf(c).map(s => stripHtml(s.content).trim()).filter(Boolean).join('\n\n* * *\n\n')
    ).join('\n\n\n');
  }
  if (kind === 'md') {
    return n.chapters.map(c =>
      '# ' + c.title + '\n\n' +
      scenesOf(c).map(s => '## ' + s.title + '\n\n' + (s.markdownContent || htmlToMd(s.content)).trim()).join('\n\n')
    ).join('\n\n---\n\n');
  }
  if (kind === 'html') {
    const body = n.chapters
      .map(c => `<section><h1>${esc(c.title)}</h1>\n` +
        scenesOf(c).map(s => `<article><h2>${esc(s.title)}</h2>\n${sanitizeSceneHTML(s.content)}</article>`).join('\n') +
        `</section>`)
      .join('\n<hr/>\n');
    return `<!DOCTYPE html><html lang="${escAttr(resolveLanguage(n))}"><head><meta charset="utf-8"><title>${esc(n.title)}</title>
<style>body{font-family:Georgia,serif;max-width:720px;margin:40px auto;line-height:1.7;padding:0 20px;}</style>
</head><body>${body}</body></html>`;
  }
}
export async function doExport(kind) {
  if (!novel) { toast('No novel to export'); return; }
  const content = buildExport(kind, novel);
  const name = (novel.title || 'novel') + '.' + kind;
  if (hasTauri) {
    const path = await pickPath('pick_save', { defaultName: name });
    if (!path) return;
    try {
      await invoke('write_text', { path, content });
    } catch (e) {
      console.error(e);
      toast('Export failed');
      return;
    }
  } else {
    downloadFile(name, content);
  }
  toast('Exported to ' + kind.toUpperCase());
}
export function downloadFile(name, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);   // revoking at once can abort the download
}

export function init() {
  /* top bar buttons */
  $('#btnNew').addEventListener('click', newProject);
  $('#btnOpen').addEventListener('click', doOpen);
  $('#btnSave').addEventListener('click', () => doSave(false));
  $('#btnSaveAs').addEventListener('click', () => doSave(true));
  $('#btnExport').addEventListener('click', e => {
    e.stopPropagation();   // the document click handler below closes the menu
    $('#exportMenu').classList.toggle('open');
  });
  document.addEventListener('click', () => $('#exportMenu').classList.remove('open'));
  $('#exportMenu').addEventListener('click', e => {
    const k = e.target.dataset.export;
    if (k) doExport(k);
    const nk = e.target.dataset.exportNotes;
    if (nk) doExportNotes(nk);
  });
}
