/* countWords() feeds every word counter in the app: the tree, the counters panel, the goal
 * bar, the corkboard and the compile totals. A word must start and end with a letter or a
 * digit — apostrophes and hyphens only count when they join letters — so a hyphen typed as
 * a dash (" - ", very common in Russian prose) is not a word of its own.
 */
import test from 'node:test';
import assert from 'node:assert';
import { countWords } from '../src/js/lib/text.js';

test('a hyphen used as a dash is not a word', () => {
  assert.strictEqual(countWords('Привет - мир'), 2);
  assert.strictEqual(countWords('Он сказал - нет - и ушёл'), 5);
  assert.strictEqual(countWords('- Привет, - сказал он.'), 3);
  assert.strictEqual(countWords('--- * * * ---'), 0);
});

test('hyphens and apostrophes inside a word keep it whole', () => {
  assert.strictEqual(countWords('кто-то'), 1);
  assert.strictEqual(countWords('из-за угла'), 2);
  assert.strictEqual(countWords("rock'n'roll"), 1);
  assert.strictEqual(countWords('don’t stop'), 2);
  assert.strictEqual(countWords('well-known fact'), 2);
});

test('punctuation glued to a word does not change the count', () => {
  assert.strictEqual(countWords('«Да», — ответила она…'), 3);
  assert.strictEqual(countWords('"Hello," he said - "world".'), 4);
  assert.strictEqual(countWords("'quoted'"), 1);
  assert.strictEqual(countWords('word-'), 1);
  assert.strictEqual(countWords('-word'), 1);
});

test('numbers count as words', () => {
  assert.strictEqual(countWords('В 1812 году'), 3);
  assert.strictEqual(countWords('Глава 2-я'), 2);
});

test('letters with combining marks are one word (decomposed й, accents)', () => {
  assert.strictEqual(countWords('йод'), 1);                 // "йод" with a decomposed й
  assert.strictEqual(countWords('café au lait'), 3);         // "café" written as e + U+0301
});

test('empty and whitespace-only input count as zero', () => {
  assert.strictEqual(countWords(''), 0);
  assert.strictEqual(countWords('   \n\t '), 0);
  assert.strictEqual(countWords(null), 0);
  assert.strictEqual(countWords(undefined), 0);
});

test('mixed scripts and line breaks', () => {
  assert.strictEqual(countWords('Mixed Латиница and Кириллица 123'), 5);
  assert.strictEqual(countWords('first line\nsecond line'), 4);
});
