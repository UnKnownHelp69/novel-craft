/* PDF export without a print dialog or a library: the compiled text is laid out into
   paginated pages set in IBM Plex Mono (SIL OFL 1.1, bundled as raw .ttf in src/fonts/pdf/),
   embedded in the file as a Type0 / Identity-H composite font.

   Why an embedded font: the PDF standard-14 fonts (Courier & co.) contain no Cyrillic
   glyphs at all, so they cannot render Russian text under any encoding. IBM Plex Mono
   covers Latin + Cyrillic + Greek and is monospaced at exactly 600/1000 em, which is the
   advance the layout code below assumes (`size * 0.6` per glyph) — there is no per-glyph
   width measuring, so the layout is only right for a monospaced font. Identity-H means the
   content stream carries 2-byte glyph ids as hex strings instead of Latin-1 literals.
   The whole font file is embedded, not a subset. Coordinates are PDF points (1/72 in) with
   the origin at the bottom-left of the page, so the layout cursor moves down by decreasing y.
   Reading the font files and writing the PDF objects happen in compile-export.js. */
import { compTocEntries, sepText, tocLabel } from './compile-flow.js';

/* Whitespace and control-character cleanup only. Typography — dashes, ellipses, curly and
   angle quotes — passes through untouched: the embedded font draws all of it (the tests pin
   that), and the em dash that opens every line of dialogue in Russian prose must stay an em
   dash. There is no codepoint ceiling here; the embedded font is responsible for the glyphs. */
export function normalizeForPdf(str) {
  let o = '';
  for (const ch of (str || '')) {
    const code = ch.codePointAt(0);
    if (code === 0x00A0) { o += ' '; continue; }
    if (code === 9) { o += '    '; continue; }
    if (code === 10 || code === 13) { o += ' '; continue; }
    if (code < 32) continue;
    o += ch;
  }
  return o;
}
/* Glyph count, not UTF-16 code units — all the layout maths is per-glyph. */
export function pdfLen(str) { return [...(str || '')].length; }

/* cmap subtable reader: formats 4 (BMP) and 12 (full Unicode) cover every font we
   bundle and virtually every TrueType font in the wild. Of the subtables present it takes
   the best by score: Windows full-Unicode (3,10) format 12 > any Unicode-platform (0,*)
   format 12 > Windows BMP (3,1) format 4 > Unicode-platform format 4. All values are
   big-endian (DataView's default). */
function readTtfCmap(dv, bytes, cmapOff) {
  const n = dv.getUint16(cmapOff + 2);
  let best = null, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const p = cmapOff + 4 + i * 8;
    const pid = dv.getUint16(p), eid = dv.getUint16(p + 2);
    const off = cmapOff + dv.getUint32(p + 4);
    const fmt = dv.getUint16(off);
    let score = -1;
    if (pid === 3 && eid === 10 && fmt === 12) score = 4;
    else if (pid === 0 && fmt === 12) score = 3;
    else if (pid === 3 && eid === 1 && fmt === 4) score = 2;
    else if (pid === 0 && fmt === 4) score = 1;
    if (score > bestScore) { bestScore = score; best = { off, fmt }; }
  }
  if (!best) throw new Error('font has no usable cmap subtable');
  const map = new Map();
  if (best.fmt === 4) {
    // Four parallel arrays of segX2/2 entries follow the 14-byte header: endCode, (2-byte
    // pad) startCode, idDelta, idRangeOffset. A nonzero idRangeOffset is a byte offset
    // from that very array slot into glyphIdArray. The 0xFFFF code is the end sentinel.
    const o = best.off, segX2 = dv.getUint16(o + 6);
    const endO = o + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = dv.getUint16(endO + i * 2), start = dv.getUint16(startO + i * 2);
      const delta = dv.getInt16(deltaO + i * 2), ro = dv.getUint16(rangeO + i * 2);
      if (start > end) continue;
      for (let c = start; c <= end && c < 0xFFFF; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xFFFF;
        else {
          const gi = rangeO + i * 2 + ro + (c - start) * 2;
          if (gi + 1 >= bytes.byteLength) continue;
          g = dv.getUint16(gi);
          if (g) g = (g + delta) & 0xFFFF;
        }
        if (g) map.set(c, g);
      }
    }
  } else {
    // format 12: 16-byte header, then groups of (startCode, endCode, startGlyphId), 12 bytes each
    const o = best.off, groups = dv.getUint32(o + 12);
    for (let i = 0; i < groups; i++) {
      const p = o + 16 + i * 12;
      const sc = dv.getUint32(p), ec = dv.getUint32(p + 4), sg = dv.getUint32(p + 8);
      for (let c = sc; c <= ec; c++) map.set(c, sg + (c - sc));
    }
  }
  return map;
}
/* PostScript name (name id 6), sanitised for use as a PDF name object. A Windows-platform
   record (UTF-16BE) wins; a Mac one (single-byte) is the fallback. */
