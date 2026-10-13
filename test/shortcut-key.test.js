/* shortcutKey() decides which key a keyboard shortcut was pressed with. e.key follows the
 * active layout, so on a Russian layout Ctrl+S used to arrive as 'ы' and do nothing; the
 * physical key (e.code) is the fallback for anything that is not plain ASCII, while Latin
 * layouts (AZERTY, Dvorak…) keep their own letters.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * helper is lifted out between the `shortcut-key` markers and fed plain event-like objects.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(import.meta.dirname, '..', 'src', 'app.js'), 'utf8');

function loadShortcutKey() {
  const start = APP.indexOf('/* --- shortcut-key:start ---');
  const end = APP.indexOf('/* --- shortcut-key:end --- */');
  assert.ok(start !== -1 && end > start,
    'shortcut-key markers missing from src/app.js — the helper moved, update this test');
  return new Function(`'use strict';\n${APP.slice(start, end)}\nreturn shortcutKey;`)();
}

const shortcutKey = loadShortcutKey();
const ev = (key, code, shiftKey = false, extra = {}) => ({ key, code, shiftKey, ...extra });

test('US layout letters, with and without Shift', () => {
  assert.strictEqual(shortcutKey(ev('s', 'KeyS')), 's');
  assert.strictEqual(shortcutKey(ev('S', 'KeyS', true)), 's');
  assert.strictEqual(shortcutKey(ev('g', 'KeyG')), 'g');
});

test('Russian layout letters map to the physical key', () => {
  assert.strictEqual(shortcutKey(ev('ы', 'KeyS')), 's');          // Ctrl+S
  assert.strictEqual(shortcutKey(ev('Ы', 'KeyS', true)), 's');    // Ctrl+Shift+S
  assert.strictEqual(shortcutKey(ev('щ', 'KeyO')), 'o');          // Ctrl+O
  assert.strictEqual(shortcutKey(ev('п', 'KeyG')), 'g');          // Ctrl+G
  assert.strictEqual(shortcutKey(ev('Ь', 'KeyM', true)), 'm');    // Ctrl+Shift+M
  assert.strictEqual(shortcutKey(ev('А', 'KeyF', true)), 'f');    // Ctrl+Shift+F
  assert.strictEqual(shortcutKey(ev('М', 'KeyV', true)), 'v');    // Ctrl+Shift+V
});

test('other Latin layouts keep their own letters', () => {
  assert.strictEqual(shortcutKey(ev('a', 'KeyQ')), 'a');          // AZERTY
  assert.strictEqual(shortcutKey(ev('o', 'KeyS')), 'o');          // Dvorak
});

test('panel toggles: backslash and slash', () => {
  assert.strictEqual(shortcutKey(ev('\\', 'Backslash')), '\\');   // US and Russian
  assert.strictEqual(shortcutKey(ev('/', 'Slash')), '/');         // US
  assert.strictEqual(shortcutKey(ev('.', 'Slash')), '/');         // Russian: that key types '.'
  assert.strictEqual(shortcutKey(ev('/', 'Digit7', true)), '/');  // German: Shift+7 types '/'
});

test('AltGr letters stay letters (Windows reports AltGr as Ctrl+Alt)', () => {
  const altGr = { ctrlKey: true, altKey: true };
  assert.strictEqual(shortcutKey(ev('ś', 'KeyS', false, altGr)), 'ś');   // Polish
  assert.strictEqual(shortcutKey(ev('Ś', 'KeyS', true, altGr)), 'Ś');
  assert.strictEqual(shortcutKey(ev('ó', 'KeyO', false, altGr)), 'ó');
  assert.strictEqual(shortcutKey(ev('ģ', 'KeyG', false, altGr)), 'ģ');   // Latvian
  assert.strictEqual(shortcutKey(ev('ß', 'KeyS', false, altGr)), 'ß');   // US-International
  const modState = { getModifierState: m => m === 'AltGraph' };
  assert.strictEqual(shortcutKey(ev('ș', 'KeyS', false, modState)), 'ș'); // Romanian, AltGraph state
  // a plain Ctrl+Alt+S on a Latin layout behaves as before: the key itself
  assert.strictEqual(shortcutKey(ev('s', 'KeyS', false, altGr)), 's');
});

test('the Slash key counts as "/" only where it types "."', () => {
  assert.strictEqual(shortcutKey(ev('-', 'Slash')), '-');   // German/Spanish/Nordic: Ctrl+- is not Ctrl+/
  assert.strictEqual(shortcutKey(ev('!', 'Slash')), '!');   // French AZERTY
});

test('shifted punctuation is not mistaken for the toggles', () => {
  assert.strictEqual(shortcutKey(ev('?', 'Slash', true)), '?');   // US Shift+/
  assert.strictEqual(shortcutKey(ev('|', 'Backslash', true)), '|'); // US Shift+\
  assert.strictEqual(shortcutKey(ev('.', 'Period')), '.');
});

test('named keys pass through', () => {
  assert.strictEqual(shortcutKey(ev('Escape', 'Escape')), 'Escape');
  assert.strictEqual(shortcutKey(ev('ArrowDown', 'ArrowDown')), 'ArrowDown');
  assert.strictEqual(shortcutKey(ev('Enter', 'Enter')), 'Enter');
});

test('missing fields do not throw', () => {
  assert.strictEqual(shortcutKey({}), '');
  assert.strictEqual(shortcutKey({ key: 'ö', code: 'Semicolon' }), 'ö');
});
