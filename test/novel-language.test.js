/* Coverage for detectLanguage() and resolveLanguage() — the language every export
 * declares (EPUB dc:language and xml:lang, HTML lang, DOCX w:lang).
 *
 * novel.settings.language is either an explicit choice or null, meaning "work it out from
 * the text". A wrong answer here is invisible in the app: it surfaces as an e-reader
 * hyphenating Russian with English rules, a screen reader using the wrong voice, or Word
 * spellchecking a whole manuscript as misspelt — so the rules are pinned below.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * helpers are lifted out between marker comments and run here in isolation — the same
 * technique as test/migrate-novel.test.js and the rest. They must not need anything else.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

function load() {
  const start = APP.indexOf('/* --- novel-language:start ---');
  const end = APP.indexOf('/* --- novel-language:end --- */');
  assert.ok(start !== -1 && end > start,
    'novel-language markers missing from src/app.js — the code moved, update this test');
  // A new Function body is sloppy-mode by default; src/app.js runs under 'use strict'.
  return new Function(`'use strict';\n${APP.slice(start, end)}\n` +
    'return { NOVEL_LANGUAGES, detectLanguage, resolveLanguage };')();
}

const { NOVEL_LANGUAGES, detectLanguage, resolveLanguage } = load();

/* A made-up novel in the real shape: chapters -> scenes -> HTML content. */
const novelOf = (title, scenes, language) => ({
  title,
  settings: language === undefined ? {} : { language },
  chapters: [{ title: 'ignored', scenes: scenes.map(content => ({ content })) }],
});

/* ---------- detectLanguage() ---------- */

test('mostly-Cyrillic text is detected as Russian', () => {
  assert.strictEqual(detectLanguage(novelOf('Роман', ['<p>Ветер поднимался над пустошью.</p>'])), 'ru');
});

test('mostly-Latin text is detected as English', () => {
  assert.strictEqual(detectLanguage(novelOf('A Novel', ['<p>The wind rose over the moor.</p>'])), 'en');
});

test('the majority script wins when a novel mixes both', () => {
  // Occasional foreign words inside otherwise single-language prose must not flip it.
  const ru = novelOf('Роман', ['<p>Он сказал «okay» и ушёл домой, не оглядываясь назад.</p>']);
  assert.strictEqual(detectLanguage(ru), 'ru');
  const en = novelOf('Novel', ['<p>She whispered “спасибо” and walked out into the rain.</p>']);
  assert.strictEqual(detectLanguage(en), 'en');
});

test('every scene of every chapter is counted, not just the first', () => {
  const n = {
    title: 'X',
    settings: {},
    chapters: [
      { scenes: [{ content: '<p>Short.</p>' }] },
      { scenes: [{ content: '' }, { content: '<p>Длинный текст второй главы, который решает всё.</p>' }] },
    ],
  };
  assert.strictEqual(detectLanguage(n), 'ru');
});

test('the title counts too', () => {
  assert.strictEqual(detectLanguage(novelOf('Война и мир', [''])), 'ru');
  assert.strictEqual(detectLanguage(novelOf('War and Peace', [''])), 'en');
});

test('markup and entities never count as Latin text', () => {
  // A Russian scene wrapped in plenty of tags, attributes and &nbsp; is still Russian.
  const html = '<p class="dialogue" style="text-indent:2em"><strong><em>Да</em></strong>&nbsp;&mdash;&nbsp;<span data-note="abcdefghijklmnop">нет</span></p>';
  assert.strictEqual(detectLanguage(novelOf('', [html])), 'ru');
});

test('a novel with no letters of either script has no signal: null', () => {
  assert.strictEqual(detectLanguage(novelOf('', [''])), null);
  assert.strictEqual(detectLanguage(novelOf('', ['<p>1984 — 2024 … !?</p>'])), null);
  assert.strictEqual(detectLanguage({ chapters: [] }), null);
  assert.strictEqual(detectLanguage({}), null);
  assert.strictEqual(detectLanguage(null), null);
});

test('a tie between the scripts goes to English', () => {
  assert.strictEqual(detectLanguage(novelOf('', ['ab аб'])), 'en');
});

test('detectLanguage ignores the explicit setting — it only reads the text', () => {
  assert.strictEqual(detectLanguage(novelOf('Роман', ['<p>Текст</p>'], 'en')), 'ru');
});

/* ---------- resolveLanguage() ---------- */

test('an explicit setting wins over whatever the text says', () => {
  assert.strictEqual(resolveLanguage(novelOf('Роман', ['<p>Текст</p>'], 'en')), 'en');
  assert.strictEqual(resolveLanguage(novelOf('Novel', ['<p>Text</p>'], 'ru')), 'ru');
});

test('an unset language falls back to detection', () => {
  for (const unset of [null, undefined, '']) {
    assert.strictEqual(resolveLanguage(novelOf('Роман', ['<p>Текст</p>'], unset)), 'ru', String(unset));
    assert.strictEqual(resolveLanguage(novelOf('Novel', ['<p>Text</p>'], unset)), 'en', String(unset));
  }
});

test('no setting and no signal resolves to English, never null', () => {
  assert.strictEqual(resolveLanguage(novelOf('', [''], null)), 'en');
  assert.strictEqual(resolveLanguage({}), 'en');
  assert.strictEqual(resolveLanguage(null), 'en');
});

test('the result follows the text as it changes — nothing is cached', () => {
  const n = novelOf('', ['<p>The wind rose.</p>'], null);
  assert.strictEqual(resolveLanguage(n), 'en');
  n.chapters[0].scenes[0].content = '<p>Ветер поднимался над пустошью и нёс запах дождя.</p>';
  assert.strictEqual(resolveLanguage(n), 'ru');
  assert.strictEqual(n.settings.language, null, 'the detected value must not be written back');
});

test('a malformed setting from a hand-edited file is ignored in favour of detection', () => {
  // It ends up inside XML attributes, so anything not shaped like a language tag is unsafe.
  for (const bad of ['ru" onload="x', 'EN', 'русский', ' en', 42, {}, ['ru']]) {
    assert.strictEqual(resolveLanguage(novelOf('Роман', ['<p>Текст</p>'], bad)), 'ru', JSON.stringify(bad));
  }
});

test('a well-formed tag the app does not offer yet is still honoured', () => {
  assert.strictEqual(resolveLanguage(novelOf('X', [''], 'de')), 'de');
  assert.strictEqual(resolveLanguage(novelOf('X', [''], 'pt-BR')), 'pt-BR');
});

/* ---------- NOVEL_LANGUAGES ---------- */

test('the offered languages are English then Russian, each a valid explicit setting', () => {
  assert.deepStrictEqual(NOVEL_LANGUAGES, [['en', 'English'], ['ru', 'Русский']]);
  for (const [code] of NOVEL_LANGUAGES) {
    assert.strictEqual(resolveLanguage(novelOf('', [''], code)), code);
  }
});