function readTtfPsName(dv, nameTbl) {
  if (!nameTbl) return '';
  const off = nameTbl.off, count = dv.getUint16(off + 2), strOff = off + dv.getUint16(off + 4);
  const clean = s => (s || '').replace(/[\s()<>[\]{}/%#]|[^\x21-\x7E]/g, '');
  let mac = '';
  for (let i = 0; i < count; i++) {
    const p = off + 6 + i * 12;
    const pid = dv.getUint16(p), nid = dv.getUint16(p + 6);
    if (nid !== 6) continue;
    const len = dv.getUint16(p + 8), so = strOff + dv.getUint16(p + 10);
    if (pid === 3) {
      let s = '';
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(so + k));
      return clean(s);
    }
    if (pid === 1 && !mac) for (let k = 0; k < len; k++) mac += String.fromCharCode(dv.getUint8(so + k));
  }
  return clean(mac);
}
/* Read just enough of a TrueType file to embed it and map codepoints -> glyph ids.
   All metrics are returned in PDF glyph space (1000ths of an em). The numeric offsets are
   field positions from the OpenType spec: head (unitsPerEm @18, xMin..yMax @36-42), hhea
   (ascender @4, descender @6, numberOfHMetrics @34), maxp (numGlyphs @4), post
   (italicAngle 16.16 @4, isFixedPitch @12), OS/2 (usWeightClass @4, sCapHeight @88, which
   exists from table version 2). Accepts 0x00010000 and Apple's 'true' sfnt tags; CFF-based
   ('OTTO') fonts are rejected because /FontFile2 only takes glyf outlines. */
export function parseTrueType(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sfnt = dv.getUint32(0);
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565) throw new Error('not a TrueType (glyf) font');
  const tbl = {};
  for (let i = 0, n = dv.getUint16(4); i < n; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    tbl[tag] = { off: dv.getUint32(p + 8), len: dv.getUint32(p + 12) };
  }
  ['head', 'hhea', 'hmtx', 'maxp', 'cmap'].forEach(t => {
    if (!tbl[t]) throw new Error('font is missing its ' + t + ' table');
  });
  const head = tbl.head.off, hhea = tbl.hhea.off, os2 = tbl['OS/2'];
  const unitsPerEm = dv.getUint16(head + 18) || 1000;
  const scale = v => Math.round(v * 1000 / unitsPerEm);
  const numHMetrics = dv.getUint16(hhea + 34) || 1;
  const cmap = readTtfCmap(dv, bytes, tbl.cmap.off);
  const spaceGid = cmap.get(32);
  const f = {
    bytes, unitsPerEm,
    numGlyphs: dv.getUint16(tbl.maxp.off + 4),
    cmap,
    // monospaced font -> one advance for every glyph, which is what /DW encodes. Taken from
    // the space glyph's hmtx entry; glyphs past numberOfHMetrics share the last one.
    advance: scale(dv.getUint16(tbl.hmtx.off + Math.min(spaceGid == null ? 1 : spaceGid, numHMetrics - 1) * 4)),
    bbox: [scale(dv.getInt16(head + 36)), scale(dv.getInt16(head + 38)), scale(dv.getInt16(head + 40)), scale(dv.getInt16(head + 42))],
    ascent: scale(dv.getInt16(hhea + 4)),
    descent: scale(dv.getInt16(hhea + 6)),
    italicAngle: tbl.post ? dv.getInt32(tbl.post.off + 4) / 65536 : 0,
    fixedPitch: tbl.post ? dv.getUint32(tbl.post.off + 12) !== 0 : false,
    weight: os2 ? dv.getUint16(os2.off + 4) : 400,
    psName: readTtfPsName(dv, tbl.name) || 'EmbeddedFont'
  };
  const cap = (os2 && dv.getUint16(os2.off) >= 2 && os2.len >= 90) ? scale(dv.getInt16(os2.off + 88)) : 0;
  f.capHeight = cap || Math.round(f.ascent * 0.7);
  return f;
}
/* Encode text as Identity-H glyph ids (four hex digits each). Characters the font does
   not cover become glyph 0 (.notdef) — which draws an obvious empty box rather than a
   plausible-looking '?' — and are collected so the caller can say so out loud. */
