/* EPUB 3 package builders. An EPUB is a ZIP whose first entry is the uncompressed `mimetype`; META-INF/container.xml points at
   OEBPS/content.opf, which lists the parts and the spine. The whole book is one
   book.xhtml, so TOC links are fragment links to the flow's heading anchors. nav.xhtml is
   the EPUB 3 table of contents; toc.ncx duplicates it for EPUB 2 readers. Every XHTML part
   must be well-formed XML: scene HTML goes through normalizeSceneHTML(…, true).

   These builders are deterministic: the identifier and the dcterms:modified timestamp are
   computed once in exportCompEPUB() and passed in, so the package XML is reproducible for a
   fixed input. The body of the book (flowToBodyHTML/normalizeSceneHTML) needs a real DOM and
   lives in compile-export.js. */
import { esc } from './text.js';
import { tocLabel } from './compile-flow.js';

export function buildEpubContainerXml() {
  return `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
}
export function buildEpubOpfXml({ uid, title, author, modifiedISO, lang }) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${uid}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><dc:language>${esc(lang)}</dc:language><meta property="dcterms:modified">${modifiedISO}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/></manifest><spine toc="ncx"><itemref idref="book"/></spine></package>`;
}
export function buildEpubNavXhtml({ navItems, lang }) {
  const label = esc(tocLabel(lang));
  const navOl = navItems.map(f => `<li><a href="book.xhtml${f.anchor ? '#' + f.anchor : ''}">${esc(f.title)}</a></li>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}"><head><meta charset="utf-8"/><title>${label}</title></head><body><nav epub:type="toc" id="toc"><h1>${label}</h1><ol>${navOl}</ol></nav></body></html>`;
}
export function buildEpubNcxXml({ uid, title, navItems, lang }) {
  const ncxPts = navItems.map((f, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${esc(f.title)}</text></navLabel><content src="book.xhtml${f.anchor ? '#' + f.anchor : ''}"/></navPoint>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${esc(lang)}"><head><meta name="dtb:uid" content="${uid}"/></head><docTitle><text>${esc(title)}</text></docTitle><navMap>${ncxPts}</navMap></ncx>`;
}
export function buildEpubBookXhtml({ title, lang, docClasses, innerHtml }) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${esc(lang)}" lang="${esc(lang)}"><head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><div class="${docClasses}">${innerHtml}</div></body></html>`;
}
