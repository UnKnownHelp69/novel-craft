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
        ['<p style="text-align: center;">* * *</p>', '<p style="text-align: center;">* * *</p>'],
        ['<p align="center" dir="rtl">x</p><center>c</center>', '<p align="center" dir="rtl">x</p><center>c</center>'],
        ['<p><ruby>漢字<rt>かんじ</rt></ruby>を読む</p>', '<p><ruby>漢字<rt>かんじ</rt></ruby>を読む</p>'],
        ['<table><tr><td colspan="2" rowspan="x">c</td></tr></table>', '<table><tbody><tr><td colspan="2">c</td></tr></tbody></table>'],
        ['<span style="white-space: pre; color: #000;">\t</span>', '<span style="white-space: pre;">\t</span>'],
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

test('AltGr letters are typed, not taken as shortcuts; Ctrl+- is not Ctrl+/', async () => {
  const { page, close } = await appPage();
  try {
    await openNovel(page, await writeTempNovel('altgr.novel', plainNovel('<p>Текст</p>')));
    let downloads = 0, choosers = 0;
    page.on('download', () => downloads++);
    page.on('filechooser', () => choosers++);
    // Windows reports AltGr as Ctrl+Alt; dispatch on the editor like a real keystroke would.
    const prevented = await page.evaluate(() => [['ś', 'KeyS'], ['Ś', 'KeyS'], ['ó', 'KeyO'], ['ģ', 'KeyG'], ['ß', 'KeyS']].map(([key, code]) =>
      !document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown',
        { key, code, ctrlKey: true, altKey: true, shiftKey: key === 'Ś', bubbles: true, cancelable: true }))));
    await page.waitForTimeout(500);
    assert.deepStrictEqual(prevented, [false, false, false, false, false], 'AltGr keystrokes must not be swallowed');
    assert.strictEqual(downloads + choosers, 0, 'AltGr+S/O must not save or open');
    assert.strictEqual(await page.evaluate(() => document.getElementById('graphOverlay').classList.contains('hidden')), true, 'AltGr+G');
    const toggled = await page.evaluate(() => ['-', '!'].map(key => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Slash', ctrlKey: true, bubbles: true }));
      return document.getElementById('rightPanel').classList.contains('collapsed');
    }));
    assert.deepStrictEqual(toggled, [false, false], 'Ctrl+- / Ctrl+! must not toggle the tools panel');
  } finally { await close(); }
});

test('pasting a copied image keeps the bitmap; an empty paste keeps the selection', async () => {
  const { page, close } = await appPage();
  try {
    await openNovel(page, await writeTempNovel('pimg.novel', plainNovel('<p>Портрет: [сюда] конец.</p>')));
    const selectMarker = () => page.evaluate(() => {
      const ed = document.getElementById('editor');
      const t = ed.querySelector('p').firstChild, i = t.data.indexOf('[сюда]');
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 6);
      ed.focus(); getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    // a clipboard with nothing usable must not delete the selected text
    await selectMarker();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<img src="https://example.com/x.png">');
      document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    assert.match(await page.evaluate(() => document.getElementById('editor').innerHTML), /\[сюда\]/);
    // "Copy image": remote <img> in the HTML plus the bitmap itself
    await selectMarker();
    await page.evaluate(async () => {
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.setData('text/html', '<img src="https://example.com/portrait.png">');
      dt.items.add(new File([png], 'image.png', { type: 'image/png' }));
      document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.getElementById('editor').querySelector('img'));
    const html = await page.evaluate(() => document.getElementById('editor').innerHTML);
    assert.match(html, /<img src="data:image\/png;base64,/);
    assert.doesNotMatch(html, /example\.com|\[сюда\]/);
  } finally { await close(); }
});

test('an HTML paste with nothing readable left falls back to its plain text', async () => {
  const { page, close } = await appPage();
  try {
    await openNovel(page, await writeTempNovel('pplain.novel', plainNovel('<p>Формула: [здесь] конец.</p>')));
    const pasteOver = (html, text) => page.evaluate(([html, text]) => {
      const ed = document.getElementById('editor');
      const t = ed.querySelector('p').firstChild, i = t.data.indexOf('[здесь]');
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 7);
      ed.focus(); getSelection().removeAllRanges(); getSelection().addRange(r);
      const dt = new DataTransfer();
      dt.setData('text/html', html); dt.setData('text/plain', text);
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      const out = ed.innerHTML;
      ed.innerHTML = '<p>Формула: [здесь] конец.</p>';
      return out;
    }, [html, text]);
    // an emoji rendered as a remote <img alt> (VK, Discord…): only text/plain carries it
    assert.match(await pasteOver('<img src="https://cdn.example/1f602.png" alt="😂">', '😂'), /Формула: 😂 конец\./);
    // a display formula from Wikipedia sanitizes to bare structure; its text must win
    assert.match(await pasteOver('<dl><dd><span class="mwe-math-element"><img src="https://wiki.example/f.svg" alt="E=mc^2"></span></dd></dl><br class="Apple-interchange-newline">', 'E=mc^2'),
      /Формула: E=mc\^2 конец\./);
  } finally { await close(); }
});

test('word counts ignore a hyphen typed as a dash', async () => {
  const { page, close } = await appPage();
  try {
    // wordCount 7 is what earlier versions stored for this text (they counted each " - ")
    const n = plainNovel('<p>Он сказал - нет - и ушёл.</p>');
    n.chapters[0].scenes[0].wordCount = 7;
    await openNovel(page, await writeTempNovel('wc.novel', n));
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

test('at the minimum window width the save indicator stays visible', async () => {
  const { page, close } = await appPage();
  try {
    await page.setViewportSize({ width: 1100, height: 600 });
    const m = await page.evaluate(() => {
      document.getElementById('winControls').style.display = 'flex';   // as in the desktop app
      setCurrentNovel({ title: 'Война и мир. Том первый', chapters: [{ title: 'Глава', scenes: [{ title: 'Сцена', content: '<p>x</p>' }] }] },
        '/novels/Война и мир — черновик 3.novel');
      const ind = document.getElementById('saveIndicator').getBoundingClientRect();
      const center = document.querySelector('.topbar-center').getBoundingClientRect();
      const tall = [...document.querySelectorAll('.topbar-right .tbtn')].filter(b => b.getBoundingClientRect().height > 32).length;
      return { visible: Math.min(ind.right, center.right) - Math.max(ind.left, center.left), tall };
    });
    assert.ok(m.visible >= 40, `save indicator visible width ${m.visible}px`);
    assert.strictEqual(m.tall, 0, 'top-bar buttons must not wrap');
  } finally { await close(); }
});