export function pdfGlyphHex(text, font, report) {
  let out = '';
  for (const ch of (text || '')) {
    const gid = font.cmap.get(ch.codePointAt(0));
    if (gid == null) { if (report) report.missing.add(ch); out += '0000'; continue; }
    if (report) report.used.set(gid, ch.codePointAt(0));
    out += gid.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}
/* /ToUnicode CMap, so the text stays selectable, searchable and copy-pasteable. Maps each
   glyph id used to its codepoint (UTF-16BE, a surrogate pair above the BMP), in
   beginbfchar blocks of at most 100 entries — the limit the CMap format sets per block. */
export function pdfToUnicodeCMap(used) {
  const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');
  const uni = cp => {
    if (cp <= 0xFFFF) return hex4(cp);
    const v = cp - 0x10000;
    return hex4(0xD800 + (v >> 10)) + hex4(0xDC00 + (v & 0x3FF));
  };
  const entries = [...used.entries()].sort((a, b) => a[0] - b[0]);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += chunk.length + ' beginbfchar\n' +
      chunk.map(([g, cp]) => `<${hex4(g)}> <${uni(cp)}>`).join('\n') + '\nendbfchar\n';
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${body}endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}
/* The PDF pagination engine: a cursor moving
   down a growing list of pages, where every emitted line is a plain
   {x, y, text, font, fs} record that exportCompPDF() later turns into PDF text-showing
   operators. This factory owns the only mutable layout state there is — the finished
   pages, the page in progress and the vertical cursor — which is why callers get
   startPage()/finish() instead of reaching into that state themselves. A line written in
   more than one font (a paragraph's bold/italic runs, via wrapRuns()) also carries its
   same-font segments as .segs. */
export function createPdfLayout({ pageW, pageH, margin, fontSize, lineHeight, usableWidth, charWidth, maxChars, fonts }) {
  const pages = []; let cur = []; let y = pageH - margin;
  const newPage = () => { pages.push(cur); cur = []; y = pageH - margin; };
  const ensure = () => { if (y - lineHeight < margin) newPage(); };
  const line = (text, opts = {}) => {
    ensure();
    const font = opts.font || fonts.normal;
    const fs = opts.fsize || fontSize;
    const cw = fs * 0.6;
    let x = margin + (opts.indent || 0) * charWidth;
    if (opts.align === 'center') x = margin + (usableWidth - pdfLen(text) * cw) / 2;
    const rec = { x: Math.max(margin, x), y, text, font, fs };
    cur.push(rec);
    y -= (opts.lh || lineHeight);
    return rec;   // callers may patch .text later (TOC page numbers); x/y are already final
  };
  const blank = (n = 1) => { y -= lineHeight * n; if (y < margin) newPage(); };
  /* Greedy line packing shared by wrap(), wrapRuns() and heading(): whole words while they
     fit, and a word too long for any line on its own is hard-broken at the glyph that fills
     the line (no hyphen, so the pieces rejoin to the exact word). Only the first line
     carries firstIndent, and it counts against that line's budget. Works on styled runs
     ({text, font}) so every glyph keeps the font of the run it came from — a word may span
     runs (`**bold**er`) — and each line comes back as its text plus the maximal same-font
     segments it is made of. The space joining two words takes the font of the glyph before
     it; the font is monospaced, so that never moves anything. */
  const packRuns = (runs, limit, firstIndent = 0) => {
    const out = [];
    let ln = [], indent = firstIndent;   // ln: the current line's glyphs, { ch, font } each
    const push = () => {
      const segs = [];
      ln.forEach(g => {
        const last = segs[segs.length - 1];
        if (last && last.font === g.font) last.text += g.ch;
        else segs.push({ text: g.ch, font: g.font });
      });
      out.push({ text: ln.map(g => g.ch).join(''), indent, segs });
      ln = []; indent = 0;
    };
    // pieces (split at hard line breaks) -> words -> glyphs; a word only ends at whitespace
    const pieces = [[]];
    let word = null;
    runs.forEach(r => {
      String(r.text || '').split('\n').forEach((part, k) => {
        if (k > 0) { pieces.push([]); word = null; }
        for (const ch of normalizeForPdf(part)) {   // code points, the unit pdfLen() measures in
          if (/\s/.test(ch)) { word = null; continue; }
          if (!word) pieces[pieces.length - 1].push(word = []);
          word.push({ ch, font: r.font });
        }
      });
    });
    pieces.forEach((words, i) => {
      if (i > 0) push();
      words.forEach(w => {
        if (ln.length && ln.length + 1 + w.length + indent <= limit) {
          ln.push({ ch: ' ', font: ln[ln.length - 1].font }, ...w);
          return;
        }
        if (ln.length) push();
        let g = w;
        for (let room = Math.max(1, limit - indent); g.length > room; room = Math.max(1, limit - indent)) {
          ln = g.slice(0, room); g = g.slice(room); push();
        }
        ln = g;
      });
    });
    if (ln.length) push();
    return out;
  };
  const wrapLimit = opts => (opts.fsize && !opts.maxChars)
    ? Math.max(6, Math.floor(usableWidth / (opts.fsize * 0.6)))
    : (opts.maxChars || maxChars);
  /* A line made of more than one font also carries .segs ([{text, font}], in order, joining
     to .text); its .font is then the first segment's. Single-font lines keep the plain
     record shape. */
  const emitPacked = (packed, opts) => packed.map(l => {
    const rec = line(l.text, { font: l.segs.length ? l.segs[0].font : opts.font, fsize: opts.fsize, lh: opts.lh, indent: l.indent, align: opts.align });
    if (l.segs.length > 1) rec.segs = l.segs;
    return rec;
  });
  const wrap = (text, opts = {}) =>
    emitPacked(packRuns([{ text, font: opts.font || fonts.normal }], wrapLimit(opts), opts.firstIndent || 0), opts);
  /* wrap() for a paragraph of htmlToBlocks() runs ({text, b, i}): bold runs set in the bold
     font, italic in the italic one. There is no bundled bold-italic face, so a run that is
     both falls back to bold — the more visible of the two at body size. */
  const wrapRuns = (runs, opts = {}) => {
    const base = opts.font || fonts.normal;
    const styled = (runs || []).map(r => ({ text: r.text, font: r.b ? fonts.bold : r.i ? fonts.italic : base }));
    return emitPacked(packRuns(styled, wrapLimit(opts), opts.firstIndent || 0), opts);
  };
  const heading = (text, fsize, center) => {
    ensure(); blank(0.4);
    const cw = fsize * 0.6;
    const lim = Math.max(6, Math.floor(usableWidth / cw));
    let page = null;   // index of the page the heading's first line lands on
    packRuns([{ text, font: fonts.bold }], lim).forEach(({ text: t }) => {
      line(t, { font: fonts.bold, fsize, lh: fsize * 1.3, align: center ? 'center' : 'left' });
      if (page == null) page = pages.length;   // the line just went onto `cur`, i.e. pages[pages.length]
    });
    if (page == null) page = pages.length;
    blank(0.5);
    return page;
  };
  /* Start the next run of content on a page of its own: break to a fresh page unless the
     current one is still untouched, then optionally drop the cursor to a fraction of the
     page height — how a part title and the title page start partway down. */
  const startPage = fraction => {
    if (cur.length) newPage();
    if (fraction != null) y = pageH * fraction;
  };
  /* Terminal. Flushes the page in progress, guarantees at least one page even for an
     empty document, and hands back the finished list. Call it once. */
  const finish = () => { if (cur.length || !pages.length) newPage(); return pages; };
  return { fontSize, fonts, maxChars, newPage, ensure, line, blank, wrap, wrapRuns, heading, startPage, finish };
}
/* Walks the compilation flow and decides
   what to emit into a layout built by createPdfLayout() — title page, table of contents,
   and the part/chapter/break/scene body. htmlToBlocks() needs a real DOM, so it is
   injected as htmlToBlocksFn; production passes the real one, tests pass a stub. The
   compile settings come in as an argument: the title-page fallback and settings.language
   are resolved by exportCompPDF() before the call. */
export function buildPdfPages(flow, settings, layout, htmlToBlocksFn) {
  const s = settings;
  const size = layout.fontSize;
  const F = layout.fonts;
  const { line, blank, wrap, wrapRuns, heading, newPage, startPage } = layout;

  // title page
  if (s.titlePage) {
    startPage(0.62);
    wrap(s.titleText, { font: F.bold, fsize: size + 10, lh: (size + 10) * 1.3, align: 'center' });
    if (s.subtitle) { blank(0.4); wrap(s.subtitle, { font: F.italic, align: 'center' }); }
    if (s.author) { blank(2); wrap(s.author, { align: 'center' }); }
    if (s.dateText) { blank(0.5); wrap(s.dateText, { align: 'center' }); }
    newPage();
  }
  const tocEntries = compTocEntries(flow, s);
  /* Page numbers aren't known when a leading TOC is emitted, so each entry is drawn as
     its bare title and patched once the body is laid out. One entry is always one line,
     so the patch never changes how many pages the TOC takes — no second layout pass. */
  const tocLines = [];
  const headingPage = new Map();   // flow entry -> page index its heading landed on
  const emitTOC = () => {
    if (!s.toc || !tocEntries.length) return;
    line(tocLabel(s.language), { font: F.bold, fsize: size + 4, lh: (size + 4) * 1.4, align: 'center' });
    blank(0.6);
    tocEntries.forEach(f => {
      const indent = f.type === 'scene' ? 3 : 0;
      const recs = wrap(f.title, { firstIndent: indent, maxChars: layout.maxChars - 5 });
      if (recs && recs.length) {
        tocLines.push({ f, indent: recs.length > 1 ? 0 : indent, rec: recs[recs.length - 1] });
      }
    });
    newPage();
  };
  if (s.toc && s.tocPosition === 'afterTitle') emitTOC();

  let lastScene = false;
  flow.forEach(f => {
    if (f.type === 'part') { startPage(0.5); headingPage.set(f, heading(f.title, size + 8, true)); lastScene = false; }
    else if (f.type === 'chapter') { startPage(); headingPage.set(f, heading(f.title, size + 5, true)); lastScene = false; }
    else if (f.type === 'break') { blank(0.5); line(normalizeForPdf(sepText(s) || '* * *'), { align: 'center' }); blank(0.5); lastScene = false; }
    else {
      if (lastScene) { blank(0.4); line(normalizeForPdf(sepText(s) || ''), { align: 'center' }); blank(0.4); }
      if (f.showTitle) headingPage.set(f, heading(f.title, size + 2, false));
      htmlToBlocksFn(f.html).forEach(bl => {
        const txt = bl.runs.map(r => r.text).join('');
        if (!txt.trim()) { blank(0.5); return; }
        // A heading is set entirely in bold, so its runs are flattened to their text.
        if (bl.tag[0] === 'h') heading(txt, size + (bl.tag === 'h1' ? 4 : bl.tag === 'h2' ? 2 : 1), false);
        else wrapRuns(bl.runs, { firstIndent: s.indent === 'indent' ? 5 : 0 });
      });
      lastScene = true;
    }
  });
  if (s.toc && s.tocPosition === 'end') { startPage(); emitTOC(); }

  // Same label the page footer prints (exportCompPDF): startPage + page index. Dot leaders
  // right-align the number at the margin; the font is monospaced, so glyphs are columns.
  tocLines.forEach(({ f, indent, rec }) => {
    const num = String((s.startPage || 1) + headingPage.get(f));
    const dots = layout.maxChars - indent - pdfLen(rec.text) - pdfLen(num) - 2;
    rec.text += dots > 0 ? ' ' + '.'.repeat(dots) + ' ' + num : ' ' + num;
  });
}
