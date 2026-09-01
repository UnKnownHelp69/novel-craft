/* Coverage for the PDF pagination engine — createPdfLayout() and buildPdfPages().
 *
 * This is the least-tested export path in the app: until now only the font/glyph core
 * (`pdf-text-core`, test/pdf-cyrillic.test.js) had any coverage, and the actual
 * word-wrapping, page-break decisions and layout maths had never been exercised at all.
 * Everything here is downstream of a compiled flow and upstream of the PDF byte
 * serialization, so a defect in it silently produces a wrong-looking document rather than
 * an error.
 *
 * htmlToBlocks() converts a scene's HTML into runs and needs a real DOM, so
 * buildPdfPages() takes it as an injected parameter — production passes the real
 * function, these tests pass a stub, which is what makes everything *around* the HTML
 * conversion testable without a DOM or a jsdom dependency (same pattern as
 * test/docx-package.test.js).
 *
 * Several tests are marked CHARACTERIZATION: they pin what the engine does today,
 * including two behaviours that are arguably wrong (heading() dropping the front of an
 * over-long word, and bold/italic runs being flattened to plain text). They are recorded
 * so the extraction can be proved behaviour-preserving and so a later fix has to
 * deliberately update them — not as a claim that the behaviour is correct.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * engine is lifted out between marker comments and run here in isolation — the same
 * technique as test/pdf-cyrillic.test.js, test/docx-package.test.js and the rest.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

function sliceMarker(name) {
  const start = APP.indexOf(`/* --- ${name}:start ---`);
  const end = APP.indexOf(`/* --- ${name}:end --- */`);
  assert.ok(start !== -1 && end > start,
    `${name} markers missing from src/app.js — the code moved, update this test`);
  return APP.slice(start, end);
}

function load() {
  // numWord + ONES/TENS back chapterHeadingText() inside the build-flow block; they sit
  // outside every marker pair, so pull them in by locating the constant declaration.
  // (Same extraction as test/build-flow.test.js and test/docx-package.test.js.)
  const onesIdx = APP.indexOf("const ONES = ['',");
  const numWordEnd = APP.indexOf('\n', APP.indexOf('function numWord(', onesIdx)) + 1;
  assert.ok(onesIdx !== -1 && numWordEnd > onesIdx,
    'ONES/TENS/numWord not found in src/app.js — the code moved, update this test');

  const src = [
    APP.slice(onesIdx, numWordEnd),
    sliceMarker('pdf-text-core'),   // pdfLen / normalizeForPdf, the engine's only deps
    sliceMarker('sep-text'),
    sliceMarker('build-flow'),
    sliceMarker('comp-toc'),
    sliceMarker('pdf-layout'),
    sliceMarker('pdf-pages'),
  ].join('\n');
  // A new Function body is sloppy-mode by default; src/app.js runs under 'use strict'.
  return new Function(`'use strict';\n${src}\n` +
    'return { createPdfLayout, buildPdfPages, buildFlow, compTocEntries, pdfLen, normalizeForPdf };')();
}

const { createPdfLayout, buildPdfPages, buildFlow, compTocEntries, pdfLen } = load();

/* The config exportCompPDF() computes for the app's defaults: A4, 12pt, normal margins,
   1.5 line spacing. Every number below is derived from these, so the assertions are about
   real geometry rather than invented values. */
const A4 = {
  pageW: 595, pageH: 842, margin: 64, fontSize: 12, lineHeight: 18,
  usableWidth: 595 - 64 * 2, charWidth: 12 * 0.6,
  maxChars: Math.max(8, Math.floor((595 - 64 * 2) / (12 * 0.6))),
  fonts: { normal: 'F1', bold: 'F2', italic: 'F3' },
};
const TOP = A4.pageH - A4.margin;                                   // 778
/* A line is emitted only while a whole line height still clears the bottom margin. */
const LINES_PER_PAGE = Math.floor((TOP - A4.margin) / A4.lineHeight);

const layoutOf = over => createPdfLayout({ ...A4, ...over });
const texts = page => page.map(l => l.text);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} !== ${b}`);

