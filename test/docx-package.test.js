/* Coverage for the DOCX package builders — the three envelope parts ([Content_Types].xml,
 * _rels/.rels, word/document.xml) and buildDocxBodyXml(), which assembles the manuscript
 * body out of the paragraph builders pinned in test/docx-strings.test.js.
 *
 * These decide the *shape* of the exported manuscript rather than the text inside it: does
 * a title page get emitted at all, does the table of contents land before or after the
 * body, is there a page break where Word needs one, does a scene separator appear between
 * two scenes but not directly under a chapter heading. Every one of those is invisible
 * until someone opens the .docx somewhere else, and none of it is exercised by the app's
 * own UI, so it is worth pinning here.
 *
 * htmlToBlocks() converts a scene's HTML into paragraph runs and needs a real DOM, so
 * buildDocxBodyXml() takes it as an injected parameter. Production passes the real
 * function; these tests pass a stub returning a fixed block structure, which is what makes
 * everything *around* the HTML conversion testable without a DOM or a jsdom dependency.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * builders are lifted out between marker comments and run here in isolation — the same
 * technique as test/epub-xml.test.js, test/docx-strings.test.js, test/build-flow.test.js,
 * test/comp-toc.test.js, test/zip-writer.test.js and test/pdf-cyrillic.test.js.
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
  // (Same extraction as test/build-flow.test.js and test/epub-xml.test.js.)
  const onesIdx = APP.indexOf("const ONES = ['',");
  const numWordEnd = APP.indexOf('\n', APP.indexOf('function numWord(', onesIdx)) + 1;
  assert.ok(onesIdx !== -1 && numWordEnd > onesIdx,
    'ONES/TENS/numWord not found in src/app.js — the code moved, update this test');

  const src = [
    APP.slice(onesIdx, numWordEnd),
    sliceMarker('docx-strings:esc'),
    sliceMarker('docx-strings:xmlesc'),
    sliceMarker('docx-strings:builders'),
    sliceMarker('sep-text'),
    sliceMarker('build-flow'),
    sliceMarker('comp-toc'),
    sliceMarker('zip-core'),
  ].join('\n');

  // A new Function body is sloppy-mode by default; src/app.js runs under 'use strict'.
  return new Function(`'use strict';\n${src}\nreturn {
    buildDocxBodyXml, buildDocxDocumentXml, buildDocxContentTypesXml, buildDocxRelsXml,
    docxP, docxPageBreak, buildFlow, compTocEntries, sepText, makeZip
  };`)();
}

const {
  buildDocxBodyXml, buildDocxDocumentXml, buildDocxContentTypesXml, buildDocxRelsXml,
  docxP, docxPageBreak, buildFlow, compTocEntries, sepText, makeZip
} = load();

/* Mirrors defaultCompSettings() for the fields these builders read; each test overrides
   only what it is about, so an unrelated default changing cannot make a test lie. */
const BASE_SETTINGS = {
  align: 'left', lineSpacing: 1, paraSpacing: 'none', indent: 'none',
  sceneSeparator: '***', sceneSepCustom: '',
  titlePage: false, titleText: '', subtitle: '', author: '', dateText: '',
  toc: false, tocDepth: 'chapters', tocPosition: 'afterTitle',
  pageSize: 'A4'
};
const settings = over => ({ ...BASE_SETTINGS, ...over });

/* Stand-in for htmlToBlocks(), which needs a real DOM. It ignores the HTML it is given and
   always returns the same two blocks, so anything a test sees around them is the body
   builder's own doing. Calls are recorded, since "was the scene body converted at all"
   is part of what the loop tests assert. */
function stubBlocks() {
  const calls = [];
  const fn = html => {
    calls.push(html);
    return [{ tag: 'p', runs: [{ text: 'BODY' }] }];
  };
  fn.calls = calls;
  return fn;
}

