/* Coverage for migrateNovel() — the function every .novel file passes through on open.
 *
 * It runs silently on load, including on files that are already current, so anything it
 * gets wrong shows up as corrupted or lost work in a real user's saved novel rather than
 * as a visible error. The cases below pin the guarantees a reader of the function would
 * assume but that nothing else enforces:
 *
 *   1. Legacy shapes are upgraded, and the legacy fields are actually removed afterwards.
 *   2. Garbage in (undefined, {}, wrong types) still yields a fully-valid novel.
 *   3. Migrating twice is a no-op — the highest-value property, since already-migrated
 *      files go through this on every single open.
 *   4. Derived values (order, wordCount) are recomputed, never trusted from the file.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * function is lifted out of the file and run here in isolation — the same technique as
 * test/pdf-cyrillic.test.js. migrateNovel's dependencies are scattered across the file
 * instead of contiguous, so there are four marker pairs rather than one, and this test
 * concatenates the slices; declaration order in app.js does not matter.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

/* Node stand-ins for three globals migrateNovel reaches for that are deliberately left
   outside the markers. countWords/stripHtml are the production helpers' behaviour minus
   the DOM (the real stripHtml uses document.createElement, which node --test has no
   version of); they are scaffolding for the fixtures here, not under test themselves.
   toast must exist because the legacy-chapter path schedules one 400ms later — without a
   stand-in that timer throws ReferenceError long after the assertions have finished. */