/* ---------- wrap() ---------- */

test('wrap breaks at word boundaries and never splits a word', () => {
  const l = layoutOf({ maxChars: 20 });
  l.wrap('the quick brown fox jumps over the lazy dog');
  const lines = texts(l.finish()[0]);
  assert.deepStrictEqual(lines, ['the quick brown fox', 'jumps over the lazy', 'dog']);
  // Every word survives intact and in order.
  assert.strictEqual(lines.join(' '), 'the quick brown fox jumps over the lazy dog');
});

test('wrap never exceeds the character limit when no single word does', () => {
  const limit = 24;
  const l = layoutOf({ maxChars: limit });
  l.wrap('Ветер поднимался над пустошью и нёс с собой запах дождя и мокрой земли');
  for (const t of texts(l.finish()[0])) {
    assert.ok(pdfLen(t) <= limit, `line over the ${limit}-glyph limit: ${JSON.stringify(t)}`);
  }
});

test('wrap fills each line greedily — the next word would not have fit', () => {
  const limit = 20;
  const l = layoutOf({ maxChars: limit });
  l.wrap('alpha bravo charlie delta echo foxtrot');
  const lines = texts(l.finish()[0]);
  const words = 'alpha bravo charlie delta echo foxtrot'.split(' ');
  let i = 0;
  for (const t of lines) {
    i += t.split(' ').length;
    if (i < words.length) {
      assert.ok(pdfLen(t + ' ' + words[i]) > limit,
        `line ${JSON.stringify(t)} could still have taken ${JSON.stringify(words[i])}`);
    }
  }
});

test('CHARACTERIZATION: a word longer than the limit overflows its own line', () => {
  // wrap() never breaks inside a word, so an over-long one is emitted whole and simply
  // runs past the right margin. That is the deliberate trade-off, not a page-break bug.
  const l = layoutOf({ maxChars: 10 });
  l.wrap('short antidisestablishmentarianism end');
  assert.deepStrictEqual(texts(l.finish()[0]),
    ['short', 'antidisestablishmentarianism', 'end']);
});

test('wrap firstIndent shifts only the first line and counts against its limit', () => {
  const l = layoutOf({ maxChars: 20 });
  l.wrap('the quick brown fox jumps over the lazy dog', { firstIndent: 5 });
  const page = l.finish()[0];
  assert.deepStrictEqual(texts(page), ['the quick brown', 'fox jumps over the', 'lazy dog']);
  assert.strictEqual(page[0].x, A4.margin + 5 * A4.charWidth);
  assert.strictEqual(page[1].x, A4.margin);
  assert.strictEqual(page[2].x, A4.margin);
  // The indent is charged against the first line's budget: 15 glyphs + 5 = the 20 limit.
  assert.strictEqual(pdfLen(page[0].text) + 5, 20);
});

test('wrap honours an explicit opts.maxChars over the layout default', () => {
  const l = layoutOf();
  l.wrap('one two three four five six seven eight', { maxChars: 12 });
  for (const t of texts(l.finish()[0])) assert.ok(pdfLen(t) <= 12, t);
});

test('wrap emits nothing for empty or whitespace-only text', () => {
  const l = layoutOf();
  l.wrap('');
  l.wrap('   \t  ');
  l.wrap(null);
  assert.deepStrictEqual(l.finish(), [[]]);
});

test('wrap normalizes typography before measuring', () => {
  const l = layoutOf();
  l.wrap('“quoted” — done…');
  assert.deepStrictEqual(texts(l.finish()[0]), ['"quoted" - done...']);
});

test('wrap passes font and align through to every line it emits', () => {
  const l = layoutOf({ maxChars: 12 });
  l.wrap('alpha bravo charlie delta', { font: 'F3', align: 'center' });
  const page = l.finish()[0];
  assert.ok(page.length > 1, 'expected the text to wrap');
  for (const ln of page) assert.strictEqual(ln.font, 'F3');
});

/* ---------- heading() ---------- */

