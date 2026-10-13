/* The allowlist behind sanitizeSceneHTML(). Scene HTML comes from .novel files — possibly
 * someone else's — and from the clipboard, and it lands in the live editor, where the app
 * can reach the file system. These tests pin the policy decisions; the DOM walk that applies
 * them is exercised in a real browser by e2e/browser.e2e.mjs.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * policy is lifted out between the `html-policy` markers. It is DOM-free by contract.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(import.meta.dirname, '..', 'src', 'app.js'), 'utf8');

function loadPolicy() {
  const start = APP.indexOf('/* --- html-policy:start ---');
  const end = APP.indexOf('/* --- html-policy:end --- */');
  assert.ok(start !== -1 && end > start,
    'html-policy markers missing from src/app.js — the policy moved, update this test');
  return new Function(`'use strict';\n${APP.slice(start, end)}\n` +
    'return { sceneTagAction, sceneAttrValue, sceneStyleValueOk, SCENE_KEEP_TAGS, SCENE_DROP_TAGS };')();
}

const P = loadPolicy();

test('everything the editor and mdToHtml produce is kept', () => {
  for (const tag of ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'font', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote']) {
    assert.strictEqual(P.sceneTagAction(tag), 'keep', tag);
  }
  assert.strictEqual(P.sceneTagAction('P'), 'keep', 'tag names are case-insensitive');
});

test('harmless layout from older pastes is kept: ruby, centring, tables', () => {
  for (const tag of ['ruby', 'rt', 'rp', 'center', 'table', 'td', 'th']) assert.strictEqual(P.sceneTagAction(tag), 'keep', tag);
});

test('active, raw-text and foreign content is dropped with its contents', () => {
  for (const tag of ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math',
    'link', 'meta', 'base', 'title', 'textarea', 'xmp', 'plaintext', 'noembed', 'noframes', 'button', 'marquee']) {
    assert.strictEqual(P.sceneTagAction(tag), 'drop', tag);
  }
});

test('unknown and harmless wrappers are unwrapped to their text', () => {
  for (const tag of ['a', 'o:p', 'x-custom', 'section', 'article', 'form', 'label', 'abbr', '']) {
    assert.strictEqual(P.sceneTagAction(tag), 'unwrap', tag);
  }
});

test('keep and drop lists do not overlap', () => {
  for (const tag of P.SCENE_KEEP_TAGS) assert.ok(!P.SCENE_DROP_TAGS.has(tag), tag);
});

test('event handlers and other attributes are removed', () => {
  for (const [tag, name, value] of [
    ['img', 'onerror', 'alert(1)'], ['p', 'onclick', 'x()'], ['p', 'class', 'MsoNormal'], ['span', 'id', 'x'],
    ['a', 'href', 'javascript:alert(1)'], ['font', 'color', 'red'], ['div', 'contenteditable', 'false'],
    ['p', 'style', 'color:red'], ['img', 'srcset', 'x.png 1x']
  ]) {
    assert.strictEqual(P.sceneAttrValue(tag, name, value), null, `${tag}[${name}]`);
  }
});

test('direction, alignment and cell spans survive with plain values only', () => {
  assert.strictEqual(P.sceneAttrValue('p', 'dir', 'rtl'), 'rtl');
  assert.strictEqual(P.sceneAttrValue('p', 'dir', 'rtl" onclick="x'), null);
  assert.strictEqual(P.sceneAttrValue('p', 'align', 'center'), 'center');
  assert.strictEqual(P.sceneAttrValue('div', 'align', 'middle;x'), null);
  assert.strictEqual(P.sceneAttrValue('td', 'colspan', '2'), '2');
  assert.strictEqual(P.sceneAttrValue('th', 'rowspan', '12'), '12');
  assert.strictEqual(P.sceneAttrValue('td', 'colspan', '0'), null);
  assert.strictEqual(P.sceneAttrValue('td', 'colspan', '99999'), null);
  assert.strictEqual(P.sceneAttrValue('p', 'colspan', '2'), null, 'only on cells');
});

test('<font face> survives only as a plain font list', () => {
  assert.strictEqual(P.sceneAttrValue('font', 'face', "'Lora', serif"), "'Lora', serif");
  assert.strictEqual(P.sceneAttrValue('FONT', 'FACE', 'Georgia, serif'), 'Georgia, serif');
  assert.strictEqual(P.sceneAttrValue('font', 'face', 'x;background:url(//evil)'), null);
  assert.strictEqual(P.sceneAttrValue('font', 'face', 'a"><img src=x onerror=1>'), null);
});

test('images survive only as inline raster data', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.strictEqual(P.sceneAttrValue('img', 'src', png), png);
  assert.strictEqual(P.sceneAttrValue('img', 'src', 'data:image/jpeg;base64,/9j/4AAQ'), 'data:image/jpeg;base64,/9j/4AAQ');
  assert.strictEqual(P.sceneAttrValue('img', 'src', 'https://tracker.example/pixel.gif'), null);
  assert.strictEqual(P.sceneAttrValue('img', 'src', 'data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.strictEqual(P.sceneAttrValue('img', 'src', 'javascript:alert(1)'), null);
  assert.strictEqual(P.sceneAttrValue('img', 'alt', 'map'), 'map');
});

test('inline styles keep only formatting properties with plain values', () => {
  assert.ok(P.sceneStyleValueOk('font-weight', 'bold'));
  assert.ok(P.sceneStyleValueOk('font-weight', '700'));
  assert.ok(P.sceneStyleValueOk('font-style', 'italic'));
  assert.ok(P.sceneStyleValueOk('font-family', '"Lora", serif'));
  assert.ok(P.sceneStyleValueOk('text-decoration-line', 'underline line-through'));
  assert.ok(P.sceneStyleValueOk('text-align', 'center'));
  assert.ok(P.sceneStyleValueOk('white-space', 'pre'));
  assert.ok(P.sceneStyleValueOk('font-family', "'Noto Serif.Display', serif"));
  assert.ok(!P.sceneStyleValueOk('text-align', 'center; background:url(x)'));
  assert.ok(!P.sceneStyleValueOk('background-color', '#fff'), 'colours are not kept (dark editor)');
  assert.ok(!P.sceneStyleValueOk('background-image', 'url(https://evil)'));
  assert.ok(!P.sceneStyleValueOk('color', 'red'));
  assert.ok(!P.sceneStyleValueOk('font-family', 'x, url(https://evil)'));
  assert.ok(!P.sceneStyleValueOk('font-weight', 'bold; background:url(x)'));
  assert.ok(!P.sceneStyleValueOk('position', 'fixed'));
});
