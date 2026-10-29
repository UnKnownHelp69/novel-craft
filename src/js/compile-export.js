/* Building the compiled book: the preview, HTML and TXT, and the PDF, EPUB and DOCX
   exporters. Their format builders, which need no DOM, live in lib/. */
import { hasTauri, invoke, pickPath } from './bridge.js';
import { $ } from './dom.js';
import { esc, escAttr, uuid } from './lib/text.js';
import { parseInert, sanitizeChildren, stripHtml } from './lib/html.js';
import { novel } from './state.js';
import { findScene, saveCurrentScene } from './tree.js';
import { baseName } from './novel-file.js';
import { toast } from './dialogs.js';
import { resolveLanguage } from './lib/language.js';
import { downloadFile } from './export.js';
import { comp } from './compile.js';
import { buildFlow, compTocEntries, sepText, tocLabel } from './lib/compile-flow.js';
import { makeZip } from './lib/zip.js';
import {
  buildPdfPages, createPdfLayout, parseTrueType, pdfGlyphHex, pdfToUnicodeCMap
} from './lib/pdf.js';
import {
  buildEpubBookXhtml, buildEpubContainerXml, buildEpubNavXhtml, buildEpubNcxXml,
  buildEpubOpfXml
} from './lib/epub.js';
import {
  buildDocxBodyXml, buildDocxContentTypesXml, buildDocxDocumentXml, buildDocxRelsXml
} from './lib/docx.js';

/* The compilation flow for the open novel. buildFlow() stays pure, so the export language
   its chapter headings use is resolved here, fresh for every compile. */
function compFlow() {
  return buildFlow(comp.items, { ...comp.settings, language: resolveLanguage(novel) }, novel.chapters, findScene);
}
/* A scene's HTML for the compiled document; '' when it has no text and no image. With xhtml
   (EPUB) it is re-serialized as XML, so void elements self-close and the markup is
   well-formed. XMLSerializer stamps the XHTML namespace on every top-level element; that is
   stripped, the enclosing book.xhtml already declares it. */
function normalizeSceneHTML(html, xhtml) {
  const root = parseInert(html);
  sanitizeChildren(root);   // scenes are sanitized on load; this keeps previews and exports safe regardless
  if (!root.textContent.trim() && !root.querySelector('img')) return '';
  if (!xhtml) return root.innerHTML;
  const ser = new XMLSerializer();
  let out = '';
  root.childNodes.forEach(n => { out += ser.serializeToString(n); });
  return out.replace(/ xmlns="[^"]*"/g, '');
}
/* &#160;, not &nbsp;: XHTML (EPUB) only knows XML's five predefined entities. */
function flowToBodyHTML(flow, xhtml) {
  const s = comp.settings;
  let html = '';
  let lastScene = false;
  flow.forEach(f => {
    if (f.type === 'part') { html += `<h1 class="c-part" id="${f.anchor}">${esc(f.title)}</h1>`; lastScene = false; }
    else if (f.type === 'chapter') { html += `<h1 class="c-chapter" id="${f.anchor}">${esc(f.title)}</h1>`; lastScene = false; }
    else if (f.type === 'break') { const t = sepText(s); html += t ? `<p class="c-sep">${esc(t)}</p>` : '<p class="c-sep">&#160;</p>'; lastScene = false; }
    else {
      if (lastScene) { const t = sepText(s); html += t ? `<p class="c-sep">${esc(t)}</p>` : '<p class="c-sep">&#160;</p>'; }
      if (f.showTitle) html += `<h2 class="c-scene" id="${f.anchor}">${esc(f.title)}</h2>`;
      const body = normalizeSceneHTML(f.html, xhtml);
      html += body || (xhtml ? '<p></p>' : '<p></p>');
      lastScene = true;
    }
  });
  return html;
}
function titlePageHTML() {
  const s = comp.settings;
  if (!s.titlePage) return '';
  return `<section class="c-titlepage"><h1 class="c-booktitle">${esc(s.titleText || novel.title)}</h1>` +
    (s.subtitle ? `<p class="c-subtitle">${esc(s.subtitle)}</p>` : '') +
    (s.author ? `<p class="c-author">${esc(s.author)}</p>` : '') +
    (s.dateText ? `<p class="c-date">${esc(s.dateText)}</p>` : '') + `</section>`;
}
function tocHTML(flow) {
  const s = comp.settings;
  if (!s.toc) return '';
  const entries = compTocEntries(flow, s);
  if (!entries.length) return '';
  return `<section class="c-toc"><h1 class="c-toc-title">${esc(tocLabel(resolveLanguage(novel)))}</h1><ul>` +
    entries.map(f => `<li class="c-toc-${f.type}"><a href="#${f.anchor}">${esc(f.title)}</a></li>`).join('') +
    `</ul></section>`;
}
function docBodyHTML(xhtml) {
  const s = comp.settings;
  const flow = compFlow();
  let body = titlePageHTML();
  if (s.toc && s.tocPosition === 'afterTitle') body += tocHTML(flow);
  body += flowToBodyHTML(flow, xhtml);
  if (s.toc && s.tocPosition === 'end') body += tocHTML(flow);
  return body;
}
function compDocClasses() {
  const s = comp.settings;
  return 'comp-doc' + (s.indent === 'indent' ? ' comp-indent' : '') + (s.paraSpacing === 'space' ? ' comp-paraspace' : '') + (s.align === 'justify' ? ' comp-justify' : '');
}
/* Font choices of the Compile dialog. Presets live in the .novel file, so the values that
   reach CSS (compDocStyle, the EPUB stylesheet) go through compTypography() first. */
