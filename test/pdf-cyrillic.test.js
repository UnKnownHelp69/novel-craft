/* Regression guard for the PDF export destroying Cyrillic text.
 *
 * The PDF exporter used to draw with the standard-14 Courier fonts, which contain no
 * Cyrillic glyphs at all, and papered over that by rewriting every codepoint above 255
 * as '?'. Every compiled PDF silently lost all Russian text. These tests pin down the
 * things that have to stay true for that not to come back:
 *
 *   1. normalizeForPdf() must not substitute characters it cannot draw.
 *   2. The bundled font must actually contain the Cyrillic glyphs, at the advance width
 *      the layout code assumes.
 *   3. The bytes written into the PDF content stream must decode back to the original
 *      text — i.e. the glyph ids really are the Cyrillic glyphs, not '?' or .notdef.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * pure helpers are lifted out of the file between the `pdf-text-core` markers and run
 * here in isolation. That block is DOM-free by contract.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

function loadPdfCore() {
  const start = APP.indexOf('/* --- pdf-text-core:start ---');
  const end = APP.indexOf('/* --- pdf-text-core:end --- */');
  assert.ok(start !== -1 && end > start,
    'pdf-text-core markers missing from src/app.js — the PDF helpers moved, update this test');
  const src = APP.slice(start, end);
  return new Function(`${src}\nreturn { normalizeForPdf, pdfLen, parseTrueType, pdfGlyphHex, pdfToUnicodeCMap };`)();
}

const core = loadPdfCore();
const FONTS = ['IBMPlexMono-Regular.ttf', 'IBMPlexMono-Bold.ttf', 'IBMPlexMono-Italic.ttf'];
const fontBytes = name => new Uint8Array(readFileSync(join(ROOT, 'src', 'fonts', 'pdf', name)));

// Title page, TOC, headings and body text all funnel through the same helpers, so one
// representative sample of each is enough.
const SAMPLES = {
  body: 'Привет, это тестовая сцена с кириллицей — проверка «ёлочек» и тире.',
  heading: 'Глава первая: Начало',
  toc: 'Содержание',
  title: 'Тайна старого дома',
  mixed: 'Mixed Латиница and Кириллица 123'
};

test('normalizeForPdf keeps Cyrillic instead of substituting "?"', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    const out = core.normalizeForPdf(text);
    assert.ok(!out.includes('?'), `${name}: '?' substituted into ${JSON.stringify(out)}`);
    for (const ch of text) {
      if (/[Ѐ-ӿ]/.test(ch)) {
        assert.ok(out.includes(ch), `${name}: dropped Cyrillic character ${ch}`);
      }
    }
  }
});

test('normalizeForPdf still folds smart punctuation to ASCII', () => {
  assert.strictEqual(core.normalizeForPdf('“x” ‘y’ a—b c…d'), '"x" \'y\' a-b c...d');
  assert.strictEqual(core.normalizeForPdf('a\u00A0b'), 'a b');           // nbsp -> space
  assert.strictEqual(core.normalizeForPdf('a\tb'), 'a    b');        // tab -> four spaces
  assert.strictEqual(core.normalizeForPdf('a\u0001b'), 'ab');            // control chars dropped
});

test('normalizeForPdf preserves the exact Russian sample', () => {
  // « » are Latin-1 and pass through unchanged; the em dash folds to '-' by design.
  assert.strictEqual(
    core.normalizeForPdf(SAMPLES.body),
    'Привет, это тестовая сцена с кириллицей - проверка «ёлочек» и тире.'
  );
});

test('pdfLen counts glyphs, not UTF-16 code units', () => {
  assert.strictEqual(core.pdfLen('Глава'), 5);
  assert.strictEqual(core.pdfLen('a\u{1F600}b'), 3);   // astral char is one glyph
});

for (const name of FONTS) {
  test(`${name}: embeddable, monospaced at 0.6em, covers Cyrillic`, () => {
    const f = core.parseTrueType(fontBytes(name));

    // The layout code hardcodes `size * 0.6` per glyph; a font whose advance differs
    // would silently misalign every wrapped line, centred heading and page number.
    assert.strictEqual(f.unitsPerEm, 1000, 'unexpected unitsPerEm');
    assert.strictEqual(f.advance, 600, 'advance must stay 600/1000 em to match the layout');
    assert.ok(f.fixedPitch, 'font must be monospaced');
    assert.ok(f.psName.length > 0 && !/[\s/()<>[\]{}]/.test(f.psName), 'bad PostScript name');
    assert.ok(f.numGlyphs > 0 && f.ascent > 0 && f.descent < 0, 'implausible font metrics');

    // Full Russian alphabet, both cases, including ё.
    const alphabet = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя';
    const missing = [...alphabet].filter(ch => f.cmap.get(ch.codePointAt(0)) == null);
    assert.deepStrictEqual(missing, [], 'font is missing Cyrillic glyphs');
  });
}

