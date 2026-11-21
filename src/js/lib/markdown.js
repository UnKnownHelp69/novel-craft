/* Markdown mode of the editor: scene HTML <-> the small markdown subset it supports. */
import { esc } from './text.js';
import { parseInert, sanitizeSceneHTML } from './html.js';

/* Markdown -> HTML, DOM-free: run on every save while markdown mode is on
   (saveCurrentScene) and when toggling back out of it (toggleMarkdownMode); what it returns
   is written straight into the contenteditable as HTML. test/md-to-html.test.js pins what
   the two regex passes actually produce. */
export function mdToHtml(md) {
  const lines = (md || '').split(/\r?\n/);
  const out = lines.map(line => {
    let l = line;
    if (/^###\s+/.test(l)) return '<h3>' + inlineMd(l.replace(/^###\s+/, '')) + '</h3>';
    if (/^##\s+/.test(l)) return '<h2>' + inlineMd(l.replace(/^##\s+/, '')) + '</h2>';
    if (/^#\s+/.test(l)) return '<h1>' + inlineMd(l.replace(/^#\s+/, '')) + '</h1>';
    if (l.trim() === '') return '<p><br></p>';
    return '<p>' + inlineMd(l) + '</p>';
  });
  return out.join('');
}
/* esc() runs first, so only the <b>/<i> added here are markup. The backslash escapes
   htmlToMd() writes (\\, \* and \#) are parked as control-character placeholders while the
   emphasis passes run, then come back as the bare character. A backslash before anything else
   is kept as typed. */
export function inlineMd(s) {
  s = esc(s);
  s = s.replace(/\\\\/g, '\x01');
  s = s.replace(/\\\*/g, '\x02');
  s = s.replace(/\\#/g, '\x03');
  
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  
  s = s.replace(/\x01/g, '\\');
  s = s.replace(/\x02/g, '*');
  s = s.replace(/\x03/g, '#');
  return s;
}
/* Rich blocks use Markdown's raw-HTML representation. Keep each on one source line,
   including newlines inside preformatted text, so adjacent prose can be edited normally. */
const rawBlock = line => /^<[a-z][\w-]*(?:\s|\/?>)/i.test(line);
export function sceneSourceToHtml(md) {
  return md.split(/\r?\n/).filter(line => line.trim()).map(line =>
    rawBlock(line) ? sanitizeSceneHTML(line) : mdToHtml(line)).join('');
}
export function htmlToMd(html) {
  const root = parseInert(html);
  const escapeText = text => text.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/^#/gm, '\\#');
  const inline = node => {
    if (node.nodeType === 3) return escapeText(node.data);
    const text = Array.from(node.childNodes, inline).join('');
    if (/^(B|STRONG)$/.test(node.tagName)) return '**' + text + '**';
    if (/^(I|EM)$/.test(node.tagName)) return '*' + text + '*';
    return text;
  };
  const lines = [];
  for (const node of root.childNodes) {
    if (node.nodeType === 3 && !node.data.trim()) continue;
    const heading = /^H([123])$/.exec(node.nodeName);
    const line = (heading ? '#'.repeat(Number(heading[1])) + ' ' : '') + inline(node);
    const html = node.outerHTML ?? '<p>' + esc(node.textContent) + '</p>';
    // Use plain Markdown only when its inverse retains the entire block.
    if (line.trim() && !line.includes('\n') && !rawBlock(line) && mdToHtml(line) === html) lines.push(line);
    else lines.push(html.replace(/\n/g, '&#10;'));
  }
  return lines.join('\n\n');
}

export function sourceForScene(scene) {
  const cached = scene.markdownContent;
  if (cached && (!scene.content || sceneSourceToHtml(cached) === scene.content)) return cached;
  return htmlToMd(scene.content);
}