export const COMP_FONT_OPTIONS = [
  ['Georgia, serif', 'Georgia'], ["'Lora', serif", 'Lora'], ["'Merriweather', serif", 'Merriweather'],
  ["'Inter', sans-serif", 'Inter'], ['Roboto, sans-serif', 'Roboto'], ['Arial, sans-serif', 'Arial']
];
function compTypography(s) {
  const num = (v, lo, hi, dflt) => { const n = parseFloat(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };
  return {
    font: COMP_FONT_OPTIONS.some(([v]) => v === s.font) ? s.font : COMP_FONT_OPTIONS[0][0],
    fontSize: num(s.fontSize, 6, 72, 12),
    lineSpacing: num(s.lineSpacing, 0.5, 4, 1.5)
  };
}
function compDocStyle() {
  const t = compTypography(comp.settings);
  return `font-family:${t.font};font-size:${t.fontSize}pt;line-height:${t.lineSpacing};`;
}
/* Screen/HTML/EPUB stylesheet for the compiled document (no print rules). */
function compileCSS() {
  return `.comp-doc{color:#111;max-width:46em;margin:0 auto;text-align:left;}
     .comp-doc.comp-justify p{text-align:justify;}
     .comp-doc.comp-indent p{text-indent:1.27cm;margin:0;}
     .comp-doc.comp-indent p.c-sep{text-indent:0;}
     .comp-doc.comp-paraspace p{margin-bottom:6pt;}
     .comp-doc p{margin:0 0 .2em;}
     .comp-doc h1,.comp-doc h2{font-family:inherit;text-align:center;font-weight:700;}
     .comp-doc h1.c-part{font-size:2em;margin:2em 0 1em;letter-spacing:.05em;}
     .comp-doc h1.c-chapter{font-size:1.7em;margin:1.6em 0 1em;}
     .comp-doc h2.c-scene{font-size:1.2em;margin:1.2em 0 .6em;color:#333;}
     .comp-doc .c-sep{text-align:center;margin:1.2em 0;color:#555;}
     .comp-doc .c-titlepage{text-align:center;padding:32% 0 0;}
     .comp-doc .c-booktitle{font-size:2.6em;margin:0 0 .3em;}
     .comp-doc .c-subtitle{font-size:1.3em;color:#444;font-style:italic;}
     .comp-doc .c-author{margin-top:2em;font-size:1.15em;}
     .comp-doc .c-toc ul{list-style:none;padding:0;} .comp-doc .c-toc a{color:#111;text-decoration:none;}
     .comp-doc .c-toc-scene{padding-left:1.5em;color:#444;font-size:.95em;}
     .comp-doc .c-toc-title{font-size:1.7em;}`;
}

export function renderCompPreview() {
  const s = comp.settings;
  const host = $('#compPreview');
  host.innerHTML = `<style>${compileCSS()}</style>` +
    `<div class="${compDocClasses()}" style="${compDocStyle()}">${docBodyHTML(false)}</div>`;
}

/* ---- exporters ---- */
function compFileName(ext) { return (comp.settings.titleText || novel.title || 'novel').replace(/[\\/:*?"<>|]+/g, '_') + '.' + ext; }
async function saveTextFile(name, content) {
  if (hasTauri) {
    const path = await pickPath('pick_save', { defaultName: name });
    if (!path) return;
    try {
      await invoke('write_text', { path, content });
      toast('Saved ' + baseName(path));
    } catch (e) {
      console.error(e);
      toast('Export failed');
    }
  } else { downloadFile(name, content); toast('Exported ' + name); }
}
/* --- compile-txt:start --- reads the comp/novel state; test/compile-txt.test.js lifts it
   and injects stand-ins for them. --- */
function compileTXT() {
  const s = comp.settings;
  const flow = compFlow();
  const L = [];
  if (s.titlePage) {
    L.push((s.titleText || novel.title).toUpperCase());
    if (s.subtitle) L.push(s.subtitle);
    if (s.author) L.push('by ' + s.author);
    if (s.dateText) L.push(s.dateText);
    L.push('', '');
  }
  const tocEntries = compTocEntries(flow, s);
  if (s.toc && tocEntries.length) {
    L.push(tocLabel(resolveLanguage(novel)).toUpperCase(), '');
    tocEntries.forEach(f => L.push((f.type === 'scene' ? '    ' : '') + f.title));
    L.push('', '');
  }
  let lastScene = false;
  flow.forEach(f => {
    if (f.type === 'part') { L.push('', '', f.title.toUpperCase(), ''); lastScene = false; }
    else if (f.type === 'chapter') { L.push('', '', f.title.toUpperCase(), ''); lastScene = false; }
    else if (f.type === 'break') { L.push('', sepText(s) || '* * *', ''); lastScene = false; }
    else {
      if (lastScene) L.push('', sepText(s) || '', '');
      if (f.showTitle) L.push(f.title, '');
      L.push(stripHtml(f.html).trim(), '');
      lastScene = true;
    }
  });
  return L.join('\n').replace(/\n{4,}/g, '\n\n\n');   // never more than two blank lines in a row
}
/* --- compile-txt:end --- */
function compileHTML() {
  const s = comp.settings;
  return `<!DOCTYPE html><html lang="${escAttr(resolveLanguage(novel))}"><head><meta charset="utf-8"><title>${esc(s.titleText || novel.title)}</title>
<style>body{background:#fff;margin:0;padding:40px 20px;}${compileCSS()}</style></head>
<body><div class="${compDocClasses()}" style="${compDocStyle()}">${docBodyHTML(false)}</div></body></html>`;
}
export async function doCompExport(kind) {
  if (!comp || !comp.items.length) { toast('Nothing to compile'); return; }
  saveCurrentScene();
  if (kind === 'txt') return await saveTextFile(compFileName('txt'), compileTXT());
  if (kind === 'html') return await saveTextFile(compFileName('html'), compileHTML());
  if (kind === 'pdf') return await exportCompPDF();
  if (kind === 'epub') return await exportCompEPUB();
  if (kind === 'docx') return await exportCompDOCX();
}
/* ---- binary output helpers (ZIP / base64) ----
   IPC arguments travel as JSON, so binary exports cross to write_binary as base64. The
   0x8000-byte chunks keep String.fromCharCode.apply under the engine's argument limit. */
function bytesToBase64(bytes) {
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
async function saveBinary(name, bytes, mime) {
  if (hasTauri) {
    const path = await pickPath('pick_save', { defaultName: name });
    if (!path) return;
    try {
      await invoke('write_binary', { path, base64: bytesToBase64(bytes) });
      toast('Saved ' + baseName(path));
    } catch (e) {
      console.error(e);
      toast('Export failed');
    }
  } else {
    const blob = new Blob([bytes], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Exported ' + name);
  }
}

/* Raw TrueType files bundled for PDF embedding. Deliberately separate from the
   src/fonts/*.woff2 web fonts used by the editor UI: woff2 is compressed and cannot be
   dropped into a PDF, embedding needs the uncompressed TrueType tables. */
const PDF_FONT_FILES = {
  F1: 'fonts/pdf/IBMPlexMono-Regular.ttf',
  F2: 'fonts/pdf/IBMPlexMono-Bold.ttf',
  F3: 'fonts/pdf/IBMPlexMono-Italic.ttf'
};
const pdfFontCache = {};
export async function loadPdfFont(res) {
  if (pdfFontCache[res]) return pdfFontCache[res];
  const url = PDF_FONT_FILES[res];
  let r;
  try { r = await fetch(url); }
  catch (e) { throw new Error(`could not read the embedded font ${url} (${e.message})`); }
  if (!r.ok) throw new Error(`could not read the embedded font ${url} (HTTP ${r.status})`);
  return (pdfFontCache[res] = parseTrueType(new Uint8Array(await r.arrayBuffer())));
}
/* One char per byte (0-255), so the font file can be spliced into the PDF string and the
   final `charCodeAt & 0xff` cast turns it back into the same bytes. */
function bytesToBinary(bytes) {
  let s = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return s;
}
async function exportCompPDF() {
  const s = comp.settings;
  const flow = compFlow();
  // Points: Letter 8.5×11 in, A4 210×297 mm. Margins ≈ 15 / 23 / 32 mm.
  const pageW = s.pageSize === 'Letter' ? 612 : 595;
  const pageH = s.pageSize === 'Letter' ? 792 : 842;
  const marg = ({ narrow: 42, normal: 64, wide: 90 })[s.margins] || 64;
  const size = s.fontSize || 12;
  const lh = size * (s.lineSpacing || 1.5);
  const usableW = pageW - marg * 2;
  const charW = size * 0.6;                       // IBM Plex Mono advance = 0.6em
  const maxChars = Math.max(8, Math.floor(usableW / charW));
  const F = { normal: 'F1', bold: 'F2', italic: 'F3' };   // font resource names, keys of PDF_FONT_FILES

  const layout = createPdfLayout({
    pageW, pageH, margin: marg, fontSize: size, lineHeight: lh,
    usableWidth: usableW, charWidth: charW, maxChars, fonts: F
  });
  // The page builder stays free of app state, so the title fallback and language resolve here.
  buildPdfPages(flow, { ...s, titleText: s.titleText || novel.title || 'Untitled', language: resolveLanguage(novel) }, layout, htmlToBlocks);
  const pages = layout.finish();

  // serialize — embed only the styles the document actually uses
  const usedRes = new Set();
  pages.forEach(pg => pg.forEach(l => (l.segs || [l]).forEach(sg => usedRes.add(sg.font))));
  if (s.pageNumber && s.pageNumber !== 'none') usedRes.add(F.normal);
  if (!usedRes.size) usedRes.add(F.normal);

  let fonts;
  try {
    const list = [...usedRes];
    const loaded = await Promise.all(list.map(loadPdfFont));
    fonts = {};
    list.forEach((res, i) => (fonts[res] = loaded[i]));
  } catch (e) {
    toast('PDF export failed — ' + e.message);
    return;
  }

  /* The file is built as a JS string in which every char is one byte: font files go in via
     bytesToBinary(), text only as ASCII hex glyph ids. That is what makes string lengths
     valid /Length values and string offsets valid xref byte offsets. Objects that point at
     later ones (catalog, page tree, ToUnicode) get their number reserved now and their body
     filled in once the targets exist. Per font: FontFile2 stream -> FontDescriptor ->
     CIDFontType2 descendant -> Type0 font, which is what the page resources reference. */
  const objs = [];
  const add = body => { objs.push(body); return objs.length; };   // returns 1-based obj number
  const catalog = add('');            // 1 (filled later)
  const pagesObj = add('');           // 2

  const reports = {}, fontRefs = {};
  Object.keys(fonts).forEach(res => {
    const f = fonts[res];
    const toUni = add('');            // reserved; filled once every page is encoded
    reports[res] = { missing: new Set(), used: new Map(), toUni };
    const raw = bytesToBinary(f.bytes);
    // /Length1 is the decoded font length; with no filter it equals /Length.
    const fileObj = add(`<< /Length ${raw.length} /Length1 ${raw.length} >>\nstream\n${raw}\nendstream`);
    // Flag bits: 1 FixedPitch, 4 Symbolic (glyphs are addressed by id, outside any standard
    // Latin charset), 64 Italic. StemV is required but unmeasured: a weight-based guess.
    const flags = 4 | (f.fixedPitch ? 1 : 0) | (f.italicAngle ? 64 : 0);
    const desc = add(`<< /Type /FontDescriptor /FontName /${f.psName} /Flags ${flags} ` +
      `/FontBBox [${f.bbox.join(' ')}] /ItalicAngle ${f.italicAngle} /Ascent ${f.ascent} ` +
      `/Descent ${f.descent} /CapHeight ${f.capHeight} /StemV ${f.weight >= 600 ? 140 : 80} ` +
      `/FontFile2 ${fileObj} 0 R >>`);
    // CID = glyph id (Identity encoding + /CIDToGIDMap /Identity); /DW, the default width,
    // covers every glyph of a monospaced font, so no /W array is needed.
    const cidFont = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${f.psName} ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${desc} 0 R /DW ${f.advance} /CIDToGIDMap /Identity >>`);
    fontRefs[res] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${f.psName} ` +
      `/Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${toUni} 0 R >>`);
  });
  const fontDict = `<< /Font << ${Object.keys(fontRefs).map(r => `/${r} ${fontRefs[r]} 0 R`).join(' ')} >> >>`;

  const pageRefs = [];
  pages.forEach((pg, pi) => {
    let stream = 'BT\n';
    pg.forEach(l => {
      // Position once per line; each Tj advances the text position past the glyphs it drew,
      // so a mixed-font line's later segments start exactly where the previous one ended.
      stream += `1 0 0 1 ${l.x.toFixed(2)} ${l.y.toFixed(2)} Tm `;
      (l.segs || [l]).forEach(sg => {
        const res = fonts[sg.font] ? sg.font : F.normal;
        stream += `/${res} ${l.fs} Tf <${pdfGlyphHex(sg.text, fonts[res], reports[res])}> Tj `;
      });
      stream += '\n';
    });
    if (s.pageNumber && s.pageNumber !== 'none') {
      // drawn inside the bottom margin, below the last text line
      const label = String((s.startPage || 1) + pi);
      const pnx = s.pageNumber === 'right' ? (pageW - marg - label.length * (size * 0.6)) : (pageW / 2 - label.length * (size * 0.6) / 2);
      stream += `/${F.normal} ${Math.max(9, size - 1)} Tf 1 0 0 1 ${pnx.toFixed(2)} ${(marg * 0.6).toFixed(2)} Tm ` +
        `<${pdfGlyphHex(label, fonts[F.normal], reports[F.normal])}> Tj\n`;
    }
    stream += 'ET';
    const contentNum = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const pageNum = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources ${fontDict} /Contents ${contentNum} 0 R >>`);
    pageRefs.push(pageNum);
  });
  Object.keys(reports).forEach(res => {
    const cm = pdfToUnicodeCMap(reports[res].used);
    objs[reports[res].toUni - 1] = `<< /Length ${cm.length} >>\nstream\n${cm}\nendstream`;
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageRefs.map(n => n + ' 0 R').join(' ')}] /Count ${pageRefs.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets[i] = pdf.length; pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xrefStart = pdf.length;
  // Every xref entry must be exactly 20 bytes, hence the space before each '\n'. Entry 0 is
  // the mandatory free-list head.
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(off => { pdf += String(off).padStart(10, '0') + ' 00000 n \n'; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const bytes = Uint8Array.from(pdf, c => c.charCodeAt(0) & 0xff);
  await saveBinary(compFileName('pdf'), bytes, 'application/pdf');

  // Anything the font could not cover was drawn as .notdef — say so instead of hiding it.
  const missing = new Set();
  Object.keys(reports).forEach(res => reports[res].missing.forEach(ch => missing.add(ch)));
  if (missing.size) {
    const list = [...missing].slice(0, 12).join(' ');
    toast(`PDF: ${missing.size} character(s) are missing from the embedded font and rendered blank: ${list}`);
  }
}
async function exportCompEPUB() {
  const s = comp.settings;
  const title = s.titleText || novel.title || 'Untitled';
  const author = s.author || 'Unknown';
  const uid = 'urn:uuid:' + uuid();
  const modifiedISO = new Date().toISOString().replace(/\.\d+Z$/, 'Z');   // dcterms:modified allows no fractional seconds
  const flow = compFlow();
  const body = flowToBodyHTML(flow, true);
  const lang = resolveLanguage(novel);
  const inner = titlePageHTMLx() + (s.toc && s.tocPosition === 'afterTitle' ? tocHTMLx(flow, lang) : '') + body + (s.toc && s.tocPosition === 'end' ? tocHTMLx(flow, lang) : '');
  const navEntries = compTocEntries(flow, s);
  // A book with no parts/chapters still needs one nav target, so fall back to the book itself.
  const navItems = navEntries.length ? navEntries : [{ anchor: null, title }];
  const typo = compTypography(s);
  const css = `html,body{margin:0;padding:1em;font-family:${typo.font};font-size:${typo.fontSize}pt;line-height:${typo.lineSpacing};}\n` + compileCSS();
  const bookXhtml = buildEpubBookXhtml({ title, lang, docClasses: compDocClasses(), innerHtml: inner });
  const navXhtml = buildEpubNavXhtml({ navItems, lang });
  const ncx = buildEpubNcxXml({ uid, title, navItems, lang });
  const opf = buildEpubOpfXml({ uid, title, author, modifiedISO, lang });
  const container = buildEpubContainerXml();
  const enc = new TextEncoder();
  // mimetype must come first: readers sniff its content at a fixed offset (byte 38), which
  // holds only because makeZip() stores it with no extra field.
  const files = [
    { name: 'mimetype', bytes: enc.encode('application/epub+zip') },
    { name: 'META-INF/container.xml', bytes: enc.encode(container) },
    { name: 'OEBPS/content.opf', bytes: enc.encode(opf) },
    { name: 'OEBPS/nav.xhtml', bytes: enc.encode(navXhtml) },
    { name: 'OEBPS/toc.ncx', bytes: enc.encode(ncx) },
    { name: 'OEBPS/book.xhtml', bytes: enc.encode(bookXhtml) },
    { name: 'OEBPS/style.css', bytes: enc.encode(css) }
  ];
  await saveBinary(compFileName('epub'), makeZip(files), 'application/epub+zip');
}
/* EPUB counterparts of titlePageHTML()/tocHTML(); keep the markup in step. tocHTMLx takes
   the language its caller already resolved. */
function titlePageHTMLx() {
  const s = comp.settings;
  if (!s.titlePage) return '';
  return `<section class="c-titlepage"><h1 class="c-booktitle">${esc(s.titleText || novel.title)}</h1>` +
    (s.subtitle ? `<p class="c-subtitle">${esc(s.subtitle)}</p>` : '') +
    (s.author ? `<p class="c-author">${esc(s.author)}</p>` : '') +
    (s.dateText ? `<p class="c-date">${esc(s.dateText)}</p>` : '') + `</section>`;
}
function tocHTMLx(flow, lang) {
  const s = comp.settings;
  if (!s.toc) return '';
  const entries = compTocEntries(flow, s);
  if (!entries.length) return '';
  return `<section class="c-toc"><h1 class="c-toc-title">${esc(tocLabel(lang))}</h1><ul>` +
    entries.map(f => `<li class="c-toc-${f.type}"><a href="#${f.anchor}">${esc(f.title)}</a></li>`).join('') + `</ul></section>`;
}
/* Scene HTML -> [{ tag: 'p'|'h1'|'h2'|'h3', runs: [{ text, b, i }] }], one block per
   top-level node; shared by the DOCX and PDF exporters. Only bold/italic survive, and
   a <br> becomes a '\n' run. */
function htmlToBlocks(html) {
  const d = parseInert(html);
  const blocks = [];
  const runsOf = (node, b, i) => {
    let out = [];
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) { if (ch.textContent) out.push({ text: ch.textContent, b, i }); return; }
      const t = ch.tagName;
      if (t === 'BR') { out.push({ text: '\n', b, i }); return; }
      out = out.concat(runsOf(ch, b || /^(B|STRONG)$/.test(t), i || /^(I|EM)$/.test(t)));
    });
    return out;
  };
  Array.from(d.childNodes).forEach(ch => {
    if (ch.nodeType === 3) { if (ch.textContent.trim()) blocks.push({ tag: 'p', runs: [{ text: ch.textContent }] }); return; }
    const t = ch.tagName;
    const tag = (t === 'H1' || t === 'H2' || t === 'H3') ? t.toLowerCase() : 'p';
    blocks.push({ tag, runs: runsOf(ch, false, false) });
  });
  if (!blocks.length && stripHtml(html).trim()) blocks.push({ tag: 'p', runs: [{ text: stripHtml(html) }] });
  return blocks;
}
async function exportCompDOCX() {
  const s = comp.settings;
  const flow = compFlow();
  // The builders stay free of app state, so the title-page fallback resolves here.
  const bodyXml = buildDocxBodyXml(flow, { ...s, titleText: s.titleText || novel.title, language: resolveLanguage(novel) }, htmlToBlocks);
  const documentXml = buildDocxDocumentXml({ bodyXml, pageSize: s.pageSize });
  const contentTypes = buildDocxContentTypesXml();
  const rels = buildDocxRelsXml();
  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', bytes: enc.encode(contentTypes) },
    { name: '_rels/.rels', bytes: enc.encode(rels) },
    { name: 'word/document.xml', bytes: enc.encode(documentXml) }
  ];
  await saveBinary(compFileName('docx'), makeZip(files), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
