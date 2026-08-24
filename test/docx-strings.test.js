/* Coverage for the pure OOXML string builders behind the DOCX export.
 *
 * A .docx is a zip of XML documents, and Word is unforgiving: one unescaped '&' or one
 * stray literal newline inside <w:t> and the file either refuses to open or quietly loses
 * the author's line breaks. None of that surfaces in the app — it surfaces when someone
 * opens the exported manuscript somewhere else. These builders are the last place the
 * text is still inspectable, so they are worth pinning precisely.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * builders are lifted out and run in isolation, the same technique as
 * test/pdf-cyrillic.test.js and test/migrate-novel.test.js. They are not contiguous —
 * htmlToBlocks() sits between xmlEsc() and docxP() and is deliberately left out, since it
 * needs a real DOM — so there are three marker pairs and the test concatenates the slices.
 *
 * docxP/docxTOC read the module-level `comp` global rather than taking settings as an
 * argument, so a mutable stand-in is injected as a function parameter and each test
 * assigns exactly the settings fixture it needs. That is scaffolding for reaching the
 * builders, not a test of `comp` itself.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

const comp = { settings: {} };

function slice(name) {
  const startMark = `/* --- docx-strings:${name}:start ---`;
  const endMark = `/* --- docx-strings:${name}:end --- */`;
  const start = APP.indexOf(startMark);
  const end = APP.indexOf(endMark);
  assert.ok(start !== -1 && end > start,
    `docx-strings:${name} markers missing from src/app.js — the code moved, update this test`);
  return APP.slice(start, end);
}

function loadDocxBuilders() {
  // compTocEntries lives outside the docx-strings markers but docxTOC calls it,
  // so pull it in as a dependency from its own marker pair.
  const compTocStart = APP.indexOf('/* --- comp-toc:start ---');
  const compTocEnd = APP.indexOf('/* --- comp-toc:end --- */');
  assert.ok(compTocStart !== -1 && compTocEnd > compTocStart,
    'comp-toc markers missing from src/app.js — compTocEntries moved, update this test');
  const compTocSrc = APP.slice(compTocStart, compTocEnd);
  const src = compTocSrc + '\n' + ['esc', 'xmlesc', 'builders'].map(slice).join('\n');
  // A new Function body is sloppy-mode by default; src/app.js runs under 'use strict'.
  return new Function('comp', `'use strict';\n${src}\nreturn { xmlEsc, docxP, docxTOC, docxPageBreak };`)(comp);
}

const { xmlEsc, docxP, docxTOC, docxPageBreak } = loadDocxBuilders();

/* Mirrors defaultCompSettings() for the fields these builders read; each test overrides
   only what it is about, so an unrelated default changing cannot make a test lie. */
const BASE_SETTINGS = {
  align: 'left', lineSpacing: 1, paraSpacing: 'none', indent: 'none',
  toc: false, tocDepth: 'chapters'
};
const withSettings = over => { comp.settings = { ...BASE_SETTINGS, ...over }; };

// Pull the text out of every <w:t> in a paragraph, still escaped, for inspection.
const wtPayloads = xml => [...xml.matchAll(/<w:t xml:space="preserve">([\s\S]*?)<\/w:t>/g)].map(m => m[1]);
const runCount = xml => (xml.match(/<w:r>/g) || []).length;

/* ---------- xmlEsc ---------- */

test('xmlEsc escapes the XML-significant characters', () => {
  assert.strictEqual(xmlEsc('a & b'), 'a &amp; b');
  assert.strictEqual(xmlEsc('<tag>'), '&lt;tag&gt;');
  assert.strictEqual(xmlEsc('a<b>c&d'), 'a&lt;b&gt;c&amp;d');
  // Ampersand first, or the escapes themselves get double-escaped.
  assert.strictEqual(xmlEsc('&lt;'), '&amp;lt;');
  assert.strictEqual(xmlEsc('Привет & мир'), 'Привет &amp; мир', 'Cyrillic must pass through');
});

test('xmlEsc turns null and undefined into an empty string, not "null"/"undefined"', () => {
  // A missing scene title or author field must not print the word "undefined" into the
  // exported manuscript.
  assert.strictEqual(xmlEsc(null), '');
  assert.strictEqual(xmlEsc(undefined), '');
  assert.strictEqual(xmlEsc(''), '');
  assert.strictEqual(xmlEsc(0), '0', 'a real zero is not the same as absent');
  assert.strictEqual(xmlEsc(false), 'false');
});

/* ---------- docxP: paragraph properties ---------- */

test('docxP alignment: left by default, opts.align wins, justify becomes Word\'s "both"', () => {
  withSettings({});
  assert.match(docxP([{ text: 'x' }]), /<w:jc w:val="left"\/>/);

  withSettings({ align: 'justify' });
  assert.match(docxP([{ text: 'x' }]), /<w:jc w:val="both"\/>/,
    'Word spells justified alignment "both"; "justify" is not a valid w:val');
  assert.ok(!/w:val="justify"/.test(docxP([{ text: 'x' }])), 'raw "justify" leaked into the XML');

  // An explicit centre request overrides the document-wide setting.
  assert.match(docxP([{ text: 'x' }], { align: 'center' }), /<w:jc w:val="center"\/>/);
  withSettings({ align: 'left' });
  assert.match(docxP([{ text: 'x' }], { align: 'center' }), /<w:jc w:val="center"\/>/);
});

test('docxP line spacing is emitted only when it differs from single', () => {
  withSettings({ lineSpacing: 1 });
  assert.ok(!/<w:spacing/.test(docxP([{ text: 'x' }])), 'single spacing should emit nothing');

  withSettings({ lineSpacing: 1.5 });
  assert.match(docxP([{ text: 'x' }]), /<w:spacing w:line="360" w:lineRule="auto"\/>/);

  withSettings({ lineSpacing: 2 });
  assert.match(docxP([{ text: 'x' }]), /<w:spacing w:line="480" w:lineRule="auto"\/>/);

  // 240 twentieths of a point = one line; the multiplier is rounded to a whole number.
  withSettings({ lineSpacing: 1.15 });
  assert.match(docxP([{ text: 'x' }]), /w:line="276"/);
});

test('docxP paragraph spacing adds w:after only for the "space" setting', () => {
  withSettings({ paraSpacing: 'space' });
  assert.match(docxP([{ text: 'x' }]), /<w:spacing w:after="120"\/>/);

  withSettings({ paraSpacing: 'none' });
  assert.ok(!/w:after/.test(docxP([{ text: 'x' }])));

  // Both spacing settings at once must share a single <w:spacing> element.
  withSettings({ lineSpacing: 2, paraSpacing: 'space' });
  const both = docxP([{ text: 'x' }]);
  assert.match(both, /<w:spacing w:line="480" w:lineRule="auto" w:after="120"\/>/);
  assert.strictEqual((both.match(/<w:spacing/g) || []).length, 1,
    'w:spacing must be one element, not two');
});

test('docxP first-line indent respects the setting and the noIndent override', () => {
  withSettings({ indent: 'indent' });
  assert.match(docxP([{ text: 'x' }]), /<w:ind w:firstLine="720"\/>/);
  assert.ok(!/<w:ind/.test(docxP([{ text: 'x' }], { noIndent: true })),
    'noIndent must suppress the indent — headings and TOC lines rely on it');

  withSettings({ indent: 'none' });
  assert.ok(!/<w:ind/.test(docxP([{ text: 'x' }])));
});

/* ---------- docxP: runs ---------- */

test('docxP bold and italic apply per run, and opts force them on every run', () => {
  withSettings({});
  const mixed = docxP([{ text: 'plain' }, { text: 'bold', b: true }, { text: 'ital', i: true }]);
  const runs = mixed.split('<w:r>').slice(1);
  assert.strictEqual(runs.length, 3);
  assert.ok(!runs[0].includes('<w:rPr>'), 'a plain run should carry no run properties');
  assert.ok(runs[1].includes('<w:b/>') && !runs[1].includes('<w:i/>'));
  assert.ok(runs[2].includes('<w:i/>') && !runs[2].includes('<w:b/>'));

  // opts.b / opts.i are how headings and the title page force styling.
  const forced = docxP([{ text: 'a' }, { text: 'b', b: true }], { b: true, i: true });
  assert.strictEqual((forced.match(/<w:b\/>/g) || []).length, 2, 'opts.b must bold every run');
  assert.strictEqual((forced.match(/<w:i\/>/g) || []).length, 2, 'opts.i must italicise every run');

  assert.match(docxP([{ text: 'big' }], { sz: 56 }), /<w:sz w:val="56"\/>/);
});

test('a newline inside run text becomes an explicit <w:br/>, never a literal newline', () => {
  // The highest-value case here. OOXML gives no meaning to a raw newline inside <w:t>:
  // Word collapses it to a space. If this ever regressed, pasted multi-line text would
  // silently run together in the exported .docx while looking fine in the editor.
  withSettings({});
  const xml = docxP([{ text: 'first\nsecond\nthird' }]);

  assert.deepStrictEqual(wtPayloads(xml), ['first', 'second', 'third'],
    'the newline-separated segments were not split into separate runs');
  assert.strictEqual((xml.match(/<w:r><w:br\/><\/w:r>/g) || []).length, 2,
    'expected one explicit break between each pair of segments');
  assert.ok(!xml.includes('\n'), 'a literal newline survived into the XML');

  // The break goes *between* segments — never a trailing one.
  assert.ok(!/<w:r><w:br\/><\/w:r>$/.test(xml.replace('</w:p>', '')), 'trailing break emitted');

  // Formatting has to be reapplied to each segment, not just the first.
  const bold = docxP([{ text: 'one\ntwo', b: true }]);
  assert.strictEqual((bold.match(/<w:b\/>/g) || []).length, 2,
    'the run style was dropped after the line break');

  // A newline at the very start or end still yields empty segments rather than vanishing.
  assert.deepStrictEqual(wtPayloads(docxP([{ text: '\nmid\n' }])), ['', 'mid', '']);
});

test('XML-significant characters in run text are escaped, not emitted raw', () => {
  withSettings({});
  const xml = docxP([{ text: 'Tom & Jerry <b>not a tag</b>' }]);

  assert.deepStrictEqual(wtPayloads(xml), ['Tom &amp; Jerry &lt;b&gt;not a tag&lt;/b&gt;']);
  // Nothing inside <w:t> may be a bare '<' or a bare '&' — either one makes Word refuse
  // to open the document.
  for (const payload of wtPayloads(xml)) {
    assert.ok(!payload.includes('<'), 'a raw "<" reached the XML');
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(payload), 'a bare "&" reached the XML');
  }

  // Quotes are NOT escaped, which is correct: " and ' are only significant inside
  // attribute values, and these land in element content. Pinned so nobody "fixes" it into
  // &quot; noise, and so the real constraint (no bare < or &) stays the thing asserted.
  assert.deepStrictEqual(wtPayloads(docxP([{ text: `say "hi" it's fine` }])), [`say "hi" it's fine`]);

  assert.deepStrictEqual(wtPayloads(docxP([{ text: 'Кавычки «ёлочки» — тире' }])),
    ['Кавычки «ёлочки» — тире'], 'Cyrillic and typographic punctuation must pass through');
});

test('a paragraph with no runs still emits a well-formed empty run', () => {
  // An empty <w:p> with no <w:r> is not what Word writes for a blank line, and the
  // exporter uses these as spacers.
  withSettings({});
  const expected = '<w:r><w:t xml:space="preserve"></w:t></w:r>';
  for (const [label, runs] of [['undefined', undefined], ['null', null], ['empty array', []]]) {
    const xml = docxP(runs);
    assert.ok(xml.includes(expected), `${label}: no fallback run emitted`);
    assert.strictEqual(runCount(xml), 1, `${label}: expected exactly one run`);
    assert.match(xml, /^<w:p>.*<\/w:p>$/s, `${label}: paragraph is not well-formed`);
  }

  // A run that exists but holds empty/absent text still produces a real run.
  for (const [label, runs] of [['empty text', [{ text: '' }]], ['absent text', [{}]], ['null text', [{ text: null }]]]) {
    const xml = docxP(runs);
    assert.strictEqual(runCount(xml), 1, `${label}: expected exactly one run`);
    assert.deepStrictEqual(wtPayloads(xml), [''], `${label}: unexpected payload`);
  }
});

test('docxP output is always a single balanced w:p with pPr before the runs', () => {
  withSettings({ align: 'justify', lineSpacing: 2, paraSpacing: 'space', indent: 'indent' });
  const xml = docxP([{ text: 'body text' }]);

  assert.match(xml, /^<w:p><w:pPr>.*<\/w:pPr><w:r>/, 'w:pPr must come first inside w:p');
  assert.match(xml, /<\/w:p>$/);
  assert.strictEqual((xml.match(/<w:p>/g) || []).length, 1);
  assert.strictEqual((xml.match(/<\/w:p>/g) || []).length, 1);
  assert.strictEqual((xml.match(/<w:r>/g) || []).length, (xml.match(/<\/w:r>/g) || []).length);
  assert.strictEqual((xml.match(/<w:t /g) || []).length, (xml.match(/<\/w:t>/g) || []).length);
});

/* ---------- docxTOC ---------- */

const FLOW = [
  { type: 'part', title: 'Part One', showTitle: true },
  { type: 'chapter', title: 'Chapter 1', showTitle: true },
  { type: 'scene', title: 'Scene A', showTitle: true },
  { type: 'scene', title: 'Scene B', showTitle: false },
  { type: 'chapter', title: 'Chapter 2', showTitle: true },
  { type: 'scene', title: 'Scene C', showTitle: true },
  { type: 'break', title: 'Section break', showTitle: true }
];

// The TOC body lines are everything after the "Contents" heading paragraph.
const tocTitles = flow => wtPayloads(docxTOC(flow)).slice(1);

test('docxTOC always lists parts and chapters, whatever the depth setting', () => {
  for (const tocDepth of ['chapters', 'scenes']) {
    withSettings({ tocDepth });
    const titles = tocTitles(FLOW);
    for (const must of ['Part One', 'Chapter 1', 'Chapter 2']) {
      assert.ok(titles.includes(must), `tocDepth=${tocDepth}: missing ${must}`);
    }
    assert.ok(!titles.includes('Section break'), `tocDepth=${tocDepth}: a break should never be listed`);
  }
});

test('docxTOC includes a scene only when depth is "scenes" AND the scene shows its title', () => {
  // All four combinations of the two conditions, since either one alone must not be
  // enough — a scene with showTitle off has no visible heading to jump to.
  withSettings({ tocDepth: 'scenes' });
  const deep = tocTitles(FLOW);
  assert.ok(deep.includes('Scene A'), 'scenes + showTitle:true should be listed');
  assert.ok(deep.includes('Scene C'), 'scenes + showTitle:true should be listed');
  assert.ok(!deep.includes('Scene B'), 'scenes + showTitle:false must not be listed');

  withSettings({ tocDepth: 'chapters' });
  const shallow = tocTitles(FLOW);
  assert.ok(!shallow.includes('Scene A'), 'chapters + showTitle:true must not be listed');
  assert.ok(!shallow.includes('Scene B'), 'chapters + showTitle:false must not be listed');

  assert.deepStrictEqual(deep, ['Part One', 'Chapter 1', 'Scene A', 'Chapter 2', 'Scene C']);
  assert.deepStrictEqual(shallow, ['Part One', 'Chapter 1', 'Chapter 2']);
});

test('docxTOC opens with a centred, bold, unindented "Contents" heading', () => {
  withSettings({ tocDepth: 'chapters', indent: 'indent' });
  const xml = docxTOC(FLOW);
  const heading = xml.slice(0, xml.indexOf('</w:p>') + 6);

  assert.match(heading, /<w:jc w:val="center"\/>/);
  assert.match(heading, /<w:b\/>/);
  assert.match(heading, /<w:sz w:val="32"\/>/);
  assert.ok(!heading.includes('<w:ind'), 'the Contents heading must not be indented');
  assert.deepStrictEqual(wtPayloads(heading), ['Contents']);

  // Entry lines are unindented too, even with document indent switched on.
  assert.ok(!xml.slice(heading.length).includes('<w:ind'), 'TOC entries must not be indented');
});

test('docxTOC escapes entry titles and emits a heading even with an empty flow', () => {
  withSettings({ tocDepth: 'chapters' });
  assert.deepStrictEqual(tocTitles([{ type: 'chapter', title: 'Cloak & Dagger <1>', showTitle: true }]),
    ['Cloak &amp; Dagger &lt;1&gt;']);

  const empty = docxTOC([]);
  assert.deepStrictEqual(wtPayloads(empty), ['Contents'], 'an empty flow should still emit the heading');
  assert.strictEqual((empty.match(/<w:p>/g) || []).length, 1);
});

/* ---------- docxPageBreak ---------- */

test('docxPageBreak output is exactly the expected paragraph', () => {
  assert.strictEqual(docxPageBreak(), '<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  // Independent of settings — it takes no arguments and reads no globals.
  withSettings({ align: 'justify', indent: 'indent', lineSpacing: 2 });
  assert.strictEqual(docxPageBreak(), '<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
});