const testCountWords = t => {
  const m = (t || '').trim().match(/[\p{L}\p{N}'’-]+/gu);
  return m ? m.length : 0;
};
const testStripHtml = html => String(html || '').replace(/<[^>]*>/g, ' ');
const testToast = () => {};

function slice(name) {
  const startMark = `/* --- migration-core:${name}:start ---`;
  const endMark = `/* --- migration-core:${name}:end --- */`;
  const start = APP.indexOf(startMark);
  const end = APP.indexOf(endMark);
  assert.ok(start !== -1 && end > start,
    `migration-core:${name} markers missing from src/app.js — the code moved, update this test`);
  return APP.slice(start, end);
}

function loadMigrateNovel() {
  // uuid first: the other slices call it at definition time is not required, but keeping
  // dependency order makes the synthetic script readable if it ever needs debugging.
  const src = ['uuid', 'base', 'note-types', 'migrate'].map(slice).join('\n');
  // A new Function body is sloppy-mode by default; src/app.js runs under 'use strict', so
  // opt in explicitly rather than testing subtly different semantics from production.
  return new Function('countWords', 'stripHtml', 'toast',
    `'use strict';\n${src}\nreturn migrateNovel;`)(testCountWords, testStripHtml, testToast);
}

const migrateNovel = loadMigrateNovel();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = v => typeof v === 'string' && UUID_RE.test(v);

test('a pre-scenes chapter is wrapped into one scene and its legacy fields are removed', () => {
  // Files written before scenes existed kept the prose directly on the chapter. Leaving
  // those fields behind would give every later save two copies of the text that drift
  // apart — the `delete c.content` line is what prevents that, so assert on its effect.
  const n = migrateNovel({
    title: 'Legacy',
    chapters: [{
      id: 'chap-1', title: 'Old Chapter',
      content: '<p>Жили-были старик со старухой.</p>',
      markdownContent: 'Жили-были старик со старухой.',
      notes: [{ content: 'проверить', typeId: 'idea' }]
    }]
  });

  const c = n.chapters[0];
  assert.strictEqual(c.scenes.length, 1, 'legacy content should become exactly one scene');

  const s = c.scenes[0];
  assert.strictEqual(s.title, 'Scene 1');
  assert.strictEqual(s.content, '<p>Жили-были старик со старухой.</p>', 'prose was not carried over');
  assert.strictEqual(s.markdownContent, 'Жили-были старик со старухой.');
  assert.strictEqual(s.notes.length, 1, 'chapter notes were not carried over to the scene');
  assert.strictEqual(s.notes[0].content, 'проверить');

  // The point of the test: moved, not copied.
  assert.ok(!('content' in c), 'chapter.content survived the migration (duplicated text)');
  assert.ok(!('markdownContent' in c), 'chapter.markdownContent survived the migration');
  assert.ok(!('notes' in c), 'chapter.notes survived the migration (duplicated notes)');
});

test('an empty object or undefined still produces a complete, valid novel', () => {
  // setCurrentNovel() feeds this whatever JSON.parse returned; a truncated or empty file
  // must land on the start-menu-equivalent blank novel rather than a half-built object
  // that refreshUI() then trips over.
  for (const input of [undefined, {}]) {
    const label = input === undefined ? 'undefined' : '{}';
    const n = migrateNovel(input);

    assert.strictEqual(n.version, '1.0', `${label}: version`);
    assert.strictEqual(n.title, 'Untitled Novel', `${label}: title`);
    for (const key of ['chapters', 'characters', 'locations', 'races']) {
      assert.ok(Array.isArray(n[key]), `${label}: ${key} must be an array`);
    }
    assert.strictEqual(n.chapters.length, 1, `${label}: expected one default chapter`);
    assert.strictEqual(n.chapters[0].scenes.length, 1, `${label}: default chapter needs a scene`);

    const st = n.settings;
    assert.strictEqual(typeof st.fontSize, 'number', `${label}: settings.fontSize`);
    assert.strictEqual(typeof st.defaultFont, 'string', `${label}: settings.defaultFont`);
    assert.strictEqual(typeof st.wordGoal, 'number', `${label}: settings.wordGoal`);
    assert.deepStrictEqual(st.customNoteTypes, [], `${label}: settings.customNoteTypes`);
    assert.deepStrictEqual(st.noteTypeColors, {}, `${label}: settings.noteTypeColors`);
    assert.deepStrictEqual(st.compilationPresets, [], `${label}: settings.compilationPresets`);

    assert.strictEqual(st.worldMap.backgroundImage, '', `${label}: worldMap.backgroundImage`);
    assert.strictEqual(st.worldMap.imageW, 0, `${label}: worldMap.imageW`);
    assert.strictEqual(st.worldMap.imageH, 0, `${label}: worldMap.imageH`);
    assert.deepStrictEqual(st.worldMap.locations, {}, `${label}: worldMap.locations`);
    assert.deepStrictEqual(st.worldMap.routes, [], `${label}: worldMap.routes`);
    assert.deepStrictEqual(st.worldMap.layers, [], `${label}: worldMap.layers`);
    assert.deepStrictEqual(st.worldMap.baseLayers,
      { background: true, locations: true, routes: true, labels: true },
      `${label}: worldMap.baseLayers`);
  }
});

test('a novel with no chapters, or an empty chapters array, gets a default chapter', () => {
  // The editor has nowhere to put the caret with zero chapters, so this is the one place
  // migrateNovel invents content rather than just normalizing it.
  for (const chapters of [undefined, [], 'not an array']) {
    const n = migrateNovel({ title: 'Empty', chapters });
    assert.strictEqual(n.chapters.length, 1, `chapters=${JSON.stringify(chapters)}`);
    assert.ok(isId(n.chapters[0].id));
    assert.strictEqual(n.chapters[0].scenes.length, 1);
    assert.strictEqual(n.chapters[0].order, 0);
  }
});

test('migrating an already-migrated novel changes nothing (runs on every open)', () => {
  // This is the case that actually happens thousands of times: a current file is opened
  // and migrated again. A rule that re-assigns ids, re-wraps scenes or appends defaults
  // would quietly rewrite the user's file on the next save.
  const once = migrateNovel({
    title: 'Роман',
    chapters: [{
      title: 'Глава 1',
      scenes: [
        { title: 'Сцена 1', content: '<p>Текст</p>', notes: [{ content: 'n', typeId: 'Исправить' }] },
        { title: 'Сцена 2', content: '<p>Ещё текст</p>' }
      ]
    }],
    characters: [{ name: 'Иван', relationships: 'старый друг Петра' }],
    locations: [{ name: 'Москва' }],
    races: [{ name: 'Люди' }],
    settings: { worldMap: { routes: [{ from: 'a', to: 'b' }], layers: [{ name: 'Ink' }] } }
  });

  const snapshot = structuredClone(once);
  // Migrate a *copy*: migrateNovel mutates nested objects in place, so re-running it on
  // `once` itself would compare an object against itself and pass no matter what.
  const twice = migrateNovel(structuredClone(once));

  assert.deepStrictEqual(twice, snapshot, 'second migration changed the novel');

  // Spelled out, so a failure says which invariant broke rather than dumping a big diff.
  assert.strictEqual(twice.chapters.length, snapshot.chapters.length, 'chapters were duplicated');
  assert.strictEqual(twice.chapters[0].scenes.length, 2, 'scenes were duplicated');
  assert.strictEqual(twice.chapters[0].id, snapshot.chapters[0].id, 'chapter id was reassigned');
  assert.deepStrictEqual(
    twice.chapters[0].scenes.map(s => s.id),
    snapshot.chapters[0].scenes.map(s => s.id),
    'scene ids were reassigned');
  assert.strictEqual(twice.characters[0].id, snapshot.characters[0].id, 'character id was reassigned');
  assert.strictEqual(twice.chapters[0].scenes[0].notes[0].id, snapshot.chapters[0].scenes[0].notes[0].id,
    'note id was reassigned');
  assert.strictEqual(twice.settings.worldMap.routes[0].id, snapshot.settings.worldMap.routes[0].id,
    'world-map route id was reassigned');
});

test('every id-bearing entity missing an id is given one', () => {
  // Ids are how the UI addresses everything; an entity without one is unselectable and
  // unsaveable. Hand-edited files and older exports both produce these.
  const n = migrateNovel({
    chapters: [{
      title: 'C',
      scenes: [{ title: 'S', notes: [{ content: 'note' }] }]
    }],
    characters: [{ name: 'A', relationships: [{ targetId: 'x' }] }],
    locations: [{ name: 'L' }],
    races: [{ name: 'R' }],
    settings: {
      worldMap: {
        layers: [{ name: 'Sketch' }],
        routes: [{ from: 'L1', to: 'L2' }]
      }
    }
  });

  const chapter = n.chapters[0];
  const scene = chapter.scenes[0];
  const checks = [
    ['chapter', chapter.id],
    ['scene', scene.id],
    ['note', scene.notes[0].id],
    ['character', n.characters[0].id],
    ['relationship', n.characters[0].relationships[0].id],
    ['location', n.locations[0].id],
    ['race', n.races[0].id],
    ['world-map layer', n.settings.worldMap.layers[0].id],
    ['world-map route', n.settings.worldMap.routes[0].id]
  ];
  for (const [what, id] of checks) {
    assert.ok(isId(id), `${what} did not get a uuid (got ${JSON.stringify(id)})`);
  }
  assert.strictEqual(new Set(checks.map(c => c[1])).size, checks.length, 'ids are not unique');
});

test('legacy free-text character.relationships is preserved as relationshipNotes', () => {
  // relationships used to be a prose field before the relationship graph turned it into
  // an array. Overwriting it with [] without rescuing the text would delete whatever the
  // author had written about that character.
  const n = migrateNovel({
    characters: [{ name: 'Пётр', relationships: 'брат Ивана, враг Анны' }]
  });

  const ch = n.characters[0];
  assert.strictEqual(ch.relationshipNotes, 'брат Ивана, враг Анны', 'free-text relationships were lost');
  assert.deepStrictEqual(ch.relationships, [], 'relationships should become an empty array');
  assert.strictEqual(ch.graphPosition, null);
  assert.strictEqual(ch.hiddenInGraph, false);
});

test('a note stored with a Russian type name is remapped to the English type id', () => {
  // Early builds wrote the localized display name into typeId. getNoteTypes() only knows
  // the English ids, so an unmapped note falls back to "idea" and loses its category.
  const RU_TO_EN = {
    'Исправить': 'fix',
    'Проверить факт': 'factcheck',
    'Развить мысль': 'expand',
    'Перенести': 'move',
    'Идея': 'idea'
  };
  const n = migrateNovel({
    chapters: [{
      scenes: [{
        notes: Object.keys(RU_TO_EN).map(ru => ({ content: ru, typeId: ru }))
          .concat([{ content: 'already english', typeId: 'factcheck' }, { content: 'no type' }])
      }]
    }]
  });

  const notes = n.chapters[0].scenes[0].notes;
  for (const [ru, en] of Object.entries(RU_TO_EN)) {
    const note = notes.find(x => x.content === ru);
    assert.strictEqual(note.typeId, en, `${ru} was not remapped to ${en}`);
  }
  assert.strictEqual(notes.find(x => x.content === 'already english').typeId, 'factcheck',
    'an English type id must survive untouched');
  assert.strictEqual(notes.find(x => x.content === 'no type').typeId, 'idea',
    'a note with no type should fall back to idea');
});

test('a missing or partial settings.worldMap is filled in', () => {
  // The map view indexes into locations/routes/layers without guarding, so a file saved
  // before the map existed has to come out of migration with all of them present.
  const missing = migrateNovel({ settings: { fontSize: 20 } }).settings.worldMap;
  assert.strictEqual(missing.backgroundImage, '');
  assert.strictEqual(missing.imageW, 0);
  assert.strictEqual(missing.imageH, 0);
  assert.deepStrictEqual(missing.locations, {});
  assert.deepStrictEqual(missing.routes, []);
  assert.deepStrictEqual(missing.layers, []);
  assert.deepStrictEqual(missing.baseLayers,
    { background: true, locations: true, routes: true, labels: true });

  // A partial map keeps what it has and gains the rest — including a base layer the user
  // deliberately switched off, which must not be reset to true.
  const partial = migrateNovel({
    settings: {
      worldMap: {
        backgroundImage: 'data:image/png;base64,AAA',
        imageW: 800, imageH: 600,
        locations: { 'loc-1': { x: 0.5, y: 0.5, visible: true } },
        baseLayers: { routes: false }
      }
    }
  }).settings.worldMap;

  assert.strictEqual(partial.backgroundImage, 'data:image/png;base64,AAA');
  assert.strictEqual(partial.imageW, 800);
  assert.deepStrictEqual(partial.locations, { 'loc-1': { x: 0.5, y: 0.5, visible: true } });
  assert.deepStrictEqual(partial.routes, []);
  assert.deepStrictEqual(partial.layers, []);
  assert.deepStrictEqual(partial.baseLayers,
    { background: true, locations: true, routes: false, labels: true },
    'an explicitly disabled base layer was re-enabled');

  // A worldMap object that exists but omits the image fields: settings-level defaults do
  // not help here, because d.settings.worldMap replaces the default map wholesale. Only
  // the blankWorldMap() spread inside migrateNovel fills these back in.
  const noImage = migrateNovel({
    settings: { worldMap: { locations: { 'loc-1': { x: 0.1, y: 0.2, visible: true } } } }
  }).settings.worldMap;
  assert.strictEqual(noImage.backgroundImage, '', 'worldMap.backgroundImage left undefined');
  assert.strictEqual(noImage.imageW, 0, 'worldMap.imageW left undefined');
  assert.strictEqual(noImage.imageH, 0, 'worldMap.imageH left undefined');
});

test('world-map layers and routes are given their defaults', () => {
  const wm = migrateNovel({
    settings: {
      worldMap: {
        layers: [{ name: 'Ink' }, { name: 'Hidden', visible: false, opacity: 0.4 }],
        routes: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd', color: '#ff0000', bidirectional: false }]
      }
    }
  }).settings.worldMap;

  assert.strictEqual(wm.layers[0].visible, true);
  assert.strictEqual(wm.layers[0].opacity, 1);
  assert.deepStrictEqual(wm.layers[0].drawings, []);
  assert.strictEqual(wm.layers[1].visible, false, 'a hidden layer must stay hidden');
  assert.strictEqual(wm.layers[1].opacity, 0.4);

  assert.deepStrictEqual(wm.routes[0].characterIds, []);
  assert.strictEqual(wm.routes[0].color, '#c9a96e');
  assert.strictEqual(wm.routes[0].bidirectional, true);
  assert.strictEqual(wm.routes[1].color, '#ff0000', 'a custom route colour must survive');
  assert.strictEqual(wm.routes[1].bidirectional, false);
});

test('settings.customNoteTypes is coerced to an array and its entries get ids', () => {
  // getNoteTypes() spreads this straight into the note-type list; a non-array there
  // throws on every note render.
  for (const bad of [undefined, null, 'nope', 42, { id: 'x' }]) {
    const st = migrateNovel({ settings: { customNoteTypes: bad } }).settings;
    assert.deepStrictEqual(st.customNoteTypes, [], `customNoteTypes=${JSON.stringify(bad)}`);
  }

  const types = migrateNovel({
    settings: {
      customNoteTypes: [
        { name: 'Диалог', color: '#abcdef', icon: '💬' },
        { id: 'keep-me', name: 'Ритм', color: '#123456', icon: '🎵' }
      ]
    }
  }).settings.customNoteTypes;

  assert.ok(isId(types[0].id), 'a custom note type without an id did not get one');
  assert.strictEqual(types[0].name, 'Диалог', 'the rest of the type was altered');
  assert.strictEqual(types[1].id, 'keep-me', 'an existing custom-type id was overwritten');
});

test('chapter and scene order are reassigned from array position, not read from the file', () => {
  // order is what the tree and the compiler sort by. Stale values — left behind by a
  // drag-and-drop reorder that saved the array but not the indices — would render the
  // novel in the wrong sequence, so the array is the single source of truth.
  const n = migrateNovel({
    chapters: [
      { title: 'First', order: 99, scenes: [{ title: 'a', order: 7 }, { title: 'b', order: 7 }] },
      { title: 'Second', order: -3, scenes: [{ title: 'c', order: 42 }] },
      { title: 'Third', scenes: [{ title: 'd' }] }
    ]
  });

  assert.deepStrictEqual(n.chapters.map(c => c.order), [0, 1, 2], 'chapter order not reindexed');
  assert.deepStrictEqual(n.chapters.map(c => c.title), ['First', 'Second', 'Third'],
    'reindexing must not reorder the array itself');
  assert.deepStrictEqual(n.chapters[0].scenes.map(s => s.order), [0, 1], 'scene order not reindexed');
  assert.deepStrictEqual(n.chapters[1].scenes.map(s => s.order), [0]);
});

test('chapter.wordCount is recomputed from its scenes, not trusted from the file', () => {
  // The counters panel and the word-goal bar read chapter.wordCount directly. A value
  // saved before the last edit — or hand-edited — would make the progress bar lie.
  const n = migrateNovel({
    chapters: [
      { title: 'Stale', wordCount: 9999, scenes: [{ wordCount: 10 }, { wordCount: 5 }] },
      { title: 'Missing', scenes: [{ wordCount: 3 }, {}] },
      { title: 'Empty', scenes: [{}] }
    ]
  });

  assert.strictEqual(n.chapters[0].wordCount, 15, 'a stale chapter wordCount was trusted');
  assert.strictEqual(n.chapters[1].wordCount, 3, 'a scene with no wordCount should count as 0');
  assert.strictEqual(n.chapters[2].wordCount, 0);
});

test('a scene with no wordCount has it derived from its content', () => {
  const n = migrateNovel({
    chapters: [{ scenes: [{ content: '<p>Пять слов в этой сцене</p>' }] }]
  });
  // Counted with the Node stand-in helpers, which mirror the production regex.
  assert.strictEqual(n.chapters[0].scenes[0].wordCount, 5);
  assert.strictEqual(n.chapters[0].wordCount, 5);
});

test('scene fields absent from an older file are defaulted without clobbering real values', () => {
  const n = migrateNovel({
    chapters: [{
      scenes: [
        {},
        { title: 'Set', povCharacter: 'char-1', location: 'loc-1', timeOfDay: 'night', status: 'done' }
      ]
    }]
  });
  const [bare, set] = n.chapters[0].scenes;

  assert.strictEqual(bare.title, 'Scene 1');
  assert.strictEqual(bare.content, '');
  assert.strictEqual(bare.markdownContent, '');
  assert.strictEqual(bare.povCharacter, null);
  assert.strictEqual(bare.location, null);
  assert.strictEqual(bare.timeOfDay, 'unknown');
  assert.strictEqual(bare.status, 'draft');
  assert.deepStrictEqual(bare.notes, []);
  assert.ok(bare.createdAt && bare.modifiedAt, 'timestamps should be stamped');

  assert.strictEqual(set.povCharacter, 'char-1');
  assert.strictEqual(set.location, 'loc-1');
  assert.strictEqual(set.timeOfDay, 'night');
  assert.strictEqual(set.status, 'done');
});