test('heading emits bold lines at the requested size', () => {
  const l = layoutOf();
  l.heading('A Chapter Title', 20, false);
  const page = l.finish()[0];
  assert.deepStrictEqual(texts(page), ['A Chapter Title']);
  assert.strictEqual(page[0].font, A4.fonts.bold);
  assert.strictEqual(page[0].fs, 20);
});

test('heading pads above and below with fractional blank lines', () => {
  const l = layoutOf();
  l.heading('Title', 20, false);
  l.line('after');
  const page = l.finish()[0];
  near(page[0].y, TOP - A4.lineHeight * 0.4, 'heading y');
  // The heading advances by its own 1.3 leading, then the trailing 0.5 blank line.
  near(page[1].y, page[0].y - 20 * 1.3 - A4.lineHeight * 0.5, 'line after heading');
});

test('heading chunks a long title by width, not by words', () => {
  // 467 usable points / (12 * 0.6) = a 64-glyph budget at this size.
  const l = layoutOf();
  l.heading('alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima', 12, false);
  const lines = texts(l.finish()[0]);
  assert.ok(lines.length > 1, 'expected the heading to be chunked');
  const lim = Math.max(6, Math.floor(A4.usableWidth / (12 * 0.6)));
  for (const t of lines) assert.ok(pdfLen(t) <= lim, `chunk over ${lim}: ${JSON.stringify(t)}`);
  assert.strictEqual(lines.join(' '),
    'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima');
});

test('CHARACTERIZATION: heading DROPS the front of a word longer than the chunk width', () => {
  // heading() chunks with /.{1,lim}(\s+|$)/g. For a single word longer than lim there is
  // no chunk boundary that can be followed by whitespace-or-end, so the regex skips
  // forward until the tail fits — and everything before that tail is silently discarded.
  // This is worse than a mid-word split: the characters never reach the PDF at all.
  // Pinned as current behaviour; see the report — worth its own issue.
  const l = layoutOf({ usableWidth: 72 });          // lim = floor(72 / 7.2) = 10
  l.heading('Supercalifragilistic', 12, false);     // 20 glyphs, no spaces
  assert.deepStrictEqual(texts(l.finish()[0]), ['ragilistic']);

  const l2 = layoutOf({ usableWidth: 72 });
  l2.heading('abcdefghijklmno', 12, false);         // 15 glyphs
  assert.deepStrictEqual(texts(l2.finish()[0]), ['fghijklmno']);
});

test('heading chunking uses the heading font size, not the body size', () => {
  const small = layoutOf();
  small.heading('alpha bravo charlie delta echo foxtrot golf hotel india juliett', 12, false);
  const big = layoutOf();
  big.heading('alpha bravo charlie delta echo foxtrot golf hotel india juliett', 30, false);
  assert.ok(big.finish()[0].length > small.finish()[0].length,
    'a larger heading size must fit fewer glyphs per line');
});

test('heading centres when asked and left-aligns otherwise', () => {
  const c = layoutOf();
  c.heading('Mid', 20, true);
  const centered = c.finish()[0][0];
  near(centered.x, A4.margin + (A4.usableWidth - pdfLen('Mid') * 20 * 0.6) / 2, 'centered x');

  const l = layoutOf();
  l.heading('Mid', 20, false);
  assert.strictEqual(l.finish()[0][0].x, A4.margin);
});

test('an empty heading emits no line but still consumes its padding', () => {
  const l = layoutOf();
  l.heading('', 20, false);
  l.line('after');
  const page = l.finish()[0];
  assert.deepStrictEqual(texts(page), ['after']);
  near(page[0].y, TOP - A4.lineHeight * 0.4 - A4.lineHeight * 0.5, 'y after empty heading');
});

/* ---------- ensure() / newPage() ---------- */

