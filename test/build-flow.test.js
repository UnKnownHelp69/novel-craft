/* Coverage for buildFlow() and chapterHeadingText() — the parameterized
 * compilation-flow builder and chapter heading formatter.
 *
 * buildFlow(items, settings, chapters, findSceneFn) takes the compilation
 * order, settings, chapter list, and a scene-lookup function and returns the
 * flat flow array that every export format consumes. chapterHeadingText()
 * formats chapter headings according to the numbering mode in settings.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md),
 * so the functions are lifted out between marker comments and run here in
 * isolation — the same technique as test/comp-toc.test.js,
 * test/pdf-cyrillic.test.js, test/migrate-novel.test.js,
 * test/zip-writer.test.js and test/docx-strings.test.js.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

function loadBuildFlow() {
  // numWord + ONES/TENS are dependencies of chapterHeadingText (inside the
  // build-flow marker block). They sit outside the markers, so we extract
  // them by searching for the known constant declarations.
  const onesIdx = APP.indexOf("const ONES = ['',");
  const numWordEnd = APP.indexOf('\n', APP.indexOf('function numWord(', onesIdx)) + 1;
  assert.ok(onesIdx !== -1 && numWordEnd > onesIdx,
    'ONES/TENS/numWord not found in src/app.js — the code moved, update this test');
  const numWordSrc = APP.slice(onesIdx, numWordEnd);

  const buildFlowSrc = sliceMarker('build-flow');
  const compTocSrc = sliceMarker('comp-toc');

  const src = numWordSrc + '\n' + buildFlowSrc + '\n' + compTocSrc;
  return new Function(`'use strict';\n${src}\nreturn { chapterHeadingText, buildFlow, compTocEntries };`)();
}

const { chapterHeadingText, buildFlow, compTocEntries } = loadBuildFlow();

/* ============================================================
 * FIXTURE DATA
 *
 * A realistic novel structure with 2 parts, 3 chapters, and
 * several scenes — including Cyrillic titles.
 * ============================================================ */

const CHAPTERS = [
  {
    id: 'ch1', title: 'Chapter 1', order: 0,
    scenes: [
      { id: 's1', title: 'The Beginning', content: '<p>Once upon a time</p>', wordCount: 4 },
      { id: 's2', title: 'Продолжение', content: '<p>Кирилл шёл домой</p>', wordCount: 3 },
    ]
  },
  {
    id: 'ch2', title: 'Глава Два', order: 1,
    scenes: [
      { id: 's3', title: 'Scene Three', content: '<p>More text</p>', wordCount: 2 },
    ]
  },
  {
    id: 'ch3', title: 'The Final Chapter', order: 2,
    scenes: [
      { id: 's4', title: 'Развязка', content: '<p>Конец</p>', wordCount: 1 },
      { id: 's5', title: 'Epilogue', content: '<p>The end</p>', wordCount: 2 },
    ]
  },
];

// A findScene implementation that mirrors the real one but uses our fixture data.
function findScene(id) {
  for (const c of CHAPTERS) {
    const s = (c.scenes || []).find(x => x.id === id);
    if (s) return { chapter: c, scene: s };
  }
  return null;
}

// Compilation items: 2 parts, 3 chapters' scenes, a break in the middle.
const ITEMS = [
  { type: 'part', title: 'Часть Первая' },
  { type: 'scene', sceneId: 's1', title: 'The Beginning' },
  { type: 'scene', sceneId: 's2', title: 'Продолжение' },
  { type: 'part', title: 'Part Two' },
  { type: 'scene', sceneId: 's3', title: 'Scene Three' },
  { type: 'break' },
  { type: 'scene', sceneId: 's4', title: 'Развязка' },
  { type: 'scene', sceneId: 's5', title: 'Epilogue' },
];

const BASE_SETTINGS = {
  includeParts: true,
  sceneTitles: 'yes',
  numberChapters: 'none',
  tocDepth: 'chapters',
};

const types = flow => flow.map(f => f.type);
const titles = flow => flow.map(f => f.title);

/* ============================================================
 * buildFlow() — ordering and structure
 * ============================================================ */

test('flow entries come out in the correct interleaved order', () => {
  const flow = buildFlow(ITEMS, BASE_SETTINGS, CHAPTERS, findScene);
  assert.deepStrictEqual(types(flow), [
    'part',     // Часть Первая
    'chapter',  // Chapter 1 (from s1, first scene of ch1)
    'scene',    // s1 — The Beginning
    'scene',    // s2 — Продолжение
    'part',     // Part Two
    'chapter',  // Глава Два (from s3, first scene of ch2)
    'scene',    // s3 — Scene Three
    'break',    // section break
    'chapter',  // The Final Chapter (from s4, first scene of ch3)
    'scene',    // s4 — Развязка
    'scene',    // s5 — Epilogue
  ]);
});

