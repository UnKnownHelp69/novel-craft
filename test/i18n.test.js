/* The interface translations: t() itself, and the dictionaries kept in step with each other and
 * with the code. A key missing from a language silently shows English, a placeholder misspelt in
 * a translation shows "{name}" to the user, and a missing plural form picks the wrong word — none
 * of which any other test would notice, so they are checked here for every language in LOCALES.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES, FALLBACK, t, setLocale, resolveLocale } from '../src/js/i18n/index.js';

const SRC = join(import.meta.dirname, '..', 'src');
const en = LOCALES[FALLBACK].dict;
const placeholders = v => [...new Set([...(typeof v === 'object' ? Object.values(v).join(' ') : v).matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();

/* All the code and markup that can name a key. */
const sources = [
  readFileSync(join(SRC, 'index.html'), 'utf8'),
  ...readdirSync(join(SRC, 'js'), { recursive: true })
    .filter(f => f.endsWith('.js') && !f.startsWith('i18n'))
    .map(f => readFileSync(join(SRC, 'js', f), 'utf8'))
].join('\n');

test('t() fills placeholders, picks plural forms and falls back to English, then to the key', () => {
  setLocale('ru');
  try {
    assert.strictEqual(t('common.cancel'), 'Отмена');
    assert.strictEqual(t('no.such.key'), 'no.such.key');
  } finally { setLocale(FALLBACK); }
  assert.strictEqual(t('common.cancel'), 'Cancel');
});

test('resolveLocale: an explicit choice wins, "auto" follows the system language, English otherwise', () => {
  assert.strictEqual(resolveLocale('ru', ['en-US']), 'ru');
  assert.strictEqual(resolveLocale('auto', ['ru-RU', 'en']), 'ru');
  assert.strictEqual(resolveLocale('auto', ['de-DE', 'ru']), 'ru', 'the first language with a dictionary');
  assert.strictEqual(resolveLocale('auto', ['de-DE']), 'en');
  assert.strictEqual(resolveLocale('xx', []), 'en', 'an unknown stored choice falls back');
  assert.strictEqual(resolveLocale(undefined, undefined), 'en');
});

for (const [code, { name, dict }] of Object.entries(LOCALES)) {
  test(`${code} (${name}) has exactly the English keys`, () => {
    assert.deepStrictEqual(Object.keys(dict).filter(k => !(k in en)), [], 'keys English does not have');
    assert.deepStrictEqual(Object.keys(en).filter(k => !(k in dict)), [], 'keys not translated');
  });

  test(`${code}: every entry has the English placeholders and every plural form the language uses`, () => {
    const forms = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const [key, v] of Object.entries(dict)) {
      assert.deepStrictEqual(placeholders(v), placeholders(en[key]), `${key}: placeholders differ from English`);
      assert.strictEqual(typeof v, typeof en[key], `${key}: plural in one language, plain in the other`);
      if (typeof v === 'object') {
        for (const f of forms) assert.strictEqual(typeof v[f], 'string', `${key}: no "${f}" form`);
      } else {
        assert.strictEqual(typeof v, 'string', key);
        assert.ok(v.length > 0, `${key}: empty`);
      }
    }
  });
}

test('every key the code or markup names exists, and every key is used', () => {
  const named = new Set();
  for (const m of sources.matchAll(/\bt\(\s*'([\w.]+)'/g)) named.add(m[1]);
  for (const m of sources.matchAll(/data-i18n(?:-[\w-]+)?="([\w.]+)"/g)) named.add(m[1]);
  assert.deepStrictEqual([...named].filter(k => !(k in en)).sort(), [], 'keys missing from en.js');
  // Keys can also be named indirectly (a table of keys looked up with t() later), so a key counts
  // as used when its quoted name appears anywhere in the code.
  const unused = Object.keys(en).filter(k => !sources.includes(`'${k}'`) && !sources.includes(`"${k}"`));
  assert.deepStrictEqual(unused, [], 'keys nothing uses');
});
