/* Markdown mode of the editor: scene HTML <-> the small markdown subset it supports. */
import { esc } from './text.js';
import { parseInert } from './html.js';

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
/* esc() runs first, so only the <b>/<i> added here are markup. Backslash escapes are parked
   as control-character placeholders while the emphasis passes run: \* and \# come back as
   the bare character, but \\ keeps both backslashes (it is not unescaped, so a backslash
   that htmlToMd() wrote as \\ comes back doubled when edited markdown is applied). */
export function inlineMd(s) {
  s = esc(s);
  s = s.replace(/\\\\/g, '\x01');
  s = s.replace(/\\\*/g, '\x02');
  s = s.replace(/\\#/g, '\x03');
  
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  
  s = s.replace(/\x01/g, '\\\\');
  s = s.replace(/\x02/g, '*');
  s = s.replace(/\x03/g, '#');
  return s;
}
/* Scene HTML -> markdown, the inverse of mdToHtml() for what it supports. Other elements
   keep their text but lose their markup. Blocks are joined by blank lines, which mdToHtml()
   reads back as empty paragraphs: <p>a</p><p>b</p> returns with a <p><br></p> between. */
export function htmlToMd(html) {
  const d = parseInert(html);
  let out = [];
  const inline = node => {
    let s = '';
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) {
        let t = ch.textContent;
        // escape what inlineMd()/mdToHtml() would read as syntax ('#' only at a line start)
        t = t.replace(/\\/g, '\\\\');
        t = t.replace(/\*/g, '\\*');
        t = t.replace(/^#/g, '\\#');
        t = t.replace(/\n#/g, '\n\\#');
        s += t;
      }
      else if (/^(B|STRONG)$/.test(ch.tagName)) s += '**' + inline(ch) + '**';
      else if (/^(I|EM)$/.test(ch.tagName)) s += '*' + inline(ch) + '*';
      else if (ch.tagName === 'BR') s += '\n';
      else s += inline(ch);
    });
    return s;
  };
  const walk = node => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) {
        if (ch.textContent.trim()) out.push(ch.textContent);
        return;
      }
      const t = ch.tagName;
      if (t === 'H1') out.push('# ' + inline(ch));
      else if (t === 'H2') out.push('## ' + inline(ch));
      else if (t === 'H3') out.push('### ' + inline(ch));
      else if (t === 'P' || t === 'DIV') out.push(inline(ch));
      else out.push(inline(ch));
    });
  };
  walk(d);
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
