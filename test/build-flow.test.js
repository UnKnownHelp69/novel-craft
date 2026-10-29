/* Coverage for buildFlow() and chapterHeadingText() — the parameterized
 * compilation-flow builder and chapter heading formatter.
 *
 * buildFlow(items, settings, chapters, findSceneFn) takes the compilation
 * order, settings, chapter list, and a scene-lookup function and returns the
 * flat flow array that every export format consumes. chapterHeadingText()
 * formats chapter headings according to the numbering mode in settings.
 */
import test from 'node:test';
import assert from 'node:assert';
import { chapterHeadingText, buildFlow, compTocEntries } from '../src/js/lib/compile-flow.js';

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
  for (const mode of ['arabic', 'plain', 'none']) {
    const result = chapterHeadingText({ title: '' }, 2, { numberChapters: mode });
    assert.ok(result.length > 0, `mode=${mode}: should produce a non-empty heading`);
    // The fallback title is "Chapter 3" (ci=2 -> ci+1=3).
    if (mode === 'none') assert.strictEqual(result, 'Chapter 3');
    if (mode === 'arabic') assert.strictEqual(result, 'Chapter 3');
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

/* ============================================================
 * Scene item titles — live vs. explicit override (issue #38)
 * ============================================================ */

/* Compilation scene items no longer copy the scene title when created; `title` is set
   only when the user renames the item in the compilation. buildFlow() must then track
   the live scene title, including renames made after the item was created. */
test('a scene item without its own title uses the live scene title, and follows renames', () => {
  const chapters = [{ id: 'c', title: 'Chapter 1', scenes: [{ id: 'x', title: 'Scene 2', content: '' }] }];
  const find = id => { const s = chapters[0].scenes.find(v => v.id === id); return s && { chapter: chapters[0], scene: s }; };
  const items = [{ type: 'scene', sceneId: 'x' }];

  const before = buildFlow(items, BASE_SETTINGS, chapters, find).find(f => f.type === 'scene');
  assert.strictEqual(before.title, 'Scene 2');

  chapters[0].scenes[0].title = 'The Duel';   // renamed in the tree after the item existed
  const flow = buildFlow(items, BASE_SETTINGS, chapters, find);
  assert.strictEqual(flow.find(f => f.type === 'scene').title, 'The Duel');
  assert.deepStrictEqual(
    compTocEntries(flow, { ...BASE_SETTINGS, tocDepth: 'scenes' }).filter(f => f.type === 'scene').map(f => f.title),
    ['The Duel'], 'the TOC entry follows the rename too');
});

test('an explicit compilation title overrides the scene title and survives scene renames', () => {
  const chapters = [{ id: 'c', title: 'Chapter 1', scenes: [{ id: 'x', title: 'Scene 2', content: '' }] }];
  const find = id => { const s = chapters[0].scenes.find(v => v.id === id); return s && { chapter: chapters[0], scene: s }; };
  const items = [{ type: 'scene', sceneId: 'x', title: 'Прелюдия' }];
  chapters[0].scenes[0].title = 'The Duel';
  assert.strictEqual(buildFlow(items, BASE_SETTINGS, chapters, find).find(f => f.type === 'scene').title, 'Прелюдия');
});

/* ============================================================
 * Export language in chapter headings (issue #82)
 * ============================================================ */

test('"arabic" numbering says "Глава N" for a Russian export', () => {
  const s = { numberChapters: 'arabic', language: 'ru' };
  assert.strictEqual(chapterHeadingText({ title: 'Буря' }, 0, s), 'Глава 1: Буря');
  assert.strictEqual(chapterHeadingText({ title: 'The Storm' }, 2, s), 'Глава 3: The Storm');
});

test('"arabic" numbering keeps "Chapter N" for English, unset and unlabelled languages', () => {
  for (const language of ['en', undefined, null, 'de']) {
    const s = { numberChapters: 'arabic', language };
    assert.strictEqual(chapterHeadingText({ title: 'Буря' }, 0, s), 'Chapter 1: Буря', String(language));
  }
});

test('a "Глава N" title counts as a default title, like "Chapter N"', () => {
  const ru = { numberChapters: 'arabic', language: 'ru' };
  // Not "Глава 1: Глава 1".
  assert.strictEqual(chapterHeadingText({ title: 'Глава 1' }, 0, ru), 'Глава 1');
  assert.strictEqual(chapterHeadingText({ title: '  глава 7 ' }, 6, ru), 'Глава 7');
  assert.strictEqual(chapterHeadingText({ title: 'ГЛАВА 2' }, 1, ru), 'Глава 2');
  // The widened check holds whatever the export language is.
  assert.strictEqual(chapterHeadingText({ title: 'Глава 4' }, 3, { numberChapters: 'arabic', language: 'en' }), 'Chapter 4');
  assert.strictEqual(chapterHeadingText({ title: 'Chapter 4' }, 3, ru), 'Глава 4');
  // A title that merely starts with the word is a real title.
  assert.strictEqual(chapterHeadingText({ title: 'Глава о ветре' }, 0, ru), 'Глава 1: Глава о ветре');
});

test('an untitled chapter falls back to the localized "Глава N" in every mode', () => {
  const at = mode => chapterHeadingText({ title: '' }, 2, { numberChapters: mode, language: 'ru' });
  assert.strictEqual(at('arabic'), 'Глава 3');
  assert.strictEqual(at('plain'), '3. Глава 3');
  assert.strictEqual(at('none'), 'Глава 3');
});

test('the removed "word" mode no longer produces number words', () => {
  // Saved presets are migrated to "arabic" (test/migrate-novel.test.js); nothing renders "Chapter One".
  const out = chapterHeadingText({ title: 'Dawn' }, 0, { numberChapters: 'word' });
  assert.ok(!/One/.test(out), out);
});

test('buildFlow carries the export language into its chapter entries (and so the TOC)', () => {
  const flow = buildFlow(ITEMS, { ...BASE_SETTINGS, numberChapters: 'arabic', language: 'ru' }, CHAPTERS, findScene);
  const chapters = flow.filter(f => f.type === 'chapter').map(f => f.title);
  assert.ok(chapters.length > 0);
  for (const t of chapters) assert.match(t, /^Глава \d+/);
  assert.deepStrictEqual(compTocEntries(flow, { tocDepth: 'chapters' }).filter(f => f.type === 'chapter').map(f => f.title), chapters);
});