// Pull the text out of every <w:t> in a document, still escaped, in order.
const wtPayloads = xml => [...xml.matchAll(/<w:t xml:space="preserve">([\s\S]*?)<\/w:t>/g)].map(m => m[1]);
// Split a body into its paragraphs, so position assertions can talk about paragraph N.
const paragraphs = xml => xml.match(/<w:p>[\s\S]*?<\/w:p>/g) || [];
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/* ============================================================
 * buildDocxContentTypesXml() / buildDocxRelsXml() — fixed, so pin them exactly
 * ============================================================ */

test('buildDocxContentTypesXml returns the exact content-types part', () => {
  assert.strictEqual(buildDocxContentTypesXml(),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>');
});

test('buildDocxRelsXml returns the exact package relationships part', () => {
  assert.strictEqual(buildDocxRelsXml(),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>');
});

test('both fixed parts take no arguments and are stable across calls', () => {
  for (const fn of [buildDocxContentTypesXml, buildDocxRelsXml]) {
    assert.strictEqual(fn.length, 0);
    assert.strictEqual(fn(), fn());
  }
  // The relationship target has to name the part the content-types override describes,
  // or Word cannot find the document at all.
  assert.ok(buildDocxRelsXml().includes('Target="word/document.xml"'));
  assert.ok(buildDocxContentTypesXml().includes('PartName="/word/document.xml"'));
});

/* ============================================================
 * buildDocxDocumentXml()
 * ============================================================ */

test('buildDocxDocumentXml wraps the body it is given, unchanged', () => {
  const bodyXml = '<w:p><w:r><w:t xml:space="preserve">Кириллица &amp; co</w:t></w:r></w:p>';
  const xml = buildDocxDocumentXml({ bodyXml, pageSize: 'A4' });

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document '));
  assert.ok(xml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'));
  assert.ok(xml.includes(`<w:body>${bodyXml}<w:sectPr`),
    'the body must be inserted verbatim, immediately inside <w:body>: ' + xml);
  assert.ok(xml.endsWith('</w:body></w:document>'));
});

test('buildDocxDocumentXml puts the sectPr last, after the body', () => {
  // Word requires the section properties to be the final child of <w:body>.
  const xml = buildDocxDocumentXml({ bodyXml: '<w:p/>', pageSize: 'A4' });
  assert.match(xml, /<w:sectPr>.*<\/w:sectPr><\/w:body><\/w:document>$/s);
  assert.strictEqual((xml.match(/<w:sectPr>/g) || []).length, 1);
  assert.ok(xml.includes('<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'));
});

test('page size is Letter only for the exact string "Letter"; everything else is A4', () => {
  const size = pageSize => buildDocxDocumentXml({ bodyXml: '', pageSize }).match(/<w:pgSz w:w="(\d+)" w:h="(\d+)"\/>/).slice(1, 3);

  assert.deepStrictEqual(size('Letter'), ['12240', '15840'], 'Letter is 8.5x11in in twentieths of a point');
  assert.deepStrictEqual(size('A4'), ['11906', '16838'], 'A4 is 210x297mm in twentieths of a point');
  // The A4 branch is the fallback: anything unrecognised must not silently become Letter.
  for (const other of ['letter', 'LETTER', 'A5', '', undefined, null]) {
    assert.deepStrictEqual(size(other), ['11906', '16838'], `pageSize ${JSON.stringify(other)} should fall back to A4`);
  }
});

test('an empty body still yields a well-formed document', () => {
  const xml = buildDocxDocumentXml({ bodyXml: '', pageSize: 'A4' });
  assert.match(xml, /<w:body><w:sectPr>/);
  assert.strictEqual((xml.match(/<w:body>/g) || []).length, 1);
  assert.strictEqual((xml.match(/<\/w:body>/g) || []).length, 1);
});

/* ============================================================
 * buildDocxBodyXml() — title page
 * ============================================================ */

const ONE_SCENE = [{ type: 'scene', title: 'A scene', html: '<p>x</p>', showTitle: false, anchor: null }];

test('the title page block appears only when settings.titlePage is on', () => {
  const on = buildDocxBodyXml(ONE_SCENE, settings({
    titlePage: true, titleText: 'Тайна старого дома', author: 'Кирилл', subtitle: 'A tale', dateText: '2024'
  }), stubBlocks());
  assert.deepStrictEqual(wtPayloads(on).slice(0, 4), ['Тайна старого дома', 'A tale', 'Кирилл', '2024'],
    'title, subtitle, author and date come first, in that order');
  assert.ok(on.includes(PAGE_BREAK), 'the title page must be followed by a page break');

  const off = buildDocxBodyXml(ONE_SCENE, settings({
    titlePage: false, titleText: 'Тайна старого дома', author: 'Кирилл', subtitle: 'A tale', dateText: '2024'
  }), stubBlocks());
  assert.deepStrictEqual(wtPayloads(off), ['BODY'], 'nothing from the title page may leak through');
  assert.ok(!off.includes(PAGE_BREAK), 'no title page means no leading page break');
});

test('the optional title-page lines are omitted individually when empty', () => {
  const xml = buildDocxBodyXml([], settings({ titlePage: true, titleText: 'Just A Title' }), stubBlocks());
  assert.deepStrictEqual(wtPayloads(xml), ['Just A Title'],
    'an absent subtitle/author/date must not emit an empty paragraph');
  assert.strictEqual(paragraphs(xml).length, 2, 'expected the title paragraph plus the page break');
});

test('the book title is styled as the largest, centred, bold heading', () => {
  const xml = buildDocxBodyXml([], settings({ titlePage: true, titleText: 'T', subtitle: 'S' }), stubBlocks());
  const [title, subtitle] = paragraphs(xml);
  assert.match(title, /<w:sz w:val="56"\/>/);
  assert.match(title, /<w:b\/>/);
  assert.match(title, /<w:jc w:val="center"\/>/);
  assert.match(subtitle, /<w:i\/>/, 'the subtitle is italic');
  assert.match(subtitle, /<w:jc w:val="center"\/>/);
});

/* ============================================================
 * buildDocxBodyXml() — table of contents
 * ============================================================ */

const TOC_FLOW = [
  { type: 'part', title: 'Part One', anchor: 'h0' },
  { type: 'chapter', title: 'Chapter 1', anchor: 'h1' },
  { type: 'scene', title: 'Opening', html: '<p>a</p>', showTitle: true, anchor: 'h2' },
  { type: 'chapter', title: 'Глава 2', anchor: 'h3' },
  { type: 'scene', title: 'Closing', html: '<p>b</p>', showTitle: false, anchor: null },
];

// Indices of the paragraphs holding the TOC's "Contents" heading, i.e. where it landed.
const contentsAt = xml => paragraphs(xml).findIndex(p => wtPayloads(p)[0] === 'Contents');

test('no TOC block at all when settings.toc is off, whatever the position says', () => {
  for (const tocPosition of ['afterTitle', 'end']) {
    const xml = buildDocxBodyXml(TOC_FLOW, settings({ toc: false, tocPosition }), stubBlocks());
    assert.strictEqual(contentsAt(xml), -1, `tocPosition=${tocPosition}: a TOC was emitted with toc off`);
  }
});

test('tocPosition "afterTitle" puts the TOC at the top, before the first heading', () => {
  const xml = buildDocxBodyXml(TOC_FLOW, settings({ toc: true, tocPosition: 'afterTitle' }), stubBlocks());
  const texts = wtPayloads(xml);
  assert.strictEqual(contentsAt(xml), 0, 'the TOC must be the first thing in the body');
  assert.deepStrictEqual(texts.slice(0, 4), ['Contents', 'Part One', 'Chapter 1', 'Глава 2']);
  // A page break separates the TOC from the manuscript.
  assert.ok(paragraphs(xml)[4] === PAGE_BREAK, 'expected a page break after the TOC entries');
  assert.ok(texts.indexOf('Part One') < texts.lastIndexOf('Part One'),
    'the part heading itself should still appear in the body after the TOC');
});

test('tocPosition "afterTitle" places the TOC after the title page, not before it', () => {
  const xml = buildDocxBodyXml(TOC_FLOW, settings({
    toc: true, tocPosition: 'afterTitle', titlePage: true, titleText: 'Книга'
  }), stubBlocks());
  const texts = wtPayloads(xml);
  assert.strictEqual(texts[0], 'Книга');
  assert.strictEqual(texts[1], 'Contents', 'the TOC must follow the title page');
});

test('tocPosition "end" puts the TOC last, after a page break', () => {
  const xml = buildDocxBodyXml(TOC_FLOW, settings({ toc: true, tocPosition: 'end' }), stubBlocks());
  const paras = paragraphs(xml);
  const at = contentsAt(xml);

  assert.ok(at > 0, 'the TOC should not be at the top');
  assert.strictEqual(paras[at - 1], PAGE_BREAK, 'the trailing TOC must be preceded by a page break');
  // Everything from the heading on is TOC: the "Contents" line plus its three entries.
  assert.deepStrictEqual(paras.slice(at).map(p => wtPayloads(p)[0]),
    ['Contents', 'Part One', 'Chapter 1', 'Глава 2']);
});

test('the TOC lists exactly what compTocEntries() selects, at either depth', () => {
  for (const tocDepth of ['chapters', 'scenes']) {
    const s = settings({ toc: true, tocPosition: 'afterTitle', tocDepth });
    const xml = buildDocxBodyXml(TOC_FLOW, s, stubBlocks());
    const at = contentsAt(xml);
    const listed = paragraphs(xml).slice(at + 1, at + 1 + compTocEntries(TOC_FLOW, s).length)
      .map(p => wtPayloads(p)[0]);
    assert.deepStrictEqual(listed, compTocEntries(TOC_FLOW, s).map(f => f.title),
      `tocDepth=${tocDepth}: the body TOC drifted from compTocEntries()`);
  }
  // And the depth setting genuinely changes the answer, so the check above is not vacuous.
  assert.strictEqual(compTocEntries(TOC_FLOW, settings({ tocDepth: 'scenes' })).length, 4);
  assert.strictEqual(compTocEntries(TOC_FLOW, settings({ tocDepth: 'chapters' })).length, 3);
});

/* ============================================================
 * buildDocxBodyXml() — the part/chapter/break/scene loop
 * ============================================================ */

test('part and chapter headings use their own sizes and are centred and bold', () => {
  const flow = [
    { type: 'part', title: 'Part One', anchor: 'h0' },
    { type: 'chapter', title: 'Chapter 1', anchor: 'h1' },
  ];
  const [part, chapter] = paragraphs(buildDocxBodyXml(flow, settings({}), stubBlocks()));

  assert.match(part, /<w:sz w:val="44"\/>/, 'a part heading is 22pt (44 half-points)');
  assert.match(chapter, /<w:sz w:val="34"\/>/, 'a chapter heading is 17pt (34 half-points)');
  for (const p of [part, chapter]) {
    assert.match(p, /<w:b\/>/);
    assert.match(p, /<w:jc w:val="center"\/>/);
  }
});

test('headings and scene titles are never first-line indented', () => {
  const flow = [
    { type: 'part', title: 'Part One', anchor: 'h0' },
    { type: 'chapter', title: 'Chapter 1', anchor: 'h1' },
    { type: 'scene', title: 'Scene', html: '<p>x</p>', showTitle: true, anchor: 'h2' },
  ];
  const paras = paragraphs(buildDocxBodyXml(flow, settings({ indent: 'indent' }), stubBlocks()));
  for (const p of paras.slice(0, 3)) {
    assert.ok(!p.includes('<w:ind'), 'a heading came out indented: ' + p);
  }
  // The scene body still follows the document's indent setting.
  assert.ok(paras[3].includes('<w:ind w:firstLine="720"/>'), 'the body paragraph lost its indent');
});

test('a scene header paragraph is emitted only when showTitle is true', () => {
  const shown = buildDocxBodyXml(
    [{ type: 'scene', title: 'Первая сцена', html: '<p>x</p>', showTitle: true, anchor: 'h0' }],
    settings({}), stubBlocks());
  assert.deepStrictEqual(wtPayloads(shown), ['Первая сцена', 'BODY']);
  assert.match(paragraphs(shown)[0], /<w:sz w:val="26"\/>/, 'a scene header is 13pt (26 half-points)');
  assert.ok(!paragraphs(shown)[0].includes('<w:jc w:val="center"/>'),
    'scene headers are left-aligned, unlike part and chapter headings');

  const hidden = buildDocxBodyXml(
    [{ type: 'scene', title: 'Первая сцена', html: '<p>x</p>', showTitle: false, anchor: null }],
    settings({}), stubBlocks());
  assert.deepStrictEqual(wtPayloads(hidden), ['BODY'], 'the hidden scene title leaked into the body');
});

test('a separator goes between two consecutive scenes, but not after a heading', () => {
  const flow = [
    { type: 'chapter', title: 'Chapter 1', anchor: 'h0' },
    { type: 'scene', title: 'One', html: '<p>1</p>', showTitle: false, anchor: null },
    { type: 'scene', title: 'Two', html: '<p>2</p>', showTitle: false, anchor: null },
    { type: 'part', title: 'Part Two', anchor: 'h1' },
    { type: 'scene', title: 'Three', html: '<p>3</p>', showTitle: false, anchor: null },
  ];
  const s = settings({});
  const texts = wtPayloads(buildDocxBodyXml(flow, s, stubBlocks()));

  assert.deepStrictEqual(texts, [
    'Chapter 1',        // heading — resets lastScene, so no separator follows
    'BODY',             // scene One
    sepText(s),         // scene Two follows a scene: separator
    'BODY',
    'Part Two',         // heading again — resets lastScene
    'BODY',             // scene Three: no separator, it follows a heading
  ]);
});

test('an explicit break item always emits a separator, defaulting to "* * *"', () => {
  const flow = [
    { type: 'scene', title: 'One', html: '<p>1</p>', showTitle: false, anchor: null },
    { type: 'break' },
    { type: 'scene', title: 'Two', html: '<p>2</p>', showTitle: false, anchor: null },
  ];
  // A break resets lastScene, so the following scene must not add a second separator.
  assert.deepStrictEqual(wtPayloads(buildDocxBodyXml(flow, settings({}), stubBlocks())),
    ['BODY', '* * *', 'BODY']);

  // 'blank' makes sepText() empty; the break still emits the '* * *' fallback, while the
  // between-scenes separator becomes an empty spacer paragraph.
  const blank = buildDocxBodyXml(flow, settings({ sceneSeparator: 'blank' }), stubBlocks());
  assert.deepStrictEqual(wtPayloads(blank), ['BODY', '* * *', 'BODY']);

  const custom = settings({ sceneSeparator: 'custom', sceneSepCustom: '~ ~ ~' });
  assert.deepStrictEqual(wtPayloads(buildDocxBodyXml(flow, custom, stubBlocks())),
    ['BODY', '~ ~ ~', 'BODY']);
});

test('a blank separator between two scenes is an empty spacer paragraph, not nothing', () => {
  const flow = [
    { type: 'scene', title: 'One', html: '<p>1</p>', showTitle: false, anchor: null },
    { type: 'scene', title: 'Two', html: '<p>2</p>', showTitle: false, anchor: null },
  ];
  const xml = buildDocxBodyXml(flow, settings({ sceneSeparator: 'blank' }), stubBlocks());
  assert.deepStrictEqual(wtPayloads(xml), ['BODY', '', 'BODY'],
    'the blank separator must still occupy a paragraph, or the scenes run together');
});

test('every scene\'s html is handed to the injected converter, in flow order', () => {
  const flow = [
    { type: 'chapter', title: 'Chapter 1', anchor: 'h0' },
    { type: 'scene', title: 'One', html: '<p>первая</p>', showTitle: false, anchor: null },
    { type: 'break' },
    { type: 'scene', title: 'Two', html: '<p>вторая</p>', showTitle: true, anchor: 'h1' },
  ];
  const blocks = stubBlocks();
  buildDocxBodyXml(flow, settings({}), blocks);
  assert.deepStrictEqual(blocks.calls, ['<p>первая</p>', '<p>вторая</p>'],
    'only scene html goes through the converter, once each, in order');
});

test('block tags from the converter pick the matching heading size', () => {
  const htmlToBlocksFn = () => [
    { tag: 'h1', runs: [{ text: 'H1' }] },
    { tag: 'h2', runs: [{ text: 'H2' }] },
    { tag: 'h3', runs: [{ text: 'H3' }] },
    { tag: 'p', runs: [{ text: 'P' }] },
  ];
  const flow = [{ type: 'scene', title: 'S', html: '<h1>x</h1>', showTitle: false, anchor: null }];
  const paras = paragraphs(buildDocxBodyXml(flow, settings({ indent: 'indent' }), htmlToBlocksFn));

  assert.deepStrictEqual(paras.map(p => (p.match(/<w:sz w:val="(\d+)"\/>/) || [])[1]),
    ['32', '28', '24', undefined], 'h1/h2/h3 sizes, and no explicit size for a paragraph');
  for (const p of paras.slice(0, 3)) {
    assert.match(p, /<w:b\/>/, 'headings from the html are bold');
    assert.ok(!p.includes('<w:ind'), 'headings from the html are not indented');
  }
  assert.ok(paras[3].includes('<w:ind w:firstLine="720"/>'), 'a body paragraph keeps the indent');
});

test('an empty flow with no title page and no TOC produces an empty body', () => {
  assert.strictEqual(buildDocxBodyXml([], settings({}), stubBlocks()), '');
});

test('buildDocxBodyXml reads no globals — it is deterministic for fixed arguments', () => {
  const s = settings({ titlePage: true, titleText: 'T', toc: true, tocPosition: 'end' });
  assert.strictEqual(
    buildDocxBodyXml(TOC_FLOW, s, stubBlocks()),
    buildDocxBodyXml(TOC_FLOW, s, stubBlocks()));
});

/* ============================================================
 * Integration: buildFlow -> buildDocxBodyXml -> the envelope -> makeZip
 *
 * The whole pure half of the DOCX export, chained the way exportCompDOCX() chains it. The
 * one impure step, htmlToBlocks(), needs a real DOM and is stubbed; everything else here
 * is the production code path.
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

const DOC_SETTINGS = settings({
  includeParts: true, sceneTitles: 'yes', numberChapters: 'none',
  titlePage: true, titleText: 'Тайна старого дома & прочее', author: 'Кирилл <Мефодьев>',
  toc: true, tocPosition: 'afterTitle', tocDepth: 'chapters', pageSize: 'Letter',
});

/* Mirrors exportCompDOCX()'s assembly, minus the DOM-dependent converter and the save. */
function compileDocxFiles(over) {
  const s = { ...DOC_SETTINGS, ...over };
  const flow = buildFlow(ITEMS, s, CHAPTERS, findScene);
  const bodyXml = buildDocxBodyXml(flow, s, stubBlocks());
  const documentXml = buildDocxDocumentXml({ bodyXml, pageSize: s.pageSize });
  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', bytes: enc.encode(buildDocxContentTypesXml()) },
    { name: '_rels/.rels', bytes: enc.encode(buildDocxRelsXml()) },
    { name: 'word/document.xml', bytes: enc.encode(documentXml) },
  ];
  return { flow, settings: s, files };
}

function readDocx(over) {
  const { flow, settings: s, files } = compileDocxFiles(over);
  const { eocd, entries } = readZip(makeZip(files));
  const dec = new TextDecoder();
  const text = name => {
    const e = entries.find(x => x.central.name === name);
    assert.ok(e, `${name} is missing from the archive`);
    return dec.decode(e.data);
  };
  return { flow, settings: s, entries, eocd, text };
}

test('the compiled archive holds exactly the three OOXML parts a minimal .docx needs', () => {
  const { entries, eocd } = readDocx();
  assert.deepStrictEqual(entries.map(e => e.central.name),
    ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  assert.strictEqual(eocd.entriesTotal, 3);
});

test('the relationship target names a part that is actually in the archive', () => {
  const { entries, text } = readDocx();
  const target = text('_rels/.rels').match(/Target="([^"]+)"/)[1];
  assert.strictEqual(target, 'word/document.xml');
  assert.ok(entries.some(e => e.central.name === target),
    '_rels/.rels points at a part the archive does not contain');
  assert.ok(text('[Content_Types].xml').includes(`PartName="/${target}"`),
    'the content-types override does not describe the part the rels file points at');
});

test('the document part carries the whole manuscript in flow order', () => {
  const { flow, text } = readDocx();
  const texts = wtPayloads(text('word/document.xml'));

  // Title page, then the TOC, then the body.
  assert.strictEqual(texts[0], 'Тайна старого дома &amp; прочее');
  assert.strictEqual(texts[1], 'Кирилл &lt;Мефодьев&gt;');
  assert.strictEqual(texts[2], 'Contents');

  // 2 parts + 3 chapters at tocDepth "chapters".
  const entries = compTocEntries(flow, DOC_SETTINGS);
  assert.strictEqual(entries.length, 5);
  assert.deepStrictEqual(texts.slice(3, 8), entries.map(f => f.title.replace(/&/g, '&amp;')));

  // Every heading in the flow reappears in the body itself, after the TOC.
  const body = texts.slice(8);
  for (const f of flow.filter(x => x.type === 'part' || x.type === 'chapter')) {
    assert.ok(body.includes(f.title.replace(/&/g, '&amp;')),
      `"${f.title}" is missing from the document body`);
  }
});

test('Cyrillic and XML-significant titles survive the whole chain into the archive', () => {
  const { text } = readDocx();
  const doc = text('word/document.xml');

  assert.ok(doc.includes('<w:t xml:space="preserve">Часть Первая</w:t>'));
  assert.ok(doc.includes('<w:t xml:space="preserve">Развязка &amp; финал</w:t>'),
    'the chapter title containing "&" was not escaped');
  for (const payload of wtPayloads(doc)) {
    assert.ok(!payload.includes('<'), 'a raw "<" reached the document XML');
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(payload),
      'a bare "&" reached the document XML');
  }
});

test('the page-size setting reaches the archive', () => {
  assert.ok(readDocx().text('word/document.xml').includes('<w:pgSz w:w="12240" w:h="15840"/>'),
    'pageSize "Letter" did not survive the chain');
  assert.ok(readDocx({ pageSize: 'A4' }).text('word/document.xml').includes('<w:pgSz w:w="11906" w:h="16838"/>'),
    'pageSize "A4" did not survive the chain');
});

test('the compiled archive is byte-for-byte reproducible for fixed inputs', () => {
  // Nothing left in the pure chain reads the clock, a global, or generates an id.
  const a = makeZip(compileDocxFiles().files);
  const b = makeZip(compileDocxFiles().files);
  assert.deepStrictEqual(Buffer.from(a), Buffer.from(b));
});
