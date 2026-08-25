/* Coverage for the EPUB envelope builders — container.xml, content.opf, nav.xhtml,
 * toc.ncx and the book.xhtml wrapper.
 *
 * An EPUB is a zip of XML documents that a reader validates before it will open anything:
 * a dc:identifier that disagrees with the NCX's dtb:uid, a dcterms:modified that is not a
 * well-formed timestamp, an unescaped '&' in a title, or a nav document with no entries at
 * all are each enough to get the file rejected outright. None of that is visible in the
 * app — it surfaces on someone else's e-reader — so these builders are worth pinning.
 *
 * The two values that used to make the package XML untestable, the uuid and the current
 * time, are now computed once in exportCompEPUB() and handed in. That is the point of the
 * extraction, so several tests below assert the builders reproduce exactly what they were
 * given rather than minting anything of their own.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * builders are lifted out between marker comments and run here in isolation — the same
 * technique as test/build-flow.test.js, test/comp-toc.test.js, test/zip-writer.test.js,
 * test/docx-strings.test.js, test/pdf-cyrillic.test.js and test/migrate-novel.test.js.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readZip } from './helpers/zip-reader.js';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

function sliceMarker(name) {
  const startMark = `/* --- ${name}:start ---`;
  const endMark = `/* --- ${name}:end --- */`;
  const start = APP.indexOf(startMark);
  const end = APP.indexOf(endMark);
  assert.ok(start !== -1 && end > start,
    `${name} markers missing from src/app.js — the code moved, update this test`);
  return APP.slice(start, end);
}

function load() {
  // numWord + ONES/TENS back chapterHeadingText() inside the build-flow block; they sit
  // outside every marker pair, so pull them in by locating the constant declaration.
  // (Same extraction as test/build-flow.test.js.)
  const onesIdx = APP.indexOf("const ONES = ['',");
  const numWordEnd = APP.indexOf('\n', APP.indexOf('function numWord(', onesIdx)) + 1;
  assert.ok(onesIdx !== -1 && numWordEnd > onesIdx,
    'ONES/TENS/numWord not found in src/app.js — the code moved, update this test');

  const src = [
    APP.slice(onesIdx, numWordEnd),
    sliceMarker('docx-strings:esc'),  // esc() — the builders' only dependency
    sliceMarker('epub-xml'),
    sliceMarker('build-flow'),
    sliceMarker('comp-toc'),
    sliceMarker('zip-core'),
  ].join('\n');

  // A new Function body is sloppy-mode by default; src/app.js runs under 'use strict'.
  return new Function(`'use strict';\n${src}\nreturn {
    buildEpubContainerXml, buildEpubOpfXml, buildEpubNavXhtml, buildEpubNcxXml,
    buildEpubBookXhtml, buildFlow, compTocEntries, makeZip
  };`)();
}

const {
  buildEpubContainerXml, buildEpubOpfXml, buildEpubNavXhtml, buildEpubNcxXml,
  buildEpubBookXhtml, buildFlow, compTocEntries, makeZip
} = load();

/* Fixed stand-ins for the two values exportCompEPUB() computes once and passes down. */
const UID = 'urn:uuid:11111111-2222-3333-4444-555555555555';
const MODIFIED = '2024-03-01T12:34:56Z';

/* ============================================================
 * buildEpubContainerXml() — fixed, so pin it exactly
 * ============================================================ */

test('buildEpubContainerXml returns the exact OCF container document', () => {
  assert.strictEqual(buildEpubContainerXml(),
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
    '</container>');
});

test('buildEpubContainerXml takes no arguments and is stable across calls', () => {
  assert.strictEqual(buildEpubContainerXml.length, 0);
  assert.strictEqual(buildEpubContainerXml(), buildEpubContainerXml());
});

/* ============================================================
 * buildEpubOpfXml()
 * ============================================================ */

test('the OPF identifier is exactly the uid it was handed, not a fresh one', () => {
  const opf = buildEpubOpfXml({ uid: UID, title: 'T', author: 'A', modifiedISO: MODIFIED });
  assert.ok(opf.includes(`<dc:identifier id="bookid">${UID}</dc:identifier>`),
    'dc:identifier does not carry the supplied uid');
  // Nothing else in the document may look like a second, generated identifier.
  const uuidLike = opf.match(/urn:uuid:[0-9a-f-]+/gi) || [];
  assert.deepStrictEqual(uuidLike, [UID], 'the OPF minted a uuid of its own');
});

test('dcterms:modified is the exact string passed in, verbatim', () => {
  const odd = 'NOT-A-TIMESTAMP';
  const opf = buildEpubOpfXml({ uid: UID, title: 'T', author: 'A', modifiedISO: odd });
  assert.ok(opf.includes(`<meta property="dcterms:modified">${odd}</meta>`),
    'the builder reformatted or replaced the timestamp it was given');
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(opf), 'the builder produced a timestamp of its own');
});

test('buildEpubOpfXml is deterministic for fixed inputs', () => {
  const args = { uid: UID, title: 'Стойкий', author: 'Автор', modifiedISO: MODIFIED };
  assert.strictEqual(buildEpubOpfXml(args), buildEpubOpfXml(args));
});

test('title and author land in dc:title and dc:creator', () => {
  const opf = buildEpubOpfXml({ uid: UID, title: 'The Long Night', author: 'J. Doe', modifiedISO: MODIFIED });
  assert.ok(opf.includes('<dc:title>The Long Night</dc:title>'));
  assert.ok(opf.includes('<dc:creator>J. Doe</dc:creator>'));
});

test('XML special characters in title and author are escaped', () => {
  const opf = buildEpubOpfXml({
    uid: UID, title: 'Smith & Sons <the> "saga"', author: 'A & B <co>', modifiedISO: MODIFIED
  });
  assert.ok(opf.includes('<dc:title>Smith &amp; Sons &lt;the&gt; "saga"</dc:title>'),
    'title was not escaped: ' + opf);
  assert.ok(opf.includes('<dc:creator>A &amp; B &lt;co&gt;</dc:creator>'),
    'author was not escaped: ' + opf);
  // No raw markup smuggled in — the only '<the>' style sequence is the escaped one.
  assert.ok(!opf.includes('<the>'), 'an unescaped tag leaked into the OPF');
});

test('Cyrillic titles and authors pass through unchanged', () => {
  const opf = buildEpubOpfXml({
    uid: UID, title: 'Тайна старого дома', author: 'Кирилл Мефодьев', modifiedISO: MODIFIED
  });
  assert.ok(opf.includes('<dc:title>Тайна старого дома</dc:title>'));
  assert.ok(opf.includes('<dc:creator>Кирилл Мефодьев</dc:creator>'));
});

test('the OPF manifest and spine reference every file the exporter writes', () => {
  const opf = buildEpubOpfXml({ uid: UID, title: 'T', author: 'A', modifiedISO: MODIFIED });
  for (const href of ['nav.xhtml', 'toc.ncx', 'book.xhtml', 'style.css']) {
    assert.ok(opf.includes(`href="${href}"`), `manifest is missing ${href}`);
  }
  assert.ok(opf.includes('<spine toc="ncx"><itemref idref="book"/></spine>'));
  assert.ok(opf.includes('unique-identifier="bookid"'));
});

/* ============================================================
 * buildEpubNavXhtml()
 * ============================================================ */

const NAV_ITEMS = [
  { anchor: 'h0', title: 'Часть Первая' },
  { anchor: 'h1', title: 'Chapter 1' },
  { anchor: 'h2', title: 'Fish & Chips <deluxe>' },
];

test('nav.xhtml renders one linked <li> per item, in order', () => {
  const nav = buildEpubNavXhtml({ navItems: NAV_ITEMS });
  const lis = nav.match(/<li>.*?<\/li>/g);
  assert.deepStrictEqual(lis, [
    '<li><a href="book.xhtml#h0">Часть Первая</a></li>',
    '<li><a href="book.xhtml#h1">Chapter 1</a></li>',
    '<li><a href="book.xhtml#h2">Fish &amp; Chips &lt;deluxe&gt;</a></li>',
  ]);
});

test('nav.xhtml links to the document itself when an item has anchor: null', () => {
  // The single-book fallback exportCompEPUB() applies when there are no TOC entries.
  const nav = buildEpubNavXhtml({ navItems: [{ anchor: null, title: 'Безымянная книга' }] });
  assert.ok(nav.includes('<li><a href="book.xhtml">Безымянная книга</a></li>'),
    'a null anchor must produce a bare book.xhtml href with no "#": ' + nav);
  assert.ok(!nav.includes('book.xhtml#'), 'a fragment was emitted for a null anchor');
});

test('nav.xhtml declares the epub:type="toc" nav element regardless of item count', () => {
  for (const items of [[], NAV_ITEMS]) {
    const nav = buildEpubNavXhtml({ navItems: items });
    assert.ok(nav.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'));
    assert.ok(nav.includes('<nav epub:type="toc" id="toc">'));
    assert.ok(nav.includes('xmlns:epub="http://www.idpf.org/2007/ops"'));
  }
  assert.ok(buildEpubNavXhtml({ navItems: [] }).includes('<ol></ol>'),
    'an empty item list should still emit an empty <ol>');
});

/* ============================================================
 * buildEpubNcxXml()
 * ============================================================ */

test('toc.ncx renders one navPoint per item with sequential ids and playOrder', () => {
  const ncx = buildEpubNcxXml({ uid: UID, title: 'Книга', navItems: NAV_ITEMS });
  const pts = ncx.match(/<navPoint .*?<\/navPoint>/g);
  assert.deepStrictEqual(pts, [
    '<navPoint id="n0" playOrder="1"><navLabel><text>Часть Первая</text></navLabel><content src="book.xhtml#h0"/></navPoint>',
    '<navPoint id="n1" playOrder="2"><navLabel><text>Chapter 1</text></navLabel><content src="book.xhtml#h1"/></navPoint>',
    '<navPoint id="n2" playOrder="3"><navLabel><text>Fish &amp; Chips &lt;deluxe&gt;</text></navLabel><content src="book.xhtml#h2"/></navPoint>',
  ]);
});

test('toc.ncx carries the supplied uid as dtb:uid and escapes the docTitle', () => {
  const ncx = buildEpubNcxXml({ uid: UID, title: 'Ampersand & Co <x>', navItems: NAV_ITEMS });
  assert.ok(ncx.includes(`<meta name="dtb:uid" content="${UID}"/>`), 'dtb:uid is wrong');
  assert.ok(ncx.includes('<docTitle><text>Ampersand &amp; Co &lt;x&gt;</text></docTitle>'));
});

test('toc.ncx points at the document itself when an item has anchor: null', () => {
  const ncx = buildEpubNcxXml({ uid: UID, title: 'T', navItems: [{ anchor: null, title: 'Whole book' }] });
  assert.ok(ncx.includes('<content src="book.xhtml"/>'),
    'a null anchor must produce a bare book.xhtml src: ' + ncx);
  assert.ok(!ncx.includes('book.xhtml#'), 'a fragment was emitted for a null anchor');
});

test('an empty item list yields an empty navMap rather than throwing', () => {
  const ncx = buildEpubNcxXml({ uid: UID, title: 'T', navItems: [] });
  assert.ok(ncx.includes('<navMap></navMap>'));
});

/* ============================================================
 * buildEpubBookXhtml()
 * ============================================================ */

test('book.xhtml wraps the inner HTML in the given doc classes', () => {
  const html = buildEpubBookXhtml({
    title: 'T', lang: 'en', docClasses: 'comp-doc comp-indent comp-justify',
    innerHtml: '<p>Тело книги</p>'
  });
  assert.ok(html.includes('<body><div class="comp-doc comp-indent comp-justify"><p>Тело книги</p></div></body>'),
    'the wrapper did not come out as expected: ' + html);
});

test('book.xhtml uses the supplied language for both xml:lang and lang', () => {
  const html = buildEpubBookXhtml({ title: 'T', lang: 'ru', docClasses: 'comp-doc', innerHtml: '' });
  assert.ok(html.includes('xml:lang="ru" lang="ru"'),
    'lang is not configurable — it came out as something other than "ru": ' + html);
  assert.ok(!html.includes('lang="en"'), 'a hardcoded "en" survived the extraction');
});

test('book.xhtml escapes the title but passes innerHtml through as markup', () => {
  const html = buildEpubBookXhtml({
    title: 'A & B <c>', lang: 'en', docClasses: 'comp-doc',
    innerHtml: '<h1 class="c-chapter" id="h0">Глава &amp; сцена</h1>'
  });
  assert.ok(html.includes('<title>A &amp; B &lt;c&gt;</title>'), 'the title was not escaped');
  assert.ok(html.includes('<h1 class="c-chapter" id="h0">Глава &amp; сцена</h1>'),
    'innerHtml must be inserted verbatim, not re-escaped');
});

test('book.xhtml declares the XHTML prolog, doctype and stylesheet link', () => {
  const html = buildEpubBookXhtml({ title: 'T', lang: 'en', docClasses: 'comp-doc', innerHtml: '' });
  assert.ok(html.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'));
  assert.ok(html.includes('xmlns="http://www.w3.org/1999/xhtml"'));
  assert.ok(html.includes('<link rel="stylesheet" type="text/css" href="style.css"/>'));
});

/* ============================================================
 * Integration: buildFlow -> compTocEntries -> builders -> makeZip
 *
 * The whole pure half of the EPUB export, chained the way exportCompEPUB() chains it. The
 * one impure step, flowToBodyHTML()/normalizeSceneHTML(), needs a real DOM and is not part
 * of this; a plain XHTML string stands in for the body it would return.
 * ============================================================ */

const CHAPTERS = [
  {
    id: 'ch1', title: 'The Gathering Storm', order: 0,
    scenes: [
      { id: 's1', title: 'The Beginning', content: '<p>Once upon a time</p>' },
      { id: 's2', title: 'Продолжение', content: '<p>Кирилл шёл домой</p>' },
    ]
  },
  {
    id: 'ch2', title: 'Глава Два', order: 1,
    scenes: [{ id: 's3', title: 'Scene Three', content: '<p>More text</p>' }]
  },
  {
    id: 'ch3', title: 'Развязка & финал', order: 2,
    scenes: [
      { id: 's4', title: 'Последняя сцена', content: '<p>Конец</p>' },
      { id: 's5', title: 'Epilogue', content: '<p>The end</p>' },
    ]
  },
];

function findScene(id) {
  for (const c of CHAPTERS) {
    const s = (c.scenes || []).find(x => x.id === id);
    if (s) return { chapter: c, scene: s };
  }
  return null;
}

const ITEMS = [
  { type: 'part', title: 'Часть Первая' },
  { type: 'scene', sceneId: 's1', title: 'The Beginning' },
  { type: 'scene', sceneId: 's2', title: 'Продолжение' },
  { type: 'part', title: 'Part Two' },
  { type: 'scene', sceneId: 's3', title: 'Scene Three' },
  { type: 'break' },
  { type: 'scene', sceneId: 's4', title: 'Последняя сцена' },
  { type: 'scene', sceneId: 's5', title: 'Epilogue' },
];

const SETTINGS = {
  includeParts: true, sceneTitles: 'yes', numberChapters: 'none', tocDepth: 'chapters',
};

const EPUB_TITLE = 'Тайна старого дома & прочее';
const EPUB_AUTHOR = 'Кирилл <Мефодьев>';

/* Mirrors exportCompEPUB()'s assembly, minus the DOM-dependent body and the file save. */
function compileEpubFiles() {
  const flow = buildFlow(ITEMS, SETTINGS, CHAPTERS, findScene);
  const navEntries = compTocEntries(flow, SETTINGS);
  const navItems = navEntries.length ? navEntries : [{ anchor: null, title: EPUB_TITLE }];
  // Stand-in for flowToBodyHTML(flow, true), which needs a DOM. Same anchors, same order.
  const inner = flow
    .filter(f => f.anchor)
    .map(f => `<h1 id="${f.anchor}">${f.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1><p>x</p>`)
    .join('');

  const enc = new TextEncoder();
  const files = [
    { name: 'mimetype', bytes: enc.encode('application/epub+zip') },
    { name: 'META-INF/container.xml', bytes: enc.encode(buildEpubContainerXml()) },
    { name: 'OEBPS/content.opf', bytes: enc.encode(buildEpubOpfXml({ uid: UID, title: EPUB_TITLE, author: EPUB_AUTHOR, modifiedISO: MODIFIED })) },
    { name: 'OEBPS/nav.xhtml', bytes: enc.encode(buildEpubNavXhtml({ navItems })) },
    { name: 'OEBPS/toc.ncx', bytes: enc.encode(buildEpubNcxXml({ uid: UID, title: EPUB_TITLE, navItems })) },
    { name: 'OEBPS/book.xhtml', bytes: enc.encode(buildEpubBookXhtml({ title: EPUB_TITLE, lang: 'en', docClasses: 'comp-doc comp-indent', innerHtml: inner })) },
    { name: 'OEBPS/style.css', bytes: enc.encode('.comp-doc{color:#111;}') },
  ];
  return { flow, navItems, files };
}

function readEpub() {
  const { flow, navItems, files } = compileEpubFiles();
  const { eocd, entries } = readZip(makeZip(files));
  const dec = new TextDecoder();
  const text = name => {
    const e = entries.find(x => x.central.name === name);
    assert.ok(e, `${name} is missing from the archive`);
    return dec.decode(e.data);
  };
  return { flow, navItems, entries, eocd, text };
}

test('the compiled archive holds exactly the seven EPUB entries, mimetype first', () => {
  const { entries, eocd } = readEpub();
  assert.deepStrictEqual(entries.map(e => e.central.name), [
    'mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml',
    'OEBPS/toc.ncx', 'OEBPS/book.xhtml', 'OEBPS/style.css',
  ]);
  assert.strictEqual(eocd.entriesTotal, 7);
  // OCF requires mimetype to be the first entry, stored uncompressed at offset 0.
  assert.strictEqual(entries[0].central.localHeaderOffset, 0);
  assert.strictEqual(entries[0].local.method, 0);
  assert.strictEqual(new TextDecoder().decode(entries[0].data), 'application/epub+zip');
});

test('container.xml resolves to the OPF that is actually in the archive', () => {
  const { entries, text } = readEpub();
  const rootfile = text('META-INF/container.xml').match(/full-path="([^"]+)"/)[1];
  assert.strictEqual(rootfile, 'OEBPS/content.opf');
  assert.ok(entries.some(e => e.central.name === rootfile),
    'container.xml points at a file the archive does not contain');
});

test('every OPF manifest href resolves to a real entry under OEBPS/', () => {
  const { entries, text } = readEpub();
  const names = new Set(entries.map(e => e.central.name));
  const hrefs = [...text('OEBPS/content.opf').matchAll(/<item [^>]*href="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(hrefs, ['nav.xhtml', 'toc.ncx', 'book.xhtml', 'style.css']);
  for (const href of hrefs) {
    assert.ok(names.has('OEBPS/' + href), `manifest href "${href}" has no entry in the archive`);
  }
});

test('the OPF and the NCX agree on the identifier', () => {
  const { text } = readEpub();
  const opfId = text('OEBPS/content.opf').match(/<dc:identifier id="bookid">([^<]+)</)[1];
  const ncxId = text('OEBPS/toc.ncx').match(/name="dtb:uid" content="([^"]+)"/)[1];
  assert.strictEqual(opfId, UID);
  assert.strictEqual(ncxId, UID, 'the NCX uid drifted from the OPF identifier');
});

test('nav.xhtml and toc.ncx list the same targets as compTocEntries produced', () => {
  const { navItems, text } = readEpub();
  // 2 parts + 3 chapters at tocDepth "chapters".
  assert.strictEqual(navItems.length, 5);

  const navHrefs = [...text('OEBPS/nav.xhtml').matchAll(/<a href="([^"]+)">/g)].map(m => m[1]);
  const ncxSrcs = [...text('OEBPS/toc.ncx').matchAll(/<content src="([^"]+)"\/>/g)].map(m => m[1]);
  const expected = navItems.map(f => 'book.xhtml#' + f.anchor);

  assert.deepStrictEqual(navHrefs, expected);
  assert.deepStrictEqual(ncxSrcs, expected, 'the NCX and the nav document disagree');
});

test('every nav target resolves to an id that exists in book.xhtml', () => {
  const { navItems, text } = readEpub();
  const book = text('OEBPS/book.xhtml');
  for (const f of navItems) {
    assert.ok(book.includes(`id="${f.anchor}"`),
      `nav points at #${f.anchor}, which has no matching element in book.xhtml`);
  }
});

