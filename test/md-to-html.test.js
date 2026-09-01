/* Coverage for mdToHtml() and inlineMd() — the markdown -> HTML conversion the editor
 * runs on every save while markdown mode is on (saveCurrentScene) and when toggling back
 * out of it (toggleMarkdownMode). Its output goes straight into the contenteditable as
 * HTML, so both what it converts and what it escapes are load-bearing.
 *
 * The implementation is two regex passes over each line, which is a deliberately small
 * subset of markdown rather than a parser. Several of the tests below are therefore
 * CHARACTERIZATION tests: they pin what the current implementation actually produces for
 * overlapping or unbalanced emphasis, including output that is not what a real markdown
 * parser would emit. They are here so a future rewrite has to notice it is changing
 * behaviour — not as a claim that the behaviour is correct. Each such test says so.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the two
 * functions are lifted out between the `mdtohtml` markers and run here in isolation — the
 * same technique as test/comp-toc.test.js, test/docx-strings.test.js and the rest.
 * inlineMd()'s only dependency is esc(), lifted from the `docx-strings:esc` pair it
 * already had from PR #18.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

function slice(name) {
  const start = APP.indexOf(`/* --- ${name}:start ---`);
  const end = APP.indexOf(`/* --- ${name}:end --- */`);
  assert.ok(start !== -1 && end > start,
    `${name} markers missing from src/app.js — the code moved, update this test`);
  return APP.slice(start, end);
}

function loadMdToHtml() {
  const src = slice('docx-strings:esc') + '\n' + slice('mdtohtml');
  // A new Function body is sloppy-mode by default; src/app.js runs under 'use strict'.
  return new Function(`'use strict';\n${src}\nreturn { mdToHtml, inlineMd };`)();
}

const { mdToHtml, inlineMd } = loadMdToHtml();

/* ---------- Headings ---------- */

test('#, ## and ### become h1, h2 and h3', () => {
  assert.strictEqual(mdToHtml('# Heading one'), '<h1>Heading one</h1>');
  assert.strictEqual(mdToHtml('## Heading two'), '<h2>Heading two</h2>');
  assert.strictEqual(mdToHtml('### Heading three'), '<h3>Heading three</h3>');
});

test('the longest matching hash prefix wins', () => {
  // ### is tested before ## and #, so "### x" is an h3 and not an h1 containing "## x".
  assert.strictEqual(mdToHtml('### x'), '<h3>x</h3>');
  assert.strictEqual(mdToHtml('## x'), '<h2>x</h2>');
});

test('a heading marker with no content after it yields an empty heading', () => {
  assert.strictEqual(mdToHtml('# '), '<h1></h1>');
  assert.strictEqual(mdToHtml('## '), '<h2></h2>');
  assert.strictEqual(mdToHtml('### '), '<h3></h3>');
});

test('all whitespace between the hashes and the text is consumed', () => {
  assert.strictEqual(mdToHtml('###   spaced'), '<h3>spaced</h3>');
  assert.strictEqual(mdToHtml('#\ttabbed'), '<h1>tabbed</h1>');
});

test('a hash with no space after it is NOT a heading', () => {
  // The regexes require \s+ after the hashes, so "#word" is ordinary paragraph text.
  assert.strictEqual(mdToHtml('#word'), '<p>#word</p>');
  assert.strictEqual(mdToHtml('##word'), '<p>##word</p>');
  assert.strictEqual(mdToHtml('###word'), '<p>###word</p>');
  assert.strictEqual(mdToHtml('#1 fan'), '<p>#1 fan</p>');
});

test('a bare hash with nothing after it is NOT a heading', () => {
  assert.strictEqual(mdToHtml('#'), '<p>#</p>');
  assert.strictEqual(mdToHtml('###'), '<p>###</p>');
});

test('four or more hashes are not a heading at any level', () => {
  // Characterization: h4+ is unsupported, and "#### x" does not degrade to an h3 either,
  // because /^###\s+/ needs whitespace where the fourth hash sits.
  assert.strictEqual(mdToHtml('#### four hashes'), '<p>#### four hashes</p>');
});

test('a heading must start at column 0 — leading whitespace disables it', () => {
  assert.strictEqual(mdToHtml('  # indented'), '<p>  # indented</p>');
});

test('heading text still goes through the inline pass', () => {
  assert.strictEqual(mdToHtml('# **bold heading**'), '<h1><b>bold heading</b></h1>');
  assert.strictEqual(mdToHtml('## A & B <tag>'), '<h2>A &amp; B &lt;tag&gt;</h2>');
});

/* ---------- Bold and italic ---------- */

test('**text** becomes <b>', () => {
  assert.strictEqual(mdToHtml('**bold**'), '<p><b>bold</b></p>');
  assert.strictEqual(mdToHtml('a **bold** b'), '<p>a <b>bold</b> b</p>');
});

test('*text* becomes <i>', () => {
  assert.strictEqual(mdToHtml('*italic*'), '<p><i>italic</i></p>');
  assert.strictEqual(mdToHtml('a *italic* b'), '<p>a <i>italic</i> b</p>');
});

test('bold and italic in the same line both apply when they do not overlap', () => {
  assert.strictEqual(mdToHtml('**bold** and *italic* together'),
    '<p><b>bold</b> and <i>italic</i> together</p>');
  assert.strictEqual(mdToHtml('*italic* first, **bold** second'),
    '<p><i>italic</i> first, <b>bold</b> second</p>');
});

test('several spans of the same kind on one line are all converted', () => {
  assert.strictEqual(mdToHtml('**a**b**c**'), '<p><b>a</b>b<b>c</b></p>');
  assert.strictEqual(mdToHtml('*a*b*c*'), '<p><i>a</i>b<i>c</i></p>');
});

test('emphasis spans multiple words and Unicode text', () => {
  assert.strictEqual(mdToHtml('*multi word italic*'), '<p><i>multi word italic</i></p>');
  assert.strictEqual(mdToHtml('Привет **мир**'), '<p>Привет <b>мир</b></p>');
  assert.strictEqual(mdToHtml('**Глава** — *начало*'), '<p><b>Глава</b> — <i>начало</i></p>');
});

test('emphasis does not span a line break', () => {
  // Each line is converted independently, so the markers stay literal text on both lines.
  assert.strictEqual(mdToHtml('**bold\ntext**'), '<p>**bold</p><p>text**</p>');
});

/* ---------- Overlapping / unbalanced emphasis (characterization) ---------- */

test('CHARACTERIZATION: ***text*** produces mis-nested <b><i>...</b></i>', () => {
  // Not valid HTML — the bold pass takes the first two stars and the last two, leaving a
  // stray leading star that the italic pass then pairs with the trailing one. A browser
  // re-parses this when it is assigned to innerHTML, so what renders is not what the
  // crossed tags literally say. Pinned as current behaviour, not as correct output.
  assert.strictEqual(mdToHtml('***bold italic***'), '<p><b><i>bold italic</b></i></p>');
  assert.strictEqual(inlineMd('***x***'), '<b><i>x</b></i>');
});

test('italic nested inside bold works when the spans are properly nested', () => {
  assert.strictEqual(mdToHtml('**a *b* c**'), '<p><b>a <i>b</i> c</b></p>');
});

test('bold nested inside italic also works when properly nested', () => {
  // The bold pass runs first and consumes the inner markers; the italic pass then pairs
  // the two remaining outer stars across the tags the first pass inserted.
  assert.strictEqual(mdToHtml('*a **b** c*'), '<p><i>a <b>b</b> c</i></p>');
});

test('CHARACTERIZATION: unpaired markers are left alone', () => {
  assert.strictEqual(mdToHtml('**unclosed'), '<p>**unclosed</p>');
  assert.strictEqual(mdToHtml('*unclosed'), '<p>*unclosed</p>');
  assert.strictEqual(mdToHtml('**'), '<p>**</p>');
  assert.strictEqual(mdToHtml('*'), '<p>*</p>');
  // Both regexes need at least one character between the markers, so "****" cannot be
  // bold; the italic pass then pairs stars 1 and 3 and leaves the fourth as text.
  assert.strictEqual(mdToHtml('****'), '<p><i>*</i>*</p>');
});

test('CHARACTERIZATION: stars used as punctuation are still treated as emphasis', () => {
  // A line like "a * b * c" reads as prose to a human but pairs up for the regex.
  assert.strictEqual(mdToHtml('a * b * c'), '<p>a <i> b </i> c</p>');
  assert.strictEqual(mdToHtml('*a**b*'), '<p><i>a</i><i>b</i></p>');
});

/* ---------- HTML escaping ---------- */

test('&, < and > from the markdown source are escaped, not interpreted', () => {
  assert.strictEqual(mdToHtml('a & b < c > d'), '<p>a &amp; b &lt; c &gt; d</p>');
  assert.strictEqual(mdToHtml('<script>alert(1)</script>'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.strictEqual(mdToHtml('5 < 6 && 7 > 6'), '<p>5 &lt; 6 &amp;&amp; 7 &gt; 6</p>');
});

test('escaping happens before emphasis, so generated tags survive and typed ones do not', () => {
  // The user typed literal <b> tags: they must come out as text. The <b> the bold pass
  // adds is inserted after esc() has run, so it stays a real tag.
  assert.strictEqual(mdToHtml('<b>typed</b> and **generated**'),
    '<p>&lt;b&gt;typed&lt;/b&gt; and <b>generated</b></p>');
});

test('an ampersand that looks like an entity is escaped too', () => {
  assert.strictEqual(mdToHtml('&amp; &lt; &#39;'), '<p>&amp;amp; &amp;lt; &amp;#39;</p>');
});

test('CHARACTERIZATION: quotes are NOT escaped', () => {
  // esc() covers & < > only. Harmless here, because this output becomes element content
  // rather than an attribute value — but it is a real gap in esc(), tracked separately and
  // deliberately left alone by this test.
  assert.strictEqual(mdToHtml('**"quoted"**'), '<p><b>"quoted"</b></p>');
  assert.strictEqual(inlineMd('it\'s a "test"'), 'it\'s a "test"');
});

/* ---------- Blank lines and paragraphs ---------- */

test('a blank line becomes <p><br></p>', () => {
  assert.strictEqual(mdToHtml('\n'), '<p><br></p><p><br></p>');
  assert.strictEqual(mdToHtml('a\n\nb'), '<p>a</p><p><br></p><p>b</p>');
});

test('a whitespace-only line is treated as blank', () => {
  assert.strictEqual(mdToHtml('   '), '<p><br></p>');
  assert.strictEqual(mdToHtml('\t'), '<p><br></p>');
  assert.strictEqual(mdToHtml('a\n \t \nb'), '<p>a</p><p><br></p><p>b</p>');
});

test('each line becomes its own block, joined without separators', () => {
  assert.strictEqual(mdToHtml('one\ntwo'), '<p>one</p><p>two</p>');
});

test('CRLF line endings split the same way as LF', () => {
  assert.strictEqual(mdToHtml('line\r\nline2'), mdToHtml('line\nline2'));
  assert.strictEqual(mdToHtml('# h\r\ntext'), '<h1>h</h1><p>text</p>');
});

test('a lone CR does not split a line', () => {
  // The split is /\r?\n/, so an old-Mac-style CR stays inside the paragraph text.
  assert.strictEqual(mdToHtml('a\rb'), '<p>a\rb</p>');
});

/* ---------- Whole documents ---------- */

test('a multi-line document of mixed content converts block by block', () => {
  const md = [
    '# Chapter One',
    '',
    'The **wind** rose over the *empty* moor.',
    '',
    '## Часть вторая',
    'Он сказал: 5 < 6 & always will be.',
    '',
    '### Note',
    '#not a heading',
  ].join('\n');
  assert.strictEqual(mdToHtml(md), [
    '<h1>Chapter One</h1>',
    '<p><br></p>',
    '<p>The <b>wind</b> rose over the <i>empty</i> moor.</p>',
    '<p><br></p>',
    '<h2>Часть вторая</h2>',
    '<p>Он сказал: 5 &lt; 6 &amp; always will be.</p>',
    '<p><br></p>',
    '<h3>Note</h3>',
    '<p>#not a heading</p>',
  ].join(''));
});

test('the output has exactly one block per input line', () => {
  const lines = ['# a', '', 'b', '**c**', '   ', '### d'];
  const out = mdToHtml(lines.join('\n'));
  const blocks = out.match(/<(?:p|h[123])>/g) || [];
  assert.strictEqual(blocks.length, lines.length);
});

test('conversion is deterministic', () => {
  const md = '# T\n**a** *b*\n\nc & d';
  assert.strictEqual(mdToHtml(md), mdToHtml(md));
});

/* ---------- Empty and missing input ---------- */

test('empty and missing input produce a single empty paragraph, without throwing', () => {
  // ''.split(/\r?\n/) is [''], and (md || '') maps null/undefined onto the same path.
  assert.strictEqual(mdToHtml(''), '<p><br></p>');
  assert.strictEqual(mdToHtml(null), '<p><br></p>');
  assert.strictEqual(mdToHtml(undefined), '<p><br></p>');
});

/* ---------- inlineMd() on its own ---------- */

test('inlineMd returns plain text unchanged and an empty string for empty input', () => {
  assert.strictEqual(inlineMd(''), '');
  assert.strictEqual(inlineMd('just words'), 'just words');
});

test('inlineMd does not add block markup', () => {
  // It only handles inline emphasis; hashes are just characters at this level.
  assert.strictEqual(inlineMd('# not a heading here'), '# not a heading here');
  assert.strictEqual(inlineMd('**b** and *i*'), '<b>b</b> and <i>i</i>');
});

test('inlineMd escapes before converting', () => {
  assert.strictEqual(inlineMd('a<b>c'), 'a&lt;b&gt;c');
  assert.strictEqual(inlineMd('**<i>**'), '<b>&lt;i&gt;</b>');
});