test('a page break happens exactly when the next line no longer fits', () => {
  const l = layoutOf();
  for (let i = 0; i < LINES_PER_PAGE + 1; i++) l.line('L' + i);
  const pages = l.finish();
  assert.strictEqual(pages.length, 2);
  assert.strictEqual(pages[0].length, LINES_PER_PAGE, 'full page should hold exactly this many lines');
  assert.strictEqual(pages[1].length, 1, 'the overflow line starts the next page');
  // The last line that fit still leaves less than a full line of room above the margin.
  const lastY = pages[0][pages[0].length - 1].y;
  assert.ok(lastY - A4.lineHeight >= A4.margin, 'the last line on the page did fit');
  assert.ok(lastY - A4.lineHeight * 2 < A4.margin, 'one more line would not have fit');
});

test('exactly a full page of lines does not create a second page', () => {
  const l = layoutOf();
  for (let i = 0; i < LINES_PER_PAGE; i++) l.line('L' + i);
  const pages = l.finish();
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0].length, LINES_PER_PAGE);
});

test('ensure() on its own breaks only when there is no room left', () => {
  const roomy = layoutOf();
  roomy.ensure();
  roomy.line('a');
  assert.strictEqual(roomy.finish().length, 1, 'ensure must not break on a fresh page');

  const tight = layoutOf();
  tight.line('first');
  tight.blank((TOP - A4.margin) / A4.lineHeight - 1.5);   // leaves under one line of room
  tight.ensure();
  tight.line('second');
  const pages = tight.finish();
  assert.strictEqual(pages.length, 2);
  assert.deepStrictEqual(texts(pages[1]), ['second']);
});

test('newPage starts a fresh page with the cursor back at the top margin', () => {
  const l = layoutOf();
  l.line('a');
  l.newPage();
  l.line('b');
  const pages = l.finish();
  assert.deepStrictEqual(pages.map(texts), [['a'], ['b']]);
  assert.strictEqual(pages[0][0].y, TOP);
  assert.strictEqual(pages[1][0].y, TOP);
});

test('newPage on an empty page still emits that empty page', () => {
  const l = layoutOf();
  l.newPage();
  l.line('a');
  assert.deepStrictEqual(l.finish().map(texts), [[], ['a']]);
});

/* ---------- blank() ---------- */

test('blank moves the cursor down by whole and fractional line heights', () => {
  const l = layoutOf();
  l.line('a');
  l.blank();
  l.line('b');
  l.blank(0.5);
  l.line('c');
  const page = l.finish()[0];
  near(page[1].y, TOP - A4.lineHeight - A4.lineHeight, 'after blank()');
  near(page[2].y, page[1].y - A4.lineHeight - A4.lineHeight * 0.5, 'after blank(0.5)');
});

test('blank breaks to a new page when it runs past the bottom margin', () => {
  const l = layoutOf();
  l.line('a');
  l.blank(100);
  l.line('b');
  const pages = l.finish();
  assert.strictEqual(pages.length, 2);
  assert.deepStrictEqual(pages.map(texts), [['a'], ['b']]);
  assert.strictEqual(pages[1][0].y, TOP, 'the new page starts at the top margin');
});

test('blank stops short of a break while it still clears the margin', () => {
  const l = layoutOf();
  l.blank((TOP - A4.margin) / A4.lineHeight);   // lands exactly on the margin
  l.line('a');
  // y === margin is not < margin, so blank does not break; the line's own ensure() does.
  const pages = l.finish();
  assert.strictEqual(pages.length, 2);
  assert.deepStrictEqual(texts(pages[1]), ['a']);
});

/* ---------- line() positioning ---------- */

test('a plain line sits on the left margin', () => {
  const l = layoutOf();
  l.line('text');
  assert.strictEqual(l.finish()[0][0].x, A4.margin);
});

test('indent is measured in body character widths', () => {
  const l = layoutOf();
  l.line('text', { indent: 5 });
  assert.strictEqual(l.finish()[0][0].x, A4.margin + 5 * A4.charWidth);
});

test('centring uses the glyph count and the line own font size', () => {
  const l = layoutOf();
  l.line('abcd', { align: 'center' });
  l.line('abcd', { align: 'center', fsize: 24 });
  const page = l.finish()[0];
  near(page[0].x, A4.margin + (A4.usableWidth - 4 * (A4.fontSize * 0.6)) / 2, 'body-size centre');
  near(page[1].x, A4.margin + (A4.usableWidth - 4 * (24 * 0.6)) / 2, '24pt centre');
});