test('chapter headings appear only once per chapter, not per scene', () => {
  const flow = buildFlow(ITEMS, BASE_SETTINGS, CHAPTERS, findScene);
  const chapterEntries = flow.filter(f => f.type === 'chapter');
  assert.strictEqual(chapterEntries.length, 3, 'should be exactly 3 chapter headings');
  // ch1 has 2 scenes, ch3 has 2 scenes — both should still produce only 1 heading each.
  const chTitles = chapterEntries.map(f => f.title);
  assert.ok(chTitles.includes('Chapter 1'));
  assert.ok(chTitles.includes('Глава Два'));
  assert.ok(chTitles.includes('The Final Chapter'));
});

test('Cyrillic part and scene titles pass through correctly', () => {
  const flow = buildFlow(ITEMS, BASE_SETTINGS, CHAPTERS, findScene);
  const t = titles(flow);
  assert.ok(t.includes('Часть Первая'), 'Cyrillic part title');
  assert.ok(t.includes('Продолжение'), 'Cyrillic scene title');
  assert.ok(t.includes('Развязка'), 'Cyrillic scene title (ch3)');
  assert.ok(t.includes('Глава Два'), 'Cyrillic chapter title');
});

/* ============================================================
 * Anchors
 * ============================================================ */

test('anchors are assigned sequentially to parts, chapters, and titled scenes', () => {
  const flow = buildFlow(ITEMS, BASE_SETTINGS, CHAPTERS, findScene);
  // With sceneTitles='yes', all parts, chapters, and scenes get anchors.
  const anchors = flow.filter(f => f.type !== 'break').map(f => f.anchor);
  // Parts, chapters, and scenes with showTitle all get h0, h1, h2...
  // Breaks have no anchor field.
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i] !== null) {
      assert.match(anchors[i], /^h\d+$/, `anchor at index ${i} should match h<N>`);
    }
  }
  // No duplicate anchors among the non-null ones.
  const nonNull = anchors.filter(a => a !== null);
  assert.strictEqual(nonNull.length, new Set(nonNull).size, 'anchors must be unique');
});

test('scenes get null anchors when sceneTitles is not "yes"', () => {
  const s = { ...BASE_SETTINGS, sceneTitles: 'no' };
  const flow = buildFlow(ITEMS, s, CHAPTERS, findScene);
  // With sceneTitles='no', no chapters or scenes get headings — only parts.
  const scenes = flow.filter(f => f.type === 'scene');
  for (const sc of scenes) {
    assert.strictEqual(sc.anchor, null, `scene "${sc.title}" should have null anchor`);
  }
  // No chapter entries should exist at all.
  assert.strictEqual(flow.filter(f => f.type === 'chapter').length, 0);
});

test('sceneTitles "no" suppresses chapter headings entirely', () => {
  const s = { ...BASE_SETTINGS, sceneTitles: 'no' };
  const flow = buildFlow(ITEMS, s, CHAPTERS, findScene);
  assert.strictEqual(flow.filter(f => f.type === 'chapter').length, 0);
  // But scenes still appear (just without titles/anchors).
  assert.strictEqual(flow.filter(f => f.type === 'scene').length, 5);
});

/* ============================================================
 * Parts: includeParts setting
 * ============================================================ */

test('parts are excluded when includeParts is false', () => {
  const s = { ...BASE_SETTINGS, includeParts: false };
  const flow = buildFlow(ITEMS, s, CHAPTERS, findScene);
  assert.strictEqual(flow.filter(f => f.type === 'part').length, 0);
  // Everything else still appears.
  assert.ok(flow.filter(f => f.type === 'chapter').length > 0);
  assert.ok(flow.filter(f => f.type === 'scene').length > 0);
});

/* ============================================================
 * Scene with missing sceneId is skipped
 * ============================================================ */

test('items with an unknown sceneId are silently skipped', () => {
  const items = [
    { type: 'scene', sceneId: 'nonexistent' },
    { type: 'scene', sceneId: 's1', title: 'The Beginning' },
  ];
  const flow = buildFlow(items, BASE_SETTINGS, CHAPTERS, findScene);
  assert.strictEqual(flow.length, 2); // chapter + scene (the nonexistent one was skipped)
  assert.strictEqual(flow[0].type, 'chapter');
  assert.strictEqual(flow[1].type, 'scene');
});

/* ============================================================
 * chapterHeadingText() — numbering modes
 * ============================================================ */

test('numberChapters "arabic" produces "Chapter N" with suffix', () => {
  const s = { numberChapters: 'arabic' };
  // A non-default title gets appended as ": <title>".
  assert.strictEqual(chapterHeadingText({ title: 'The Storm' }, 0, s), 'Chapter 1: The Storm');
  assert.strictEqual(chapterHeadingText({ title: 'Гроза' }, 2, s), 'Chapter 3: Гроза');
  // A default "Chapter N" title gets no suffix.
  assert.strictEqual(chapterHeadingText({ title: 'Chapter 5' }, 4, s), 'Chapter 5');
});

