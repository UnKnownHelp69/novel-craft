/* Coverage for compTocEntries() — the shared predicate that decides which flow
 * items appear in a compiled novel's table of contents.
 *
 * Every export format (HTML, TXT, PDF, EPUB, DOCX) filters the compilation flow
 * to build its TOC. Before the dedup, each had its own inline copy of the same
 * predicate; now they all call compTocEntries(flow, settings). This test pins
 * the four meaningful combinations of the two conditions that govern scene
 * inclusion (tocDepth and showTitle), plus the unconditional inclusion of parts
 * and chapters, so a future refactor cannot silently change what lands in the
 * TOC.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md),
 * so the function is lifted out between the `comp-toc` markers and run here in
 * isolation — the same technique as test/pdf-cyrillic.test.js,
 * test/migrate-novel.test.js, test/zip-writer.test.js and
 * test/docx-strings.test.js.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

function loadCompToc() {
  const start = APP.indexOf('/* --- comp-toc:start ---');
  const end = APP.indexOf('/* --- comp-toc:end --- */');
  assert.ok(start !== -1 && end > start,
    'comp-toc markers missing from src/app.js — the function moved, update this test');
  const src = APP.slice(start, end);
  // A new Function body is sloppy-mode by default; src/app.js runs under 'use strict'.
  return new Function(`'use strict';\n${src}\nreturn { compTocEntries };`)();
}

const { compTocEntries } = loadCompToc();

/* A representative compilation flow covering every entry type the predicate
   cares about. Breaks should never appear in a TOC regardless of settings. */
const FLOW = [
  { type: 'part',    title: 'Part One',       showTitle: true },
  { type: 'chapter', title: 'Chapter 1',      showTitle: true },
  { type: 'scene',   title: 'Scene A',        showTitle: true },
  { type: 'scene',   title: 'Scene B',        showTitle: false },
  { type: 'break',   title: 'Section break',  showTitle: true },
  { type: 'chapter', title: 'Chapter 2',      showTitle: true },
  { type: 'scene',   title: 'Scene C',        showTitle: true },
];

const titles = entries => entries.map(e => e.title);

/* ---------- Parts and chapters are always included ---------- */

test('parts and chapters are included regardless of tocDepth', () => {
  for (const tocDepth of ['chapters', 'scenes']) {
    const result = compTocEntries(FLOW, { tocDepth });
    const t = titles(result);
    for (const must of ['Part One', 'Chapter 1', 'Chapter 2']) {
      assert.ok(t.includes(must), `tocDepth=${tocDepth}: missing ${must}`);
    }
    assert.ok(!t.includes('Section break'),
      `tocDepth=${tocDepth}: a break should never appear in the TOC`);
  }
});

/* ---------- The four tocDepth × showTitle combinations ---------- */

test('tocDepth="scenes" + showTitle=true: scene is included', () => {
  const result = compTocEntries(FLOW, { tocDepth: 'scenes' });
  const t = titles(result);
  assert.ok(t.includes('Scene A'), 'Scene A (showTitle:true) should be listed');
  assert.ok(t.includes('Scene C'), 'Scene C (showTitle:true) should be listed');
});

test('tocDepth="scenes" + showTitle=false: scene is excluded', () => {
  const result = compTocEntries(FLOW, { tocDepth: 'scenes' });
  const t = titles(result);
  assert.ok(!t.includes('Scene B'), 'Scene B (showTitle:false) must not be listed');
});

test('tocDepth="chapters" + showTitle=true: scene is excluded', () => {
  const result = compTocEntries(FLOW, { tocDepth: 'chapters' });
  const t = titles(result);
  assert.ok(!t.includes('Scene A'), 'Scene A must not be listed at chapters depth');
  assert.ok(!t.includes('Scene C'), 'Scene C must not be listed at chapters depth');
});

test('tocDepth="chapters" + showTitle=false: scene is excluded', () => {
  const result = compTocEntries(FLOW, { tocDepth: 'chapters' });
  const t = titles(result);
  assert.ok(!t.includes('Scene B'), 'Scene B must not be listed at chapters depth');
});

/* ---------- Full result snapshots ---------- */

test('full result at depth "scenes"', () => {
  const result = compTocEntries(FLOW, { tocDepth: 'scenes' });
  assert.deepStrictEqual(titles(result),
    ['Part One', 'Chapter 1', 'Scene A', 'Chapter 2', 'Scene C']);
});

test('full result at depth "chapters"', () => {
  const result = compTocEntries(FLOW, { tocDepth: 'chapters' });
  assert.deepStrictEqual(titles(result),
    ['Part One', 'Chapter 1', 'Chapter 2']);
});

/* ---------- Edge cases ---------- */

test('empty flow returns an empty array', () => {
  assert.deepStrictEqual(compTocEntries([], { tocDepth: 'scenes' }), []);
  assert.deepStrictEqual(compTocEntries([], { tocDepth: 'chapters' }), []);
});

test('a flow with only scenes respects tocDepth', () => {
  const scenesOnly = [
    { type: 'scene', title: 'S1', showTitle: true },
    { type: 'scene', title: 'S2', showTitle: false },
  ];
  assert.deepStrictEqual(titles(compTocEntries(scenesOnly, { tocDepth: 'scenes' })), ['S1']);
  assert.deepStrictEqual(compTocEntries(scenesOnly, { tocDepth: 'chapters' }), []);
});

test('a flow with only parts and chapters returns them all at any depth', () => {
  const noscenes = [
    { type: 'part', title: 'P', showTitle: true },
    { type: 'chapter', title: 'C', showTitle: true },
  ];
  for (const tocDepth of ['chapters', 'scenes']) {
    assert.deepStrictEqual(titles(compTocEntries(noscenes, { tocDepth })), ['P', 'C']);
  }
});