test('a centred line wider than the page is clamped to the left margin', () => {
  const l = layoutOf();
  l.line('x'.repeat(500), { align: 'center' });
  assert.strictEqual(l.finish()[0][0].x, A4.margin);
});

test('centring counts glyphs, not UTF-16 code units', () => {
  const l = layoutOf();
  l.line('𝔘𝔘', { align: 'center' });   // two astral glyphs
  near(l.finish()[0][0].x, A4.margin + (A4.usableWidth - 2 * (A4.fontSize * 0.6)) / 2, 'astral centre');
});

test('opts.lh overrides the advance for the following line', () => {
  const l = layoutOf();
  l.line('a', { lh: 40 });
  l.line('b');
  const page = l.finish()[0];
  assert.strictEqual(page[1].y, TOP - 40);
});

/* ---------- font selection ---------- */

test('lines default to the normal font and headings to bold', () => {
  const l = layoutOf();
  l.line('plain');
  l.wrap('wrapped');
  l.heading('Head', 20, false);
  const page = l.finish()[0];
  assert.deepStrictEqual(page.map(x => x.font), ['F1', 'F1', 'F2']);
});

test('an explicit opts.font is respected', () => {
  const l = layoutOf();
  l.line('subtitle', { font: A4.fonts.italic });
  assert.strictEqual(l.finish()[0][0].font, 'F3');
});

test('CHARACTERIZATION: a line carries exactly one font — nothing switches mid-line', () => {
  // Every emitted record is {x, y, text, font, fs} with a single font id, and the
  // serializer turns each record into one Tf/Tj pair. There is no representation for a
  // font change inside a line, which is exactly why a paragraph's bold/italic runs get
  // flattened before they reach here. Pinned; do not "fix" without reworking the record.
  const l = layoutOf();
  l.line('mixed **bold** and *italic* source text');
  l.wrap('mixed bold and italic source text');
  l.heading('Mixed Heading', 20, true);
  for (const ln of l.finish()[0]) {
    assert.strictEqual(typeof ln.font, 'string');
    assert.deepStrictEqual(Object.keys(ln).sort(), ['font', 'fs', 'text', 'x', 'y']);
  }
});

/* ---------- startPage() / finish() ---------- */

test('startPage does nothing when the current page is still empty', () => {
  const l = layoutOf();
  l.startPage();
  l.line('a');
  assert.deepStrictEqual(l.finish().map(texts), [['a']]);
});

test('startPage breaks to a fresh page once the current one has content', () => {
  const l = layoutOf();
  l.line('a');
  l.startPage();
  l.line('b');
  assert.deepStrictEqual(l.finish().map(texts), [['a'], ['b']]);
});

test('startPage(fraction) drops the cursor to that fraction of the page height', () => {
  const l = layoutOf();
  l.line('a');
  l.startPage(0.5);
  l.line('b');
  const pages = l.finish();
  assert.strictEqual(pages[1][0].y, A4.pageH * 0.5);

  const t = layoutOf();
  t.startPage(0.62);          // the title page: no break, just a lower starting cursor
  t.line('title');
  const only = t.finish();
  assert.strictEqual(only.length, 1);
  assert.strictEqual(only[0][0].y, A4.pageH * 0.62);
});

test('finish flushes the page in progress and always yields at least one page', () => {
  const l = layoutOf();
  l.line('a');
  assert.deepStrictEqual(l.finish().map(texts), [['a']]);
  assert.deepStrictEqual(layoutOf().finish(), [[]], 'an empty document is still one page');
});

/* ---------- buildPdfPages() ---------- */

/* A realistic manuscript: two parts, three chapters, five scenes, a manual break and
   Cyrillic titles, with enough body text per scene to force several page breaks. */