test('Cyrillic and escaped titles survive the whole chain into the archive', () => {
  const { text } = readEpub();
  assert.ok(text('OEBPS/content.opf').includes('<dc:title>Тайна старого дома &amp; прочее</dc:title>'));
  assert.ok(text('OEBPS/content.opf').includes('<dc:creator>Кирилл &lt;Мефодьев&gt;</dc:creator>'));
  assert.ok(text('OEBPS/nav.xhtml').includes('>Часть Первая</a>'));
  assert.ok(text('OEBPS/nav.xhtml').includes('>Глава Два</a>'));
  // The chapter title containing '&' must be escaped everywhere it appears.
  assert.ok(text('OEBPS/nav.xhtml').includes('>Развязка &amp; финал</a>'));
  assert.ok(text('OEBPS/toc.ncx').includes('<text>Развязка &amp; финал</text>'));
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(text('OEBPS/nav.xhtml')),
    'a bare ampersand escaped into nav.xhtml — readers reject that as not well-formed');
});

test('the compiled archive is byte-for-byte reproducible for fixed inputs', () => {
  // Nothing left in the pure chain reads the clock or generates an id.
  const a = makeZip(compileEpubFiles().files);
  const b = makeZip(compileEpubFiles().files);
  assert.deepStrictEqual(Buffer.from(a), Buffer.from(b));
});
