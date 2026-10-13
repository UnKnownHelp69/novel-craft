/* textFromNode() is the walk behind stripHtml(): the plain text of a scene for word and
 * character counts, TXT export and PDF/DOCX fallbacks. It runs on every keystroke (twice),
 * so it must stay linear — the old version grew one string with += and called .endsWith()
 * on it for every node, which makes V8 flatten the string each time: ~0.4 s per keystroke
 * on a 30k-word scene.
 *
 * The walk is DOM-free by contract (it only reads nodeType / nodeName / nodeValue /
 * childNodes), so it is lifted out between the `strip-html` markers and fed plain objects
 * that mimic a parsed tree.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(import.meta.dirname, '..', 'src', 'app.js'), 'utf8');

function loadTextFromNode() {
  const start = APP.indexOf('/* --- strip-html:start ---');
  const end = APP.indexOf('/* --- strip-html:end --- */');
  assert.ok(start !== -1 && end > start,
    'strip-html markers missing from src/app.js — the helper moved, update this test');
  return new Function(`'use strict';\n${APP.slice(start, end)}\nreturn textFromNode;`)();
}

const textFromNode = loadTextFromNode();

// Minimal node-like builders: el('P', 'text', el('B', 'bold')) etc.
const txt = value => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] });
const el = (name, ...kids) => ({
  nodeType: 1, nodeName: name, nodeValue: null,
  childNodes: kids.map(k => (typeof k === 'string' ? txt(k) : k))
});
const body = (...kids) => el('BODY', ...kids);

test('paragraphs are separated by a newline and the result is trimmed', () => {
  assert.strictEqual(textFromNode(body(el('P', 'one'), el('P', 'two'))), 'one\ntwo');
  assert.strictEqual(textFromNode(body(el('H1', 'Title'), el('P', 'Body'))), 'Title\nBody');
});

test('<br> becomes a newline; inline markup adds nothing', () => {
  assert.strictEqual(textFromNode(body(el('P', 'a', el('BR'), 'b'))), 'a\nb');
  assert.strictEqual(textFromNode(body(el('P', 'a ', el('B', 'bold'), ' ', el('I', 'it')))), 'a bold it');
});

test('nested and empty blocks never produce doubled newlines', () => {
  assert.strictEqual(textFromNode(body(el('DIV', el('P', 'x')), el('DIV', el('P', 'y')))), 'x\ny');
  assert.strictEqual(textFromNode(body(el('P'), el('P', 'x'), el('P'), el('P', 'y'))), 'x\ny');
  assert.strictEqual(textFromNode(body(el('P', 'x', el('BR')), el('P', 'y'))), 'x\ny');
});

test('list items and table rows are blocks', () => {
  assert.strictEqual(textFromNode(body(el('UL', el('LI', 'a'), el('LI', 'b')))), 'a\nb');
  assert.strictEqual(textFromNode(body(el('TABLE', el('TR', el('TD', 'a')), el('TR', el('TD', 'b'))))), 'a\nb');
});

test('comment-like nodes contribute nothing; Cyrillic passes through untouched', () => {
  const comment = { nodeType: 8, nodeName: '#comment', nodeValue: 'hidden', childNodes: [] };
  assert.strictEqual(textFromNode(body(el('P', 'Жили-были', comment, ' старик'))), 'Жили-были старик');
});

test('empty input', () => {
  assert.strictEqual(textFromNode(body()), '');
  assert.strictEqual(textFromNode(body(el('P'), el('P', '   '))), '');
});

test('stays linear on a very long scene', () => {
  // 60k paragraphs ≈ 3.4M characters. The quadratic version needs minutes for this; the
  // linear one a few dozen milliseconds. The bound is generous to stay robust on slow CI.
  const para = 'Он шёл по дороге и думал о том, что завтра всё будет иначе. ';
  const kids = [];
  for (let i = 0; i < 60000; i++) kids.push(el('P', para, el('B', 'жирный'), ' хвост'));
  const t0 = performance.now();
  const out = textFromNode(body(...kids));
  const ms = performance.now() - t0;
  assert.strictEqual(out.split('\n').length, 60000);
  assert.ok(ms < 3000, `textFromNode took ${ms.toFixed(0)} ms on 60k paragraphs — quadratic again?`);
});