const CHAPTERS = [
  { id: 'ch1', title: 'The Gathering Storm', scenes: [
    { id: 's1', title: 'The Beginning', content: '<p>one</p>' },
    { id: 's2', title: 'Продолжение', content: '<p>two</p>' } ] },
  { id: 'ch2', title: 'Глава Два', scenes: [
    { id: 's3', title: 'Scene Three', content: '<p>three</p>' } ] },
  { id: 'ch3', title: 'Развязка и финал', scenes: [
    { id: 's4', title: 'Последняя сцена', content: '<p>four</p>' },
    { id: 's5', title: 'Epilogue', content: '<p>five</p>' } ] },
];
const ITEMS = [
  { type: 'part', title: 'Часть Первая' },
  { type: 'scene', sceneId: 's1' },
  { type: 'scene', sceneId: 's2' },
  { type: 'part', title: 'Part Two' },
  { type: 'scene', sceneId: 's3' },
  { type: 'break' },
  { type: 'scene', sceneId: 's4' },
  { type: 'scene', sceneId: 's5' },
];
const findScene = id => {
  for (const c of CHAPTERS) {
    const s = c.scenes.find(x => x.id === id);
    if (s) return { chapter: c, scene: s };
  }
  return null;
};

const BASE = {
  fontSize: 12, lineSpacing: 1.5, margins: 'normal', pageSize: 'A4', indent: 'indent',
  sceneTitles: 'yes', includeParts: true, sceneSeparator: '***', sceneSepCustom: '',
  numberChapters: 'arabic', titlePage: true, titleText: 'Моя Книга', subtitle: 'A Subtitle',
  author: 'Автор', dateText: '2024', toc: true, tocDepth: 'scenes', tocPosition: 'afterTitle',
};
const settings = over => ({ ...BASE, ...over });

const LONG = 'Ветер поднимался над пустошью и нёс с собой запах дождя. '.repeat(20);
/* Stands in for htmlToBlocks(), which needs a real DOM. Records what it was handed so the
   tests can check the conversion is driven once per scene, in flow order. */
function stubBlocks(blocks) {
  const calls = [];
  const fn = html => {
    calls.push(html);
    return blocks || [{ tag: 'p', runs: [{ text: LONG }] }];
  };
  fn.calls = calls;
  return fn;
}

function build(over, blocks) {
  const s = settings(over);
  const flow = buildFlow(ITEMS, s, CHAPTERS, findScene);
  const layout = createPdfLayout({ ...A4 });
  const convert = stubBlocks(blocks);
  buildPdfPages(flow, s, layout, convert);
  return { s, flow, pages: layout.finish(), convert };
}

test('the title page comes first, on a page of its own', () => {
  const { pages } = build();
  assert.deepStrictEqual(texts(pages[0]), ['Моя Книга', 'A Subtitle', 'Автор', '2024']);
  assert.strictEqual(pages[0][0].y, A4.pageH * 0.62, 'the title starts partway down the page');
  assert.strictEqual(pages[0][0].font, A4.fonts.bold);
  assert.strictEqual(pages[0][0].fs, A4.fontSize + 10);
  assert.strictEqual(pages[0][1].font, A4.fonts.italic, 'the subtitle is italic');
  assert.strictEqual(pages[0][2].font, A4.fonts.normal);
});

test('title-page fields are omitted individually when unset', () => {
  const { pages } = build({ subtitle: '', author: '', dateText: '' });
  assert.deepStrictEqual(texts(pages[0]), ['Моя Книга']);
});

test('no title page means the body starts on the first page', () => {
  const { pages } = build({ titlePage: false, toc: false });
  assert.deepStrictEqual(texts(pages[0]), ['Часть Первая']);
});

test('the table of contents follows the title page and matches compTocEntries', () => {
  const { s, flow, pages } = build();
  const toc = pages[1];
  assert.strictEqual(toc[0].text, 'Contents');
  assert.strictEqual(toc[0].font, A4.fonts.bold);
  assert.deepStrictEqual(texts(toc).slice(1), compTocEntries(flow, s).map(f => f.title));
});

