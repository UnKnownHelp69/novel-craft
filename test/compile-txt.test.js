/* Coverage for compileTXT() — the plain-text Compile export.
 *
 * Unlike the other export builders, compileTXT() reads the compilation and the open novel
 * from app state, and its scene text goes through stripHtml(), which needs a real DOM. So
 * it is lifted out of src/js/compile-export.js together with compFlow() and run with
 * stand-ins for those passed in as parameters (see test/helpers/lift.js); the pure helpers
 * it calls are the real ones.
 */
import test from 'node:test';
import assert from 'node:assert';
import { lift, liftFunction, compile as compileFn } from './helpers/lift.js';
import { buildFlow, compTocEntries, sepText, tocLabel } from '../src/js/lib/compile-flow.js';
import { resolveLanguage } from '../src/js/lib/language.js';

/* Only text and block boundaries matter to compileTXT, so a regex is enough here. */
const testStripHtml = html => String(html || '').replace(/<\/p>/g, '\n').replace(/<[^>]*>/g, '');

const compileTXT = compileFn(
  ['comp', 'novel', 'findScene', 'stripHtml', 'buildFlow', 'compTocEntries', 'sepText', 'tocLabel', 'resolveLanguage'],
  liftFunction('compile-export.js', 'compFlow') + lift('compile-export.js', 'compile-txt'),
  'compileTXT()');
const run = (comp, novel, findScene, stripHtml) =>
  compileTXT(comp, novel, findScene, stripHtml, buildFlow, compTocEntries, sepText, tocLabel, resolveLanguage);

/* A two-chapter novel and the matching compile list (one item per scene). */
function fixture(language, chapterTitles) {
  const chapters = chapterTitles.map((title, i) => ({
    id: 'c' + i, title, scenes: [{ id: 's' + i, title: 'S' + i, content: `<p>${language === 'ru' ? 'Текст сцены' : 'Scene text'} ${i}.</p>` }],
  }));
  const novel = { title: language === 'ru' ? 'Роман' : 'Novel', settings: { language }, chapters };
  const items = chapters.map(c => ({ type: 'scene', sceneId: c.scenes[0].id }));
  const findScene = id => {
    for (const chapter of chapters) for (const scene of chapter.scenes) if (scene.id === id) return { chapter, scene };
    return null;
  };
  return { novel, items, findScene };
}
const SETTINGS = {
  titlePage: false, titleText: '', subtitle: '', author: '', dateText: '',
  toc: true, tocDepth: 'chapters', tocPosition: 'afterTitle',
  sceneTitles: 'chapters', includeParts: true, numberChapters: 'arabic',
  sceneSeparator: '***', sceneSepCustom: '',
};
const compile = (language, over = {}, titles = ['Буря', 'Тишина']) => {
  const { novel, items, findScene } = fixture(language, titles);
  return run({ items, settings: { ...SETTINGS, ...over } }, novel, findScene, testStripHtml);
};

/* ---------- empty table of contents (issue #83) ---------- */

test('no TOC heading at all when scene titles are off and the TOC has no entries', () => {
  for (const language of ['en', 'ru']) {
    const txt = compile(language, { sceneTitles: 'no' });
    assert.ok(!/CONTENTS|СОДЕРЖАНИЕ/.test(txt), `${language}: ${JSON.stringify(txt)}`);
    assert.strictEqual(txt, compile(language, { sceneTitles: 'no', toc: false }),
      `${language}: an empty TOC still changed the output`);
  }
});

test('the TOC heading and entries still appear when there are chapters to list', () => {
  const ru = compile('ru').split('\n');
  assert.strictEqual(ru[0], 'СОДЕРЖАНИЕ');
  assert.deepStrictEqual(ru.slice(2, 4), ['Глава 1: Буря', 'Глава 2: Тишина']);
  assert.strictEqual(compile('en', {}, ['Storm', 'Calm']).split('\n')[0], 'CONTENTS');
});

/* ---------- chapter headings follow the export language (issue #82) ---------- */

test('chapter headings in the body say "Глава N" for a Russian novel', () => {
  const txt = compile('ru', { toc: false });
  assert.ok(txt.includes('ГЛАВА 1: БУРЯ') && txt.includes('ГЛАВА 2: ТИШИНА'), txt);
  assert.ok(!/CHAPTER/.test(txt), txt);
});

test('default "Глава N" titles are not repeated after the number', () => {
  const txt = compile('ru', { toc: false }, ['Глава 1', 'Глава 2']);
  assert.ok(txt.includes('ГЛАВА 1\n') && !txt.includes('ГЛАВА 1: ГЛАВА 1'), txt);
});

test('an explicit English setting keeps "Chapter N" on Russian text', () => {
  const txt = compile('en', { toc: false });
  assert.ok(txt.includes('CHAPTER 1: БУРЯ'), txt);
});