test('numberChapters "word" produces "Chapter One" etc.', () => {
  const s = { numberChapters: 'word' };
  assert.strictEqual(chapterHeadingText({ title: 'Dawn' }, 0, s), 'Chapter One: Dawn');
  assert.strictEqual(chapterHeadingText({ title: 'Noon' }, 11, s), 'Chapter Twelve: Noon');
  assert.strictEqual(chapterHeadingText({ title: 'Chapter 1' }, 0, s), 'Chapter One');
});

test('numberChapters "plain" produces "N. Title"', () => {
  const s = { numberChapters: 'plain' };
  assert.strictEqual(chapterHeadingText({ title: 'The End' }, 0, s), '1. The End');
  assert.strictEqual(chapterHeadingText({ title: 'Финал' }, 9, s), '10. Финал');
});

test('numberChapters default (none) returns the title as-is', () => {
  const s = { numberChapters: 'none' };
  assert.strictEqual(chapterHeadingText({ title: 'My Title' }, 0, s), 'My Title');
  assert.strictEqual(chapterHeadingText({ title: 'Глава' }, 3, s), 'Глава');
});

test('chapterHeadingText falls back to "Chapter N" when title is empty', () => {
  for (const mode of ['arabic', 'word', 'plain', 'none']) {
    const result = chapterHeadingText({ title: '' }, 2, { numberChapters: mode });
    assert.ok(result.length > 0, `mode=${mode}: should produce a non-empty heading`);
    // The fallback title is "Chapter 3" (ci=2 -> ci+1=3).
    if (mode === 'none') assert.strictEqual(result, 'Chapter 3');
    if (mode === 'arabic') assert.strictEqual(result, 'Chapter 3');
    if (mode === 'word') assert.strictEqual(result, 'Chapter Three');
    if (mode === 'plain') assert.strictEqual(result, '3. Chapter 3');
  }
});

/* ============================================================
 * Integration: buildFlow() -> compTocEntries()
 * ============================================================ */

test('buildFlow output feeds correctly into compTocEntries at depth "chapters"', () => {
  const flow = buildFlow(ITEMS, BASE_SETTINGS, CHAPTERS, findScene);
  const toc = compTocEntries(flow, { tocDepth: 'chapters' });
  // At depth "chapters", only parts and chapters appear.
  const tocTypes = toc.map(e => e.type);
  assert.ok(tocTypes.every(t => t === 'part' || t === 'chapter'),
    'TOC at chapters depth should only contain parts and chapters');
  assert.strictEqual(toc.filter(t => t.type === 'part').length, 2);
  assert.strictEqual(toc.filter(t => t.type === 'chapter').length, 3);
});

test('buildFlow output feeds correctly into compTocEntries at depth "scenes"', () => {
  const flow = buildFlow(ITEMS, BASE_SETTINGS, CHAPTERS, findScene);
  const toc = compTocEntries(flow, { tocDepth: 'scenes' });
  // At depth "scenes", parts + chapters + scenes with showTitle appear.
  // With sceneTitles='yes', all scenes have showTitle=true.
  assert.strictEqual(toc.filter(t => t.type === 'part').length, 2);
  assert.strictEqual(toc.filter(t => t.type === 'chapter').length, 3);
  assert.strictEqual(toc.filter(t => t.type === 'scene').length, 5);
  // Breaks never appear in the TOC.
  assert.strictEqual(toc.filter(t => t.type === 'break').length, 0);
});

test('scenes with showTitle=false are excluded from compTocEntries at scenes depth', () => {
  // sceneTitles not 'yes' means showTitle=false on scenes.
  const s = { ...BASE_SETTINGS, sceneTitles: 'headings' };
  const flow = buildFlow(ITEMS, s, CHAPTERS, findScene);
  // Scenes exist but with showTitle=false.
  const scenes = flow.filter(f => f.type === 'scene');
  assert.ok(scenes.length > 0);
  assert.ok(scenes.every(sc => sc.showTitle === false));
  // compTocEntries at scenes depth should exclude them.
  const toc = compTocEntries(flow, { tocDepth: 'scenes' });
  assert.strictEqual(toc.filter(t => t.type === 'scene').length, 0,
    'scenes with showTitle=false should not appear in TOC');
});

/* ============================================================
 * Empty / edge cases
 * ============================================================ */

test('empty items produce an empty flow', () => {
  assert.deepStrictEqual(buildFlow([], BASE_SETTINGS, CHAPTERS, findScene), []);
});

test('a flow with only breaks works', () => {
  const items = [{ type: 'break' }, { type: 'break' }];
  const flow = buildFlow(items, BASE_SETTINGS, CHAPTERS, findScene);
  assert.strictEqual(flow.length, 2);
  assert.ok(flow.every(f => f.type === 'break'));
});