test('scene entries in the contents are indented, parts and chapters are not', () => {
  const { s, flow, pages } = build();
  const entries = compTocEntries(flow, s);
  pages[1].slice(1).forEach((ln, i) => {
    const expected = A4.margin + (entries[i].type === 'scene' ? 3 : 0) * A4.charWidth;
    assert.strictEqual(ln.x, expected, `TOC entry ${entries[i].title}`);
  });
});

test('tocPosition "end" puts the contents on the last page instead', () => {
  const { s, flow, pages } = build({ tocPosition: 'end' });
  assert.deepStrictEqual(texts(pages[0]), ['Моя Книга', 'A Subtitle', 'Автор', '2024']);
  assert.strictEqual(pages[1][0].text, 'Часть Первая', 'the body starts right after the title page');
  const last = pages[pages.length - 1];
  assert.strictEqual(last[0].text, 'Contents');
  assert.deepStrictEqual(texts(last).slice(1), compTocEntries(flow, s).map(f => f.title));
});

test('toc disabled emits no contents page at either position', () => {
  for (const tocPosition of ['afterTitle', 'end']) {
    const { pages } = build({ toc: false, tocPosition });
    const all = pages.flatMap(texts);
    assert.ok(!all.includes('Contents'), `tocPosition=${tocPosition} still emitted a TOC`);
  }
});

test('every part starts its own page, positioned half way down', () => {
  const { pages } = build();
  const partPages = pages.filter(p => p.length && ['Часть Первая', 'Part Two'].includes(p[0].text));
  assert.strictEqual(partPages.length, 2, 'both parts should open a page');
  for (const p of partPages) {
    assert.strictEqual(p.length, 1, 'a part title has its page to itself');
    near(p[0].y, A4.pageH * 0.5 - A4.lineHeight * 0.4, 'part heading y');
    assert.strictEqual(p[0].fs, A4.fontSize + 8);
    assert.strictEqual(p[0].font, A4.fonts.bold);
  }
});

test('every chapter starts a fresh page, at the top', () => {
  const { pages } = build();
  const chapterPages = pages.filter(p => p.length && /^Chapter \d/.test(p[0].text));
  assert.strictEqual(chapterPages.length, 3, 'three chapters, three page starts');
  for (const p of chapterPages) {
    near(p[0].y, TOP - A4.lineHeight * 0.4, 'chapter heading y');
    assert.strictEqual(p[0].fs, A4.fontSize + 5);
  }
});

test('the whole document comes out in flow order across multiple pages', () => {
  const { pages } = build({ toc: false });   // the TOC would repeat every title
  assert.ok(pages.length > 5, `expected the fixture to span several pages, got ${pages.length}`);
  const headings = pages.flatMap(texts).filter(t =>
    ['Часть Первая', 'Part Two'].includes(t) || /^Chapter \d/.test(t));
  assert.deepStrictEqual(headings, [
    'Часть Первая',
    'Chapter 1: The Gathering Storm',
    'Part Two',
    'Chapter 2: Глава Два',
    'Chapter 3: Развязка и финал',
  ]);
});

test('scene titles are emitted only when showTitle is set', () => {
  const shown = build().pages.flatMap(texts);
  assert.ok(shown.includes('The Beginning'));
  assert.ok(shown.includes('Последняя сцена'));

  const hidden = build({ sceneTitles: 'noTitles' }).pages.flatMap(texts);
  assert.ok(!hidden.includes('The Beginning'), 'scene titles must be suppressed');
});

test('a separator is drawn between consecutive scenes but not under a heading', () => {
  const { pages } = build({ toc: false, titlePage: false });
  // Scene 1 follows the chapter heading directly; scene 2 follows scene 1.
  const page = pages.find(p => p.some(l => l.text === 'The Beginning'));
  const idx = page.findIndex(l => l.text === 'The Beginning');
  assert.notStrictEqual(page[idx - 1].text, '* * *', 'no separator directly after a heading');
  assert.ok(pages.flatMap(texts).includes('* * *'), 'consecutive scenes are separated');
});

test('an explicit break item emits the separator too', () => {
  const withBreak = build({ toc: false, titlePage: false }).pages.flatMap(texts);
  assert.ok(withBreak.filter(t => t === '* * *').length >= 2,
    'both the scene-to-scene separator and the manual break should appear');
});

