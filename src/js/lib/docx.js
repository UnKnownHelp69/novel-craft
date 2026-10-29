/* DOCX builders for the smallest package Word opens: [Content_Types].xml, _rels/.rels
   (pointing at the main part) and word/document.xml. There is no styles.xml, numbering or
   fonts part, so every paragraph carries direct formatting and the typeface and base size
   are Word's defaults; the compile dialog's font and font size do not reach the DOCX. Headings are bold, sized
   paragraphs, not Heading styles. OOXML units used below: twips (1/20 pt; 1440 = 1 in),
   half-points for w:sz (32 = 16 pt), and w:line in 240ths of a line under lineRule="auto".

   The compile settings come in as an argument (settings.language included: exportCompDOCX()
   resolves it before the call), and buildDocxBodyXml() takes htmlToBlocks, which needs a
   real DOM, as a parameter; the tests pass a stub. */
import { esc } from './text.js';
import { compTocEntries, sepText, tocLabel } from './compile-flow.js';

export function xmlEsc(s) { return esc(String(s == null ? '' : s)); }
/* settings.language -> the OOXML locale every run is tagged with (spellcheck, hyphenation).
   A language missing here simply gets no w:lang, leaving it to Word's default. */
const DOCX_LOCALE = { en: 'en-US', ru: 'ru-RU' };
/* One <w:p>. w:jc "both" is justified; 720 twips = 1.27 cm, the same first-line indent as
   the HTML/EPUB CSS; w:after 120 twips = 6 pt. A '\n' in a run becomes a <w:br/>;
   xml:space="preserve" keeps leading/trailing spaces. */
export function docxP(runs, opts, settings) {
  opts = opts || {};
  const s = settings;
  let ppr = '';
  const jc = opts.align === 'center' ? 'center' : (s.align === 'justify' ? 'both' : 'left');
  ppr += `<w:jc w:val="${jc}"/>`;
  const sp = [];
  if (s.lineSpacing && s.lineSpacing !== 1) sp.push(`w:line="${Math.round(s.lineSpacing * 240)}" w:lineRule="auto"`);
  if (s.paraSpacing === 'space') sp.push('w:after="120"');
  if (sp.length) ppr += `<w:spacing ${sp.join(' ')}/>`;
  if (s.indent === 'indent' && !opts.noIndent) ppr += '<w:ind w:firstLine="720"/>';
  let rs = '';
  (runs || []).forEach(r => {
    const segs = String(r.text == null ? '' : r.text).split('\n');
    segs.forEach((seg, i) => {
      let rpr = '';
      if (r.b || opts.b) rpr += '<w:b/>';
      if (r.i || opts.i) rpr += '<w:i/>';
      if (opts.sz) rpr += `<w:sz w:val="${opts.sz}"/>`;
      if (DOCX_LOCALE[s.language]) rpr += `<w:lang w:val="${DOCX_LOCALE[s.language]}"/>`;
      rs += `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(seg)}</w:t></w:r>`;
      if (i < segs.length - 1) rs += '<w:r><w:br/></w:r>';
    });
  });
  if (!rs) rs = '<w:r><w:t xml:space="preserve"></w:t></w:r>';
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${rs}</w:p>`;
}
export function docxPageBreak() { return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'; }
export function docxTOC(flow, settings) {
  const s = settings;
  const entries = compTocEntries(flow, s);
  let x = docxP([{ text: tocLabel(s.language), b: true }], { sz: 32, align: 'center', noIndent: true }, s);
  entries.forEach(f => { x += docxP([{ text: f.title }], { noIndent: true }, s); });
  return x;
}
export function buildDocxBodyXml(flow, settings, htmlToBlocksFn) {
  const s = settings;
  let bodyXml = '';
  if (s.titlePage) {
    bodyXml += docxP([{ text: s.titleText, b: true }], { sz: 56, align: 'center', noIndent: true }, s);
    if (s.subtitle) bodyXml += docxP([{ text: s.subtitle, i: true }], { align: 'center', noIndent: true }, s);
    if (s.author) bodyXml += docxP([{ text: s.author }], { align: 'center', noIndent: true }, s);
    if (s.dateText) bodyXml += docxP([{ text: s.dateText }], { align: 'center', noIndent: true }, s);
    bodyXml += docxPageBreak();
  }
  // docxTOC() renders its heading whenever it is called, so skip it when there is nothing to list.
  const hasToc = s.toc && compTocEntries(flow, s).length > 0;
  if (hasToc && s.tocPosition === 'afterTitle') { bodyXml += docxTOC(flow, s); bodyXml += docxPageBreak(); }
  let lastScene = false;
  flow.forEach(f => {
    if (f.type === 'part') { bodyXml += docxP([{ text: f.title, b: true }], { sz: 44, align: 'center', noIndent: true }, s); lastScene = false; }
    else if (f.type === 'chapter') { bodyXml += docxP([{ text: f.title, b: true }], { sz: 34, align: 'center', noIndent: true }, s); lastScene = false; }
    else if (f.type === 'break') { bodyXml += docxP([{ text: sepText(s) || '* * *' }], { align: 'center', noIndent: true }, s); lastScene = false; }
    else {
      if (lastScene) bodyXml += docxP([{ text: sepText(s) || '' }], { align: 'center', noIndent: true }, s);
      if (f.showTitle) bodyXml += docxP([{ text: f.title, b: true }], { sz: 26, noIndent: true }, s);
      htmlToBlocksFn(f.html).forEach(bl => {
        const heading = bl.tag[0] === 'h';
        const sz = bl.tag === 'h1' ? 32 : bl.tag === 'h2' ? 28 : bl.tag === 'h3' ? 24 : null;
        bodyXml += docxP(bl.runs, { sz, b: heading || undefined, noIndent: heading }, s);
      });
      lastScene = true;
    }
  });
  if (hasToc && s.tocPosition === 'end') { bodyXml += docxPageBreak(); bodyXml += docxTOC(flow, s); }
  return bodyXml;
}
/* Page size in twips (Letter 8.5×11 in, A4 210×297 mm) with fixed 1-inch margins; the
   dialog's margin choice applies to the PDF only. w:sectPr must be the last child of w:body. */
export function buildDocxDocumentXml({ bodyXml, pageSize }) {
  const letter = pageSize === 'Letter';
  const sect = `<w:sectPr><w:pgSz w:w="${letter ? 12240 : 11906}" w:h="${letter ? 15840 : 16838}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}${sect}</w:body></w:document>`;
}
export function buildDocxContentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
}
export function buildDocxRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
}