test('content-stream glyph ids decode back to the original Cyrillic', () => {
  const f = core.parseTrueType(fontBytes('IBMPlexMono-Regular.ttf'));
  const reverse = new Map();
  for (const [cp, gid] of f.cmap) if (!reverse.has(gid)) reverse.set(gid, cp);

  for (const [name, sample] of Object.entries(SAMPLES)) {
    const text = core.normalizeForPdf(sample);
    const report = { missing: new Set(), used: new Map() };
    const hex = core.pdfGlyphHex(text, f, report);

    assert.deepStrictEqual([...report.missing], [], `${name}: characters missing from the font`);
    assert.strictEqual(hex.length, core.pdfLen(text) * 4, `${name}: wrong glyph-id string length`);
    assert.ok(/^[0-9A-F]*$/.test(hex), `${name}: content stream must be uppercase hex`);

    const decoded = (hex.match(/.{4}/g) || [])
      .map(h => parseInt(h, 16))
      .map(gid => {
        assert.notStrictEqual(gid, 0, `${name}: .notdef glyph emitted`);
        return String.fromCodePoint(reverse.get(gid));
      }).join('');
    assert.strictEqual(decoded, text, `${name}: text does not survive the round trip`);
  }
});

test('Cyrillic is not encoded as "?" glyphs', () => {
  const f = core.parseTrueType(fontBytes('IBMPlexMono-Regular.ttf'));
  const report = { missing: new Set(), used: new Map() };
  const hex = core.pdfGlyphHex(core.normalizeForPdf('Кириллица'), f, report);

  const question = f.cmap.get('?'.codePointAt(0)).toString(16).toUpperCase().padStart(4, '0');
  assert.ok(!hex.includes(question), 'Cyrillic was replaced by "?" glyphs — the original bug');
  assert.ok(!hex.includes('0000'), 'Cyrillic was replaced by .notdef glyphs');
});

test('unsupported characters are reported, never silently swapped', () => {
  const f = core.parseTrueType(fontBytes('IBMPlexMono-Regular.ttf'));
  const report = { missing: new Set(), used: new Map() };
  const hex = core.pdfGlyphHex('А\u{1F600}Б', f, report);   // emoji is not in the font

  assert.deepStrictEqual([...report.missing], ['\u{1F600}'], 'missing character not reported');
  assert.ok(hex.includes('0000'), 'uncovered character should fall back to a visible .notdef box');
});

test('ToUnicode CMap maps the glyph ids back to Cyrillic codepoints', () => {
  const f = core.parseTrueType(fontBytes('IBMPlexMono-Regular.ttf'));
  const report = { missing: new Set(), used: new Map() };
  core.pdfGlyphHex('Глава', f, report);
  const cmap = core.pdfToUnicodeCMap(report.used);

  assert.match(cmap, /begincmap/);
  assert.match(cmap, /\/CMapName \/Adobe-Identity-UCS def/);
  assert.match(cmap, /beginbfchar/);
  for (const ch of 'Глава') {
    const gid = f.cmap.get(ch.codePointAt(0)).toString(16).toUpperCase().padStart(4, '0');
    const cp = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    assert.ok(cmap.includes(`<${gid}> <${cp}>`), `no ToUnicode entry for ${ch}`);
  }
});

test('the exporter embeds the bundled font instead of standard-14 Courier', () => {
  // Cheap guard against someone reinstating the base-14 fonts, which cannot render
  // Cyrillic under any encoding.
  assert.ok(!/BaseFont \/Courier/.test(APP), 'standard-14 Courier is back in the PDF exporter');
  assert.ok(!/WinAnsiEncoding/.test(APP), 'WinAnsiEncoding is back in the PDF exporter');
  assert.ok(/\/Encoding \/Identity-H/.test(APP), 'PDF text is no longer written as Identity-H');
  assert.ok(!/code > 255/.test(APP), 'the codepoint > 255 -> "?" fallback is back');
});