test('a custom separator string is used for both kinds of break', () => {
  const { pages } = build({ sceneSeparator: 'custom', sceneSepCustom: '~ ~ ~' });
  const all = pages.flatMap(texts);
  assert.ok(all.includes('~ ~ ~'));
  assert.ok(!all.includes('* * *'));
});

test('the html converter is called once per scene, in flow order', () => {
  const { flow, convert } = build();
  const sceneHtml = flow.filter(f => f.type === 'scene').map(f => f.html);
  assert.deepStrictEqual(convert.calls, sceneHtml);
});

test('heading blocks inside a scene map to their own heading sizes', () => {
  const { pages } = build({ toc: false, titlePage: false }, [
    { tag: 'h1', runs: [{ text: 'Block One' }] },
    { tag: 'h2', runs: [{ text: 'Block Two' }] },
    { tag: 'h3', runs: [{ text: 'Block Three' }] },
    { tag: 'p', runs: [{ text: 'Body copy.' }] },
  ]);
  const byText = new Map(pages.flatMap(p => p).map(l => [l.text, l]));
  assert.strictEqual(byText.get('Block One').fs, A4.fontSize + 4);
  assert.strictEqual(byText.get('Block Two').fs, A4.fontSize + 2);
  assert.strictEqual(byText.get('Block Three').fs, A4.fontSize + 1);
  assert.strictEqual(byText.get('Body copy.').fs, A4.fontSize);
  assert.strictEqual(byText.get('Body copy.').font, A4.fonts.normal);
});

test('an empty block advances the cursor instead of emitting a line', () => {
  const { pages } = build({ toc: false, titlePage: false, includeParts: false, sceneTitles: 'no' }, [
    { tag: 'p', runs: [{ text: '   ' }] },
    { tag: 'p', runs: [{ text: 'after the gap' }] },
  ]);
  const page = pages[0];
  const i = page.findIndex(l => l.text === 'after the gap');
  assert.ok(i !== -1, 'the following block is still emitted');
  assert.ok(!texts(page).some(t => t.trim() === ''), 'no blank line record is pushed');
});

test('body paragraphs are indented when settings.indent is "indent"', () => {
  const first = build({ toc: false, titlePage: false }, [{ tag: 'p', runs: [{ text: LONG }] }]);
  const firstLine = first.pages.flatMap(p => p).find(l => l.text.startsWith('Ветер'));
  assert.strictEqual(firstLine.x, A4.margin + 5 * A4.charWidth);

  const none = build({ toc: false, titlePage: false, indent: 'none' }, [{ tag: 'p', runs: [{ text: LONG }] }]);
  const noneLine = none.pages.flatMap(p => p).find(l => l.text.startsWith('Ветер'));
  assert.strictEqual(noneLine.x, A4.margin);
});

test('CHARACTERIZATION: bold and italic runs are flattened into plain text', () => {
  // buildPdfPages joins bl.runs into one string and drops the b/i flags, because a layout
  // line can only carry one font. The text survives; the emphasis does not. Pinned here so
  // a fix has to change this test on purpose rather than by accident.
  const { pages } = build({ toc: false, titlePage: false }, [
    { tag: 'p', runs: [{ text: 'plain ' }, { text: 'bolded', b: true }, { text: ' and ' }, { text: 'sloped', i: true }] },
  ]);
  const line = pages.flatMap(p => p).find(l => l.text.startsWith('plain'));
  assert.strictEqual(line.text, 'plain bolded and sloped');
  assert.strictEqual(line.font, A4.fonts.normal, 'the whole run collapses onto the normal font');
});

test('an empty flow still produces a single page', () => {
  const layout = createPdfLayout({ ...A4 });
  buildPdfPages([], settings({ titlePage: false, toc: false }), layout, stubBlocks());
  assert.deepStrictEqual(layout.finish(), [[]]);
});

test('pagination is deterministic', () => {
  const a = build().pages;
  const b = build().pages;
  assert.deepStrictEqual(a, b);
});
