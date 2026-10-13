/* Browser-mode regression suite: the real app (src/index.html) in Chromium, driven by
 * playwright-core. Run with `npm run test:e2e`.
 *
 * Covers what the node unit tests cannot: the DOM side of the HTML sanitizer, the editor's
 * paste and keyboard handling, typing speed on a long scene, and the app running under the
 * same Content-Security-Policy as the desktop build (read from tauri.conf.json).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { launchChromium, serveApp, writeTempNovel, openNovel, craftedNovel } from './support.mjs';

let browser;
test.before(async () => { browser = await launchChromium(); });
test.after(async () => { if (browser) await browser.close(); });

async function appPage({ csp = false } = {}) {
  const server = await serveApp({ csp });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(server.url);
  await page.waitForFunction(() => typeof window.setCurrentNovel === 'function');
  return { page, errors, close: async () => { await context.close(); await server.close(); } };
}

const plainNovel = (content, extra = {}) => ({
  version: '1.0', title: 'Тест',
  chapters: [{ id: 'c1', title: 'Глава 1', scenes: [{ id: 's1', title: 'Сцена 1', content, notes: [] }] }],
  characters: [{ id: 'a', name: 'Анна' }, { id: 'b', name: 'Борис' }], locations: [{ id: 'l', name: 'Город' }], races: [],
  ...extra
});

test('a crafted .novel cannot run script anywhere its data is rendered', async () => {
  const { page, close } = await appPage();   // no CSP: the sanitizer and escaping alone must hold
  try {
    await openNovel(page, await writeTempNovel('crafted.novel', craftedNovel()));
    // visit every view that renders file data
    await page.evaluate(() => {
      document.querySelectorAll('.accordion').forEach(a => a.classList.add('open'));
      openNoteCard('n1');
      openCompile(); loadPreset(novel.settings.compilationPresets[0].id); compPreview = true; renderComp(); closeCompile();
      openGraph(); openCharPanel(novel.characters[0]); closeGraph();
      toggleCorkboard(); toggleCorkboard();
      toggleMarkdownMode(); toggleMarkdownMode();
    });
    await page.waitForTimeout(800);
    const state = await page.evaluate(() => ({
      pwn: window.__pwn || null,
      editor: document.getElementById('editor').innerHTML,
      wordCount: novel.chapters[0].scenes[0].wordCount,
      exported: buildExport('html', novel),
      bodyDisplay: getComputedStyle(document.body).display
    }));
    assert.strictEqual(state.pwn, null, 'payloads ran: ' + JSON.stringify(state.pwn));
    assert.match(state.editor, /<b>жирный<\/b>/, 'formatting must survive');
    assert.doesNotMatch(state.editor, /onerror|<svg|<math|<script|<noscript|<style|<iframe|javascript:/i);
    assert.strictEqual(state.wordCount, 5, 'a word count from the file must be recounted');
    assert.doesNotMatch(state.exported, /onerror|javascript:|<script/i, 'HTML export must be sanitized too');
    assert.notStrictEqual(state.bodyDisplay, 'none');
  } finally { await close(); }
});

test('the sanitizer keeps editor formatting, strips the rest, and is idempotent', async () => {
  const { page, close } = await appPage();
  try {
    const res = await page.evaluate(() => {
      const cases = [
        ['<p>a <b>b</b> <i>i</i> <u>u</u> <s>s</s></p>', '<p>a <b>b</b> <i>i</i> <u>u</u> <s>s</s></p>'],
        ['<h1>T</h1><h2>S</h2><h3>s</h3><p><br></p>', '<h1>T</h1><h2>S</h2><h3>s</h3><p><br></p>'],
        ['<p><font face="\'Lora\', serif">f</font></p>', '<p><font face="\'Lora\', serif">f</font></p>'],
        ['<div>line</div><div><br></div>', '<div>line</div><div><br></div>'],
        ['<ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote>', '<ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote>'],
        ['<p class="MsoNormal" style="color:red;font-weight:bold">x</p>', '<p style="font-weight: bold;">x</p>'],
        ['<span style="font-family: Lora, serif; background: url(https://t/x)">y</span>', '<span style="font-family: Lora, serif;">y</span>'],
        ['<p>a<a href="https://x">link</a><o:p></o:p></p>', '<p>alink</p>'],
        ['<p>x<img src="https://tracker/p.gif">y</p>', '<p>xy</p>'],
        ['<p><img src="data:image/png;base64,iVBORw0KGgo=" onerror="1" alt="m"></p>', '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="m"></p>'],
        ['<table><tr><td>c</td></tr></table>', '<table><tbody><tr><td>c</td></tr></tbody></table>'],
        ['<!-- c --><p>t</p>', '<p>t</p>'],
        ['<title>t</title><meta charset="x"><p>k</p>', '<p>k</p>'],
        ['', ''], ['plain text', 'plain text'], ['a &lt;b&gt; c', 'a &lt;b&gt; c']
      ];
      const nasty = [
        '<p><button><p>x</p></button></p>', '<noscript><p title="</noscript><img src=x onerror=1>"></p></noscript>',
        '<svg><p><style><img src=x onerror=1></style></p></svg>', '<form><math><mtext></form><form><mglyph><style></math><img src onerror=1>',
        '<a><table><a>x</a></table></a>', '<p>a<div>b</div>c</p>', '<template><img src=x onerror=1></template>', '</div></div><img src=x onerror=1>'
      ];
      return {
        cases: cases.map(([i, want]) => ({ i, want, got: sanitizeSceneHTML(i) })),
        idem: [...cases.map(c => c[0]), ...nasty].map(i => { const once = sanitizeSceneHTML(i); return { i, once, twice: sanitizeSceneHTML(once) }; }),
        nasty: nasty.map(i => sanitizeSceneHTML(i))
      };
    });
    for (const c of res.cases) assert.strictEqual(c.got, c.want, `sanitize(${c.i})`);
    for (const c of res.idem) assert.strictEqual(c.twice, c.once, `not idempotent: ${c.i}`);
    for (const out of res.nasty) assert.doesNotMatch(out, /onerror|<img|<style|<svg|<math|<template/i, out);
    await page.waitForTimeout(300);
    assert.strictEqual(await page.evaluate(() => window.__pwn || null), null);
  } finally { await close(); }
});

test('pasted HTML is cleaned before it reaches the scene', async () => {
  const { page, close } = await appPage();
  try {
    await openNovel(page, await writeTempNovel('paste.novel', plainNovel('<p>Начало</p>')));
    const html = await page.evaluate(() => {
      const ed = document.getElementById('editor');
      ed.focus();
      getSelection().selectAllChildren(ed); getSelection().collapseToEnd();
      const dt = new DataTransfer();
      dt.setData('text/html', '<html><body><!--StartFragment--><p class="MsoNormal" style="color:red"><span lang="RU">Вставка <b>жирная</b></span><a href="https://x">ссылка</a></p><img src="https://t/p.gif" onerror="window.__pwn=1"><!--EndFragment--></body></html>');
      dt.setData('text/plain', 'Вставка жирная ссылка');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return ed.innerHTML;
    });
    assert.match(html, /Вставка/);
    assert.match(html, /<b>жирная<\/b>/);
    assert.doesNotMatch(html, /MsoNormal|lang=|href=|<img|color/i, html);
    assert.strictEqual(await page.evaluate(() => window.__pwn || null), null);
    assert.strictEqual(await page.evaluate(() => document.getElementById('saveIndicator').textContent), 'Unsaved');
  } finally { await close(); }
});

test('shortcuts work on a Russian keyboard layout', async () => {
  const { page, close } = await appPage();
  try {
    await openNovel(page, await writeTempNovel('keys.novel', plainNovel('<p>Текст</p>')));
    const press = (key, code, opts = {}) => page.evaluate(([key, code, opts]) =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true, ...opts })), [key, code, opts]);
    // Ctrl+S → browser-mode save is a download
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), press('ы', 'KeyS')]);
    assert.strictEqual(JSON.parse(await readFile(await download.path(), 'utf8')).title, 'Тест', 'Ctrl+S');
    // Ctrl+G → character graph
    await press('п', 'KeyG');
    assert.strictEqual(await page.evaluate(() => !document.getElementById('graphOverlay').classList.contains('hidden')), true, 'Ctrl+G');
    await page.evaluate(() => closeGraph());
    // Ctrl+\ and Ctrl+/ (the '/' key types '.' on a Russian layout) → panels
    await press('\\', 'Backslash');
    assert.strictEqual(await page.evaluate(() => document.getElementById('leftPanel').classList.contains('collapsed')), true, 'Ctrl+\\');
    await press('.', 'Slash');
    assert.strictEqual(await page.evaluate(() => document.getElementById('rightPanel').classList.contains('collapsed')), true, 'Ctrl+/');
    // Ctrl+Shift+F → focus mode
    await press('А', 'KeyF', { shiftKey: true });
    assert.strictEqual(await page.evaluate(() => document.body.classList.contains('focus')), true, 'Ctrl+Shift+F');
  } finally { await close(); }
});

test('word counts ignore a hyphen typed as a dash', async () => {
  const { page, close } = await appPage();
  try {
    await openNovel(page, await writeTempNovel('wc.novel', plainNovel('<p>Он сказал - нет - и ушёл.</p>')));
    assert.strictEqual(await page.textContent('#statChapWords'), '5');
    assert.strictEqual(await page.textContent('.ts-words'), '5');
  } finally { await close(); }
});

test('typing stays responsive in a 30,000-word scene', async () => {
  const { page, close } = await appPage();
  try {
    const para = '<p>Он шёл по дороге и думал о том, что завтра всё будет иначе, и ветер шумел в листве.</p>';
    await openNovel(page, await writeTempNovel('long.novel', plainNovel(para.repeat(1900))));
    const median = await page.evaluate(() => {
      const ed = document.getElementById('editor');
      const times = [];
      for (let i = 0; i < 15; i++) {
        ed.lastElementChild.append(document.createTextNode('а'));
        const t0 = performance.now();
        ed.dispatchEvent(new Event('input'));
        times.push(performance.now() - t0);
      }
      return times.sort((a, b) => a - b)[7];
    });
    // ~400 ms before the stripHtml fix; tens of milliseconds after. Generous for slow CI.
    assert.ok(median < 150, `input handler median ${median.toFixed(1)} ms on a 30k-word scene`);
  } finally { await close(); }
});

test('the app runs under the desktop CSP without violations', async () => {
  const { page, errors, close } = await appPage({ csp: true });
  try {
    await openNovel(page, await writeTempNovel('csp.novel', plainNovel('<p>Привет, <b>мир</b> — <i>тест</i>.</p><h2>Заголовок</h2><p><font face="Georgia, serif">шрифт</font></p>', {
      settings: { customNoteTypes: [{ id: 'x', name: 'Своя', color: '#336699', icon: '★' }] }
    })));
    await page.evaluate(() => {
      document.querySelectorAll('.accordion').forEach(a => a.classList.add('open'));
      const ed = document.getElementById('editor');
      openAddNote({ start: 0, end: 6, text: 'Привет', rect: ed.getBoundingClientRect() });
      document.getElementById('npContent').value = 'заметка';
      confirmAddNote();
      openNoteCard(currentScene().notes[0].id);
      toggleCorkboard(); toggleCorkboard();
      openGraph(); closeGraph();
      openMap(); closeMap();
      openCompile(); compPreview = true; renderComp();
    });
    const signature = { pdf: '%PDF-', epub: 'PK', docx: 'PK', html: '<!DOCTYPE html>', txt: 'ТЕСТ' };
    for (const [kind, head] of Object.entries(signature)) {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.evaluate(k => doCompExport(k), kind)]);
      const bytes = await readFile(await download.path());
      assert.strictEqual(bytes.subarray(0, Buffer.byteLength(head)).toString('utf8'), head, kind + ' export');
    }
    const state = await page.evaluate(() => ({
      violations: window.__csp,
      highlightRules: document.getElementById('noteHiliteStyles').sheet.cssRules.length,
      badgeColor: getComputedStyle(document.querySelector('.note-badge')).getPropertyValue('--nc').trim()
    }));
    assert.deepStrictEqual(state.violations, [], 'CSP violations: ' + JSON.stringify(state.violations));
    assert.ok(state.highlightRules > 0, 'injected <style> rules must apply');
    assert.notStrictEqual(state.badgeColor, '', 'style attributes must apply');
    assert.deepStrictEqual(errors, []);
  } finally { await close(); }
});
