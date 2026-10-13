/* UI-flow regression suite: the real app (src/index.html, under the desktop CSP) in Chromium,
 * driven the way a user drives it. Run with
 *   node --test e2e/flows.e2e.mjs
 *
 * A safety net for refactoring src/app.js: every test is black-box. It seeds a novel by
 * opening a .novel fixture through the app's own Open flow, acts through clicks, double-clicks,
 * context menus, real keystrokes and pointer drags, and observes only the DOM and the files the
 * app hands out (a browser-mode Save downloads the .novel JSON, which is the main oracle).
 * Nothing here reads or calls the app's globals, so the suite must keep passing unchanged once
 * the script becomes ES modules.
 *
 * Tests marked { todo: 'bug: …' } assert the correct behaviour of something that is broken
 * today; node:test runs them and reports them without failing the run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { launchChromium, serveApp, writeTempNovel, openNovel } from './support.mjs';

/* Chromium on Linux names a download in the locale's charset: under a POSIX/C locale a Cyrillic
   name ("Роман.novel") comes out as "download". Run the browser under a UTF-8 locale. */
if (!/utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '')) process.env.LC_ALL = 'C.UTF-8';

let browser;
test.before(async () => { browser = await launchChromium(); });
test.after(async () => { if (browser) await browser.close(); });

/* ------------------------------------------------------------------ harness */

async function appPage() {
  const server = await serveApp({ csp: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(server.url);
  await appReady(page);
  return { page, errors, close: async () => { await context.close(); await server.close(); } };
}
/* The app has started once its start screen (the empty state) is up. */
const appReady = page => page.locator('#emptyState').waitFor({ state: 'visible' });

/* One test = one fresh page; every flow also has to run without page errors or CSP violations. */
function flow(name, fn, opts = {}) {
  test(name, opts, async () => {
    const app = await appPage();
    try {
      await fn(app.page, app);
      assert.deepStrictEqual(app.errors, [], 'page errors');
      assert.deepStrictEqual(await app.page.evaluate(() => window.__csp), [], 'CSP violations');
    } finally { await app.close(); }
  });
}

/* Poll a reader until it returns `expected` (deep equality), else fail with the last value. */
async function eventually(read, expected, msg, timeout = 5000) {
  const t0 = Date.now();
  let actual;
  for (;;) {
    actual = await read();
    if (isDeepStrictEqual(actual, expected)) return;
    if (Date.now() - t0 > timeout) break;
    await new Promise(r => setTimeout(r, 40));
  }
  assert.deepStrictEqual(actual, expected, msg);
}
const textOf = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; }, sel);
const expectText = (page, sel, expected, msg) => eventually(() => textOf(page, sel), expected, msg || sel);
const indicator = page => textOf(page, '#saveIndicator');
const expectIndicator = (page, v) => eventually(() => indicator(page), v, 'save indicator');
const isShown = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && r.width > 0 && r.height > 0;
}, sel);
const expectShown = (page, sel, v = true) => eventually(() => isShown(page, sel), v, `${sel} ${v ? 'shown' : 'hidden'}`);

/* ------------------------------------------------------------------ fixtures */

const sc = (id, title, content = '', extra = {}) => ({ id, title, content, notes: [], ...extra });
const ch = (id, title, ...scenes) => ({ id, title, scenes });
const novelOf = (chapters, extra = {}) => ({
  version: '1.0', title: 'Роман', chapters, characters: [], locations: [], races: [], ...extra
});
async function openFixture(page, novel, name = 'fixture.novel') {
  await openNovel(page, await writeTempNovel(name, novel));
  await expectIndicator(page, 'Saved');
}

/* ------------------------------------------------------------------ files */

async function readDownload(download) { return readFile(await download.path(), 'utf8'); }
async function downloadOf(page, action) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), action()]);
  return { name: download.suggestedFilename(), text: await readDownload(download) };
}
/* Save (Ctrl+S by default, or the top-bar button) and return the parsed .novel. */
async function save(page, how = 'shortcut') {
  const { name, text } = await downloadOf(page, () => how === 'button' ? page.click('#btnSave') : page.keyboard.press('Control+s'));
  await expectIndicator(page, 'Saved');
  return { name, data: JSON.parse(text) };
}
const scenesOf = data => data.chapters.flatMap(c => c.scenes);
const sceneIn = (data, title) => {
  const s = scenesOf(data).find(x => x.title === title);
  assert.ok(s, `scene "${title}" missing from the saved file`);
  return s;
};
const outline = data => data.chapters.map(c => [c.title, c.scenes.map(s => s.title)]);

/* ------------------------------------------------------------------ tree */

const sceneRow = (page, title) => page.locator(`#chapterList .tree-scene:has(.ts-title:text-is("${title}"))`);
const chapterRow = (page, title) => page.locator(`#chapterList .tc-row:has(.tc-title:text-is("${title}"))`);
const treeOutline = page => page.evaluate(() => [...document.querySelectorAll('#chapterList .tree-chapter')].map(c => [
  c.querySelector('.tc-title').textContent, [...c.querySelectorAll('.tree-scene .ts-title')].map(s => s.textContent)
]));
const treeNumbers = page => page.evaluate(() => [...document.querySelectorAll('#chapterList .tc-num')].map(n => n.textContent));
const activeScene = page => textOf(page, '#chapterList .tree-scene.active .ts-title');
const breadcrumb = page => page.evaluate(() => [...document.querySelectorAll('#breadcrumb .bc-part')].map(b => b.textContent));
async function openSceneFromTree(page, title) {
  await sceneRow(page, title).click();
  await eventually(() => activeScene(page), title, 'active scene');
}
async function contextMenu(page, row, item) {
  await row.click({ button: 'right' });
  await expectShown(page, '#ctxMenu');
  await page.locator('#ctxMenu > button', { hasText: new RegExp(`^${item}$`) }).click();
}

/* ------------------------------------------------------------------ editor */

const editorText = page => page.evaluate(() => document.getElementById('editor').innerText.trim());
const editorHTML = page => page.evaluate(() => document.getElementById('editor').innerHTML);
async function typeAtEnd(page, text) {
  await page.click('#editor');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}
/* Select `text` in the editor with a mouse drag across its glyphs (single line). */
async function selectInEditor(page, text) {
  const r = await page.evaluate(t => {
    const ed = document.getElementById('editor');
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      const i = n.data.indexOf(t);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i); range.setEnd(n, i + t.length);
      const rects = range.getClientRects(), a = rects[0], b = rects[rects.length - 1];
      return { x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 };
    }
    return null;
  }, text);
  assert.ok(r, `"${text}" is not in the editor`);
  await page.mouse.move(r.x1 + 1, r.y1);
  await page.mouse.down();
  await page.mouse.move(r.x2 - 1, r.y2, { steps: 6 });
  await page.mouse.up();
  await eventually(() => page.evaluate(() => getSelection().toString()), text, 'editor selection');
  return { x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 };
}

/* ------------------------------------------------------------------ modals */

async function answerPrompt(page, value, title) {
  await expectShown(page, '#modalOverlay');
  if (title) await expectText(page, '#modalTitle', title);
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'modalInput');
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await expectShown(page, '#modalOverlay', false);
}
async function confirmModal(page, title) {
  await expectShown(page, '#modalOverlay');
  if (title) await expectText(page, '#modalTitle', title);
  await page.click('#modalOk');
  await expectShown(page, '#modalOverlay', false);
}
async function openAccordion(page, key) {
  const acc = page.locator(`#rightPanel .accordion[data-acc="${key}"]`);
  if (!(await acc.evaluate(a => a.classList.contains('open')))) await acc.locator('.acc-head').click();
  await eventually(() => acc.evaluate(a => getComputedStyle(a.querySelector('.acc-body')).display !== 'none'), true, `accordion ${key} open`);
  return acc;
}
/* The form control right after a field label inside `scope` (entity cards, panels). */
const fieldAfter = (scope, label) => scope.locator(`xpath=.//label[normalize-space(.)="${label}"]/following-sibling::*[1]`);

/* ------------------------------------------------------------------ drags */

const pt = (box, fy = 0.5, fx = 0.5) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + (to.y > from.y ? 8 : -8), { steps: 2 });   // past the 5px threshold
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/* ================================================================== flows */

flow('typing persists across scene switches; the save indicator tracks edits and saves', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава 1', sc('a', 'Сцена A'), sc('b', 'Сцена B'))]));
  assert.equal(await indicator(page), 'Saved', 'a freshly opened file is saved');
  assert.equal(await activeScene(page), 'Сцена A');

  // switching scenes without editing is not an edit
  await openSceneFromTree(page, 'Сцена B');
  await openSceneFromTree(page, 'Сцена A');
  assert.equal(await indicator(page), 'Saved', 'switching scenes must not mark the novel dirty');

  await typeAtEnd(page, 'Первый текст, first.');
  await expectIndicator(page, 'Unsaved');
  await openSceneFromTree(page, 'Сцена B');
  assert.equal(await editorText(page), '', 'scene B starts empty');
  await expectText(page, '#breadcrumb .bc-scene', 'Сцена B');
  await typeAtEnd(page, 'Второй текст');
  await openSceneFromTree(page, 'Сцена A');
  assert.equal(await editorText(page), 'Первый текст, first.');
  await openSceneFromTree(page, 'Сцена B');
  assert.equal(await editorText(page), 'Второй текст');
  assert.equal(await indicator(page), 'Unsaved');

  const { name, data } = await save(page);
  assert.equal(name, 'Роман.novel');
  assert.match(sceneIn(data, 'Сцена A').content, /Первый текст, first\./);
  assert.match(sceneIn(data, 'Сцена B').content, /Второй текст/);
  assert.equal(sceneIn(data, 'Сцена A').wordCount, 3);
  assert.equal(sceneIn(data, 'Сцена B').wordCount, 2);
  // each scene's Markdown twin (what Markdown mode loads) is saved current too
  assert.match(sceneIn(data, 'Сцена A').markdownContent, /Первый текст, first\./, 'switched-away scene markdownContent');
  assert.match(sceneIn(data, 'Сцена B').markdownContent, /Второй текст/, 'open scene markdownContent');

  // an edit after the save is unsaved again; the button saves as well
  await typeAtEnd(page, ' ещё');
  await expectIndicator(page, 'Unsaved');
  const again = await save(page, 'button');
  assert.match(sceneIn(again.data, 'Сцена B').content, /Второй текст ещё/);
  assert.match(sceneIn(again.data, 'Сцена B').markdownContent, /Второй текст ещё/, 'the open scene is flushed into the save');
});

flow('Markdown mode: source typed in one scene survives a scene switch and saves as HTML', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('a', 'Сцена A', '<p>Альфа</p>'), sc('b', 'Сцена B', '<p>Бета</p>'))]));
  const source = () => page.inputValue('#mdEditor');
  async function typeSource(text) {
    await page.click('#mdEditor');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(text);
  }
  await page.click('#btnMarkdownMode');
  await expectShown(page, '#mdEditor');
  assert.equal(await source(), 'Альфа');
  assert.equal(await indicator(page), 'Saved', 'switching to the source view is not an edit');

  await typeSource('\n\nНовый **жирный** абзац');
  await expectIndicator(page, 'Unsaved');
  // the next scene opens in the source view as well
  await openSceneFromTree(page, 'Сцена B');
  await eventually(source, 'Бета', 'scene B source');
  await typeSource('\n\nЕщё *курсив*');

  // saved while still in the source view: the scene switched away from and the open one are
  // both stored as HTML (and as Markdown)
  const { data } = await save(page);
  const a = sceneIn(data, 'Сцена A'), b = sceneIn(data, 'Сцена B');
  assert.match(a.content, /Новый <b>жирный<\/b> абзац/, 'switched-away scene content');
  assert.match(b.content, /Ещё <i>курсив<\/i>/, 'open scene content');
  assert.match(a.markdownContent, /Новый \*\*жирный\*\* абзац/);
  assert.match(b.markdownContent, /Ещё \*курсив\*/);
  assert.deepEqual([a.wordCount, b.wordCount], [4, 3]);

  // both sources come back on a switch, which is not an edit
  await openSceneFromTree(page, 'Сцена A');
  await eventually(source, 'Альфа\n\nНовый **жирный** абзац', 'scene A source kept');
  await openSceneFromTree(page, 'Сцена B');
  await eventually(source, 'Бета\n\nЕщё *курсив*', 'scene B source kept');
  assert.equal(await indicator(page), 'Saved', 'scene switches in the source view are not edits');
  // and the visual editor shows the formatting
  await page.click('#btnMarkdownMode');
  await expectShown(page, '#editor');
  assert.match(await editorHTML(page), /Ещё <i>курсив<\/i>/);
  assert.equal(await indicator(page), 'Saved');
});

flow('opening another novel over unsaved work asks first', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s', 'Сцена', '<p>Старый</p>'))]));
  await typeAtEnd(page, ' черновик');
  await expectIndicator(page, 'Unsaved');
  await page.keyboard.press('Control+o');
  await expectShown(page, '#modalOverlay');
  await expectText(page, '#modalTitle', 'Unsaved changes');
  await page.click('#modalCancel');
  await expectShown(page, '#modalOverlay', false);
  assert.equal(await editorText(page), 'Старый черновик', 'Cancel keeps the open novel');

  const file = await writeTempNovel('other.novel', novelOf([ch('c9', 'Другая глава', sc('z', 'Другая сцена', '<p>Новый</p>'))], { title: 'Другой' }));
  await page.click('#btnOpen');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), confirmModal(page, 'Unsaved changes')]);
  await chooser.setFiles(file);
  await eventually(() => editorText(page), 'Новый', 'the other novel is open');
  await expectText(page, '#novelTitle', 'Другой');
  await expectIndicator(page, 'Saved');
});

flow('a new novel from the start screen can be written and saved', async page => {
  await page.click('#esNew');
  await expectShown(page, '#emptyState', false);
  await expectText(page, '#novelTitle', 'Untitled Novel');
  assert.deepEqual(await treeOutline(page), [['Chapter 1', ['Scene 1']]]);
  assert.deepEqual(await breadcrumb(page), ['Untitled Novel', 'Chapter 1', 'Scene 1']);
  await typeAtEnd(page, 'Hello, мир');
  await expectIndicator(page, 'Unsaved');
  const { name, data } = await save(page);
  assert.equal(name, 'Untitled Novel.novel');
  assert.equal(data.title, 'Untitled Novel');
  assert.match(data.chapters[0].scenes[0].content, /Hello, мир/);
});

flow('chapters and scenes: add, rename, numbering, breadcrumb, saved order', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава 1', sc('s1', 'Начало', '<p>Текст</p>'))]));
  assert.deepEqual(await treeNumbers(page), ['1.']);

  // top "+" adds a chapter (with its first scene) and opens it
  await page.click('#btnAddChapter');
  await eventually(() => treeOutline(page), [['Глава 1', ['Начало']], ['Chapter 2', ['Scene 1']]], 'after add chapter');
  assert.deepEqual(await treeNumbers(page), ['1.', '2.']);
  assert.deepEqual(await breadcrumb(page), ['Роман', 'Chapter 2', 'Scene 1']);
  assert.equal(await activeScene(page), 'Scene 1');
  await expectIndicator(page, 'Unsaved');

  // chapter-row "+" adds a scene to that chapter
  await chapterRow(page, 'Chapter 2').hover();
  await chapterRow(page, 'Chapter 2').locator('.tc-add').click();
  await eventually(() => treeOutline(page), [['Глава 1', ['Начало']], ['Chapter 2', ['Scene 1', 'Scene 2']]], 'after row +');
  assert.deepEqual(await breadcrumb(page), ['Роман', 'Chapter 2', 'Scene 2']);

  // context menu "Add Scene" on another chapter
  await contextMenu(page, chapterRow(page, 'Глава 1'), 'Add Scene');
  await eventually(() => treeOutline(page), [['Глава 1', ['Начало', 'Scene 2']], ['Chapter 2', ['Scene 1', 'Scene 2']]], 'after ctx Add Scene');
  assert.deepEqual(await breadcrumb(page), ['Роман', 'Глава 1', 'Scene 2']);

  // rename a scene by double-click -> prompt -> Enter
  await sceneRow(page, 'Scene 2').first().dblclick();
  await answerPrompt(page, 'Развязка', 'Rename scene');
  await eventually(() => treeOutline(page), [['Глава 1', ['Начало', 'Развязка']], ['Chapter 2', ['Scene 1', 'Scene 2']]], 'after scene rename');
  assert.deepEqual(await breadcrumb(page), ['Роман', 'Глава 1', 'Развязка']);

  // rename a chapter through its context menu
  await contextMenu(page, chapterRow(page, 'Chapter 2'), 'Rename');
  await answerPrompt(page, 'Глава 2', 'Rename chapter');
  await eventually(() => treeOutline(page), [['Глава 1', ['Начало', 'Развязка']], ['Глава 2', ['Scene 1', 'Scene 2']]], 'after chapter rename');

  // the breadcrumb's scene part renames the open scene too
  await page.click('#breadcrumb .bc-scene');
  await answerPrompt(page, 'Финал', 'Rename scene');
  await eventually(() => breadcrumb(page), ['Роман', 'Глава 1', 'Финал'], 'breadcrumb after rename');

  // save here, so the title rename below has to mark the novel unsaved on its own
  const mid = await save(page);
  assert.equal(mid.name, 'Роман.novel');
  assert.deepEqual(outline(mid.data), [['Глава 1', ['Начало', 'Финал']], ['Глава 2', ['Scene 1', 'Scene 2']]]);
  // confirming the title unchanged is not an edit
  await page.dblclick('#novelTitle');
  await page.keyboard.press('Enter');
  await expectText(page, '#novelTitle', 'Роман');
  assert.equal(await indicator(page), 'Saved', 'an unchanged novel title is not an edit');

  // the novel title is renamed in place in the top bar
  await page.dblclick('#novelTitle');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Сага');
  await page.keyboard.press('Enter');
  await expectText(page, '#novelTitle', 'Сага');
  await eventually(() => indicator(page), 'Unsaved', 'a novel title rename alone marks the novel unsaved');
  await eventually(() => page.title(), 'NovelCraft — Сага', 'window title after novel rename');

  const { name, data } = await save(page);
  assert.equal(name, 'Сага.novel');
  assert.equal(data.title, 'Сага');
  assert.deepEqual(outline(data), [['Глава 1', ['Начало', 'Финал']], ['Глава 2', ['Scene 1', 'Scene 2']]]);
  assert.deepEqual(data.chapters.map(c => c.order), [0, 1]);
  assert.deepEqual(data.chapters[1].scenes.map(s => s.order), [0, 1]);
  assert.match(sceneIn(data, 'Начало').content, /Текст/);
});

flow('renaming the novel in the top bar updates the breadcrumb', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава 1', sc('s1', 'Сцена'))]));
  await page.dblclick('#novelTitle');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Сага');
  await page.keyboard.press('Enter');
  await expectText(page, '#novelTitle', 'Сага');
  await eventually(() => breadcrumb(page), ['Сага', 'Глава 1', 'Сцена'], 'breadcrumb after novel rename');
}, { todo: 'bug: commitNovelTitle() never calls updateBreadcrumb(), so the breadcrumb keeps the old novel title until the next scene switch' });

flow('double-clicking a chapter row renames the chapter', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава 1', sc('s1', 'Сцена'))]));
  await chapterRow(page, 'Глава 1').dblclick();
  await answerPrompt(page, 'Пролог', 'Rename chapter');
  await eventually(() => treeOutline(page), [['Пролог', ['Сцена']]], 'tree after chapter rename');
  assert.deepEqual(await breadcrumb(page), ['Роман', 'Пролог', 'Сцена']);
  const { data } = await save(page);
  assert.equal(data.chapters[0].title, 'Пролог');
}, { todo: 'bug: each click on a chapter row re-renders the tree (collapse toggle on mouseup), so the dblclick lands on a detached node and the rename prompt never opens' });

flow('pointer drags reorder scenes and chapters in the tree', async page => {
  await openFixture(page, novelOf([
    ch('c1', 'Один', sc('s1', 'S1', '<p>Первая сцена</p>'), sc('s2', 'S2'), sc('s3', 'S3')),
    ch('c2', 'Два', sc('t1', 'T1'), sc('t2', 'T2'))
  ]));
  const box = async loc => loc.boundingBox();

  // scene above another scene
  await drag(page, pt(await box(sceneRow(page, 'S3'))), pt(await box(sceneRow(page, 'S1')), 0.25));
  await eventually(() => treeOutline(page), [['Один', ['S3', 'S1', 'S2']], ['Два', ['T1', 'T2']]], 'S3 dropped above S1');
  await expectIndicator(page, 'Unsaved');

  // scene onto another chapter's row: moves into that chapter (appended)
  await drag(page, pt(await box(sceneRow(page, 'S1'))), pt(await box(chapterRow(page, 'Два'))));
  await eventually(() => treeOutline(page), [['Один', ['S3', 'S2']], ['Два', ['T1', 'T2', 'S1']]], 'S1 dropped into Два');
  // the open scene stays open and follows its chapter
  assert.equal(await activeScene(page), 'S1');
  assert.equal(await editorText(page), 'Первая сцена');
  assert.deepEqual(await breadcrumb(page), ['Роман', 'Два', 'S1']);

  // scene below a scene of another chapter
  await drag(page, pt(await box(sceneRow(page, 'T1'))), pt(await box(sceneRow(page, 'S2')), 0.8));
  await eventually(() => treeOutline(page), [['Один', ['S3', 'S2', 'T1']], ['Два', ['T2', 'S1']]], 'T1 dropped below S2');

  // a chapter above another chapter
  await drag(page, pt(await box(chapterRow(page, 'Два'))), pt(await box(chapterRow(page, 'Один')), 0.25));
  await eventually(() => treeOutline(page), [['Два', ['T2', 'S1']], ['Один', ['S3', 'S2', 'T1']]], 'Два dropped above Один');
  assert.deepEqual(await treeNumbers(page), ['1.', '2.']);

  // a plain click (no movement) is still a selection, not a drag
  await openSceneFromTree(page, 'T2');
  assert.deepEqual(await treeOutline(page), [['Два', ['T2', 'S1']], ['Один', ['S3', 'S2', 'T1']]]);

  const { data } = await save(page);
  assert.deepEqual(outline(data), [['Два', ['T2', 'S1']], ['Один', ['S3', 'S2', 'T1']]]);
  assert.deepEqual(data.chapters.map(c => c.id), ['c2', 'c1']);
  assert.deepEqual(data.chapters.map(c => c.order), [0, 1]);
  assert.deepEqual(data.chapters[1].scenes.map(s => s.order), [0, 1, 2]);
  assert.match(sceneIn(data, 'S1').content, /Первая сцена/);
});

flow('tree context menu: duplicate scene and chapter, collapse and expand all', async page => {
  const note = (id, word, start) => ({ id, typeId: 'fix', content: 'Заметка ' + word, selectedText: word, startOffset: start, endOffset: start + word.length, createdAt: '2024-01-15T10:00:00Z' });
  await openFixture(page, novelOf([
    ch('c1', 'Один', sc('s1', 'S1', '<p>Текст один</p>', { notes: [note('n1', 'один', 6)] }), sc('s2', 'S2')),
    ch('c2', 'Два', sc('t1', 'T1', '<p>Текст два</p>', { notes: [note('n2', 'два', 6)] }))
  ]));
  await contextMenu(page, sceneRow(page, 'S1'), 'Duplicate');
  await eventually(() => treeOutline(page), [['Один', ['S1', 'S1 (copy)', 'S2']], ['Два', ['T1']]], 'scene duplicated');
  await openSceneFromTree(page, 'S1 (copy)');
  assert.equal(await editorText(page), 'Текст один');

  // the copy carries the note as a note of its own: resolving it leaves the original's open
  await openAccordion(page, 'notes');
  const noteCards = () => page.evaluate(() => [...document.querySelectorAll('#noteList .note-lcard')].map(c =>
    [c.querySelector('.nl-quote').textContent, !!c.querySelector('.nl-check')]));
  await eventually(noteCards, [['“один”', false]], 'the copy has the note');
  await page.locator('#noteList .note-lcard').first().click();
  await expectShown(page, '#noteCard');
  await page.click('#ncResolve');
  await eventually(noteCards, [], 'the copy\'s note resolved (hidden)');
  await page.keyboard.press('Escape');
  await expectShown(page, '#noteCard', false);
  await openSceneFromTree(page, 'S1');
  await eventually(noteCards, [['“один”', false]], 'the original\'s note is still open');
  await eventually(() => page.locator('#marginNotes .note-dot').count(), 1, 'the original\'s margin dot');

  await contextMenu(page, chapterRow(page, 'Два'), 'Duplicate');
  await eventually(() => treeOutline(page), [['Один', ['S1', 'S1 (copy)', 'S2']], ['Два', ['T1']], ['Два (copy)', ['T1']]], 'chapter duplicated');
  assert.deepEqual(await treeNumbers(page), ['1.', '2.', '3.']);

  const visibleScenes = () => page.locator('#chapterList .tree-scene:visible').count();
  await contextMenu(page, chapterRow(page, 'Один'), 'Collapse All');
  await eventually(visibleScenes, 0, 'no scene visible after Collapse All');
  await contextMenu(page, chapterRow(page, 'Два'), 'Expand All');
  await eventually(visibleScenes, 5, 'every scene visible after Expand All');

  // the caret collapses a single chapter
  await chapterRow(page, 'Один').locator('.tc-caret').click();
  await eventually(visibleScenes, 2, 'only Один collapsed');
  await chapterRow(page, 'Один').locator('.tc-caret').click();
  await eventually(visibleScenes, 5, 'Один expanded again');

  const { data } = await save(page);
  assert.deepEqual(outline(data), [['Один', ['S1', 'S1 (copy)', 'S2']], ['Два', ['T1']], ['Два (copy)', ['T1']]]);
  assert.match(data.chapters[0].scenes[1].content, /Текст один/);
  assert.match(data.chapters[2].scenes[0].content, /Текст два/);
  const ids = [...data.chapters.map(c => c.id), ...scenesOf(data).map(s => s.id)];
  assert.equal(new Set(ids).size, ids.length, 'duplicates get fresh ids');
  assert.deepEqual(data.chapters.map(c => c.collapsed), [false, false, false]);
  // notes are copied with the scenes, each with an id and a state of its own
  assert.deepEqual(scenesOf(data).map(s => [s.title, s.notes.map(n => [n.selectedText, !!n.resolved])]), [
    ['S1', [['один', false]]], ['S1 (copy)', [['один', true]]], ['S2', []], ['T1', [['два', false]]], ['T1', [['два', false]]]
  ]);
  const noteIds = scenesOf(data).flatMap(s => s.notes.map(n => n.id));
  assert.equal(new Set(noteIds).size, noteIds.length, 'copied notes get fresh ids');
});

flow('tree context menu: Move to Chapter ▸ moves the scene to the end of the picked chapter', async page => {
  await openFixture(page, novelOf([
    ch('c1', 'Один', sc('s1', 'S1'), sc('s2', 'S2', '<p>Вторая сцена</p>')),
    ch('c2', 'Два', sc('t1', 'T1')),
    ch('c3', 'Три', sc('u1', 'U1'))
  ]));
  await openSceneFromTree(page, 'S2');
  await sceneRow(page, 'S2').click({ button: 'right' });
  await expectShown(page, '#ctxMenu');
  await page.locator('#ctxMenu .ctx-sub-head').hover();
  // the submenu offers every other chapter
  assert.deepEqual(await page.locator('#ctxMenu .ctx-sub-menu button').allTextContents(), ['Два', 'Три']);
  /* This exercises what the item does. The menu clips its submenu today (see the todo test
     below), and Playwright reaches the item only by scrolling the clipped menu; the todo test
     is the one that checks a user can actually see and hit it. */
  await page.locator('#ctxMenu .ctx-sub-menu button', { hasText: 'Два' }).click();
  await eventually(() => treeOutline(page), [['Один', ['S1']], ['Два', ['T1', 'S2']], ['Три', ['U1']]], 'S2 moved to the end of Два');
  await expectShown(page, '#ctxMenu', false);
  await expectIndicator(page, 'Unsaved');
  // the moved scene stays open and the breadcrumb follows it
  assert.equal(await activeScene(page), 'S2');
  assert.equal(await editorText(page), 'Вторая сцена');
  assert.deepEqual(await breadcrumb(page), ['Роман', 'Два', 'S2']);

  const { data } = await save(page);
  assert.deepEqual(outline(data), [['Один', ['S1']], ['Два', ['T1', 'S2']], ['Три', ['U1']]]);
  assert.deepEqual(data.chapters[1].scenes.map(s => [s.id, s.order]), [['t1', 0], ['s2', 1]]);
});

flow('tree context menu: the Move to Chapter ▸ submenu can be seen and clicked', async page => {
  await openFixture(page, novelOf([
    ch('c1', 'Один', sc('s1', 'S1'), sc('s2', 'S2')),
    ch('c2', 'Два', sc('t1', 'T1'))
  ]));
  await sceneRow(page, 'S2').click({ button: 'right' });
  await expectShown(page, '#ctxMenu');
  await page.locator('#ctxMenu .ctx-sub-head').hover();
  const item = page.locator('#ctxMenu .ctx-sub-menu button', { hasText: 'Два' });
  // the submenu must be reachable: what is under its centre is the item itself
  const hit = await item.evaluate(b => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; });
  assert.equal(hit, true, 'the "Move to Chapter" submenu is hidden behind the clipped context menu');
  await item.click({ timeout: 3000 });
  await eventually(() => treeOutline(page), [['Один', ['S1']], ['Два', ['T1', 'S2']]], 'S2 moved to Два');
  const { data } = await save(page);
  assert.deepEqual(outline(data), [['Один', ['S1']], ['Два', ['T1', 'S2']]]);
}, { todo: 'bug: .ctx-menu has overflow:hidden, which clips the absolutely positioned .ctx-sub-menu (left:100%) — the "Move to Chapter ▸" submenu is never visible or clickable' });

flow('deleting a scene or chapter is immediate, and Undo brings it back where it was', async page => {
  const note = { id: 'n1', typeId: 'fix', content: 'Заметка', selectedText: 'Вторая', startOffset: 0, endOffset: 6, createdAt: '2024-01-15T10:00:00Z' };
  await openFixture(page, novelOf([
    ch('c1', 'Один', sc('s1', 'S1', '<p>Первая</p>'), sc('s2', 'S2', '<p>Вторая</p>', { notes: [note] }), sc('s3', 'S3', '<p>Третья</p>')),
    ch('c2', 'Два', sc('t1', 'T1', '<p>Четвёртая</p>'))
  ]));
  const undoButtons = page.locator('#toastHost .toast-action.show .toast-btn');   // a retired toast fades out without .show
  const undo = async () => {
    await undoButtons.click();
    await eventually(() => undoButtons.count(), 0, 'Undo is spent');
  };
  await openSceneFromTree(page, 'S2');
  await typeAtEnd(page, ' правка');
  await save(page);   // so each Undo below has to mark the novel unsaved on its own

  // the open scene: gone at once, no confirmation; the scene before it opens
  await contextMenu(page, sceneRow(page, 'S2'), 'Delete');
  await eventually(() => treeOutline(page), [['Один', ['S1', 'S3']], ['Два', ['T1']]], 'S2 deleted');
  assert.equal(await isShown(page, '#modalOverlay'), false, 'no confirmation');
  assert.equal(await activeScene(page), 'S1');
  assert.equal(await editorText(page), 'Первая');
  await expectText(page, '#toastHost .toast-action.show span', 'Scene “S2” deleted');
  const deleted = await save(page);
  assert.deepEqual(outline(deleted.data), [['Один', ['S1', 'S3']], ['Два', ['T1']]]);
  await undo();
  await eventually(() => treeOutline(page), [['Один', ['S1', 'S2', 'S3']], ['Два', ['T1']]], 'S2 back in its place');
  assert.equal(await activeScene(page), 'S2', 'the scene that was open opens again');
  assert.equal(await editorText(page), 'Вторая правка');
  await expectIndicator(page, 'Unsaved');
  let { data } = await save(page);
  assert.deepEqual(outline(data), [['Один', ['S1', 'S2', 'S3']], ['Два', ['T1']]]);
  assert.match(sceneIn(data, 'S2').content, /Вторая правка/);
  assert.deepEqual(sceneIn(data, 'S2').notes.map(n => [n.id, n.content]), [['n1', 'Заметка']], 'with its notes');
  assert.equal(sceneIn(data, 'S2').id, 's2');

  // the open chapter: the other one opens; Undo puts it back first, with every scene
  await contextMenu(page, chapterRow(page, 'Один'), 'Delete');
  await eventually(() => treeOutline(page), [['Два', ['T1']]], 'chapter Один deleted');
  assert.equal(await activeScene(page), 'T1');
  await undo();
  await eventually(() => treeOutline(page), [['Один', ['S1', 'S2', 'S3']], ['Два', ['T1']]], 'chapter Один back first');
  assert.equal(await activeScene(page), 'S2');
  assert.deepEqual(await treeNumbers(page), ['1.', '2.']);
  await expectIndicator(page, 'Unsaved');

  // the last scene of a chapter stays
  await contextMenu(page, sceneRow(page, 'T1'), 'Delete');
  await expectText(page, '#toastHost .toast:last-child', 'A chapter must keep at least one scene');
  assert.deepEqual(await treeOutline(page), [['Один', ['S1', 'S2', 'S3']], ['Два', ['T1']]]);

  // only the latest deletion can be undone, so nothing comes back out of order
  await contextMenu(page, sceneRow(page, 'S1'), 'Delete');
  await contextMenu(page, sceneRow(page, 'S3'), 'Delete');
  await eventually(() => undoButtons.count(), 1, 'one live Undo');
  await expectText(page, '#toastHost .toast-action.show span', 'Scene “S3” deleted');
  await undo();
  await eventually(() => treeOutline(page), [['Один', ['S2', 'S3']], ['Два', ['T1']]], 'S3 back, S1 stays deleted');

  // a corkboard card's Delete is undoable too
  await page.click('#btnCorkboard');
  await expectShown(page, '#corkboard');
  const cards = () => page.evaluate(() => [...document.querySelectorAll('#corkGrid .cork-card:not(.cork-ghost) .cc-title')].map(t => t.textContent));
  await eventually(cards, ['S2', 'S3', 'T1'], 'cards');
  const card = page.locator('#corkGrid .cork-card:not(.cork-ghost)', { has: page.locator('.cc-title:text-is("S3")') });
  await card.hover();
  await card.locator('.cc-del').click();
  await eventually(cards, ['S2', 'T1'], 'card deleted');
  await undo();
  await eventually(cards, ['S2', 'S3', 'T1'], 'card back');
  await page.keyboard.press('Escape');

  ({ data } = await save(page));
  assert.deepEqual(outline(data), [['Один', ['S2', 'S3']], ['Два', ['T1']]]);
  assert.deepEqual(data.chapters[0].scenes.map(s => [s.id, s.order]), [['s2', 0], ['s3', 1]]);
});

flow('scene metadata bar: POV, location, time of day, status', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Первая'), sc('s2', 'Вторая'))], {
    characters: [{ id: 'anna', name: 'Анна' }, { id: 'boris', name: 'Борис' }],
    locations: [{ id: 'town', name: 'Город' }]
  }));
  await expectShown(page, '#sceneMeta');
  // every field is an edit on its own: from a clean novel it marks it unsaved, and a save
  // makes it clean again for the next one
  for (const [sel, label] of [['#metaStatus', 'Review'], ['#metaPov', '👤 Анна'], ['#metaLoc', '📍 Город'], ['#metaTime', '🌙 Night']]) {
    assert.equal(await indicator(page), 'Saved', `clean before ${sel}`);
    await page.selectOption(sel, { label });
    await eventually(() => indicator(page), 'Unsaved', `${sel} alone marks the novel unsaved`);
    await save(page);
  }

  // the tree's status dot follows
  const dot = title => sceneRow(page, title).locator('.ts-status').evaluate(d => ({ title: d.title, bg: getComputedStyle(d).backgroundColor }));
  await eventually(() => dot('Первая'), { title: 'Review', bg: 'rgb(230, 180, 34)' }, 'review dot');
  assert.deepEqual(await dot('Вторая'), { title: 'Draft', bg: 'rgb(143, 136, 124)' });

  // the bar shows each scene's own values
  await openSceneFromTree(page, 'Вторая');
  const metaLabels = () => page.evaluate(() => ['#metaPov', '#metaLoc', '#metaTime', '#metaStatus'].map(s => { const el = document.querySelector(s); return el.options[el.selectedIndex].textContent; }));
  await eventually(metaLabels, ['👤 POV: —', '📍 Location: —', '❓ Unknown', 'Draft'], 'second scene metadata');
  await page.selectOption('#metaStatus', { label: 'Done' });
  await eventually(() => dot('Вторая'), { title: 'Done', bg: 'rgb(92, 184, 92)' }, 'done dot');
  await openSceneFromTree(page, 'Первая');
  await eventually(metaLabels, ['👤 Анна', '📍 Город', '🌙 Night', 'Review'], 'first scene metadata');

  // the bar hides and comes back
  await page.click('#metaHide');
  await expectShown(page, '#sceneMeta', false);
  await page.click('#metaShow');
  await expectShown(page, '#sceneMeta');

  // the corkboard card carries the same metadata
  await page.click('#btnCorkboard');
  await expectShown(page, '#corkboard');
  const card = page.locator('.cork-card:not(.cork-ghost)', { has: page.locator('.cc-title:text-is("Первая")') });
  const cardText = await card.innerText();
  for (const s of ['👤 Анна', '📍 Город', '🌙 Night', 'Review']) assert.ok(cardText.includes(s), `card shows ${s}: ${cardText}`);
  await page.click('#corkBack');
  await expectShown(page, '#corkboard', false);

  const { data } = await save(page);
  const first = sceneIn(data, 'Первая');
  assert.deepEqual([first.povCharacter, first.location, first.timeOfDay, first.status], ['anna', 'town', 'night', 'review']);
  const second = sceneIn(data, 'Вторая');
  assert.deepEqual([second.povCharacter, second.location, second.timeOfDay, second.status], [null, null, 'unknown', 'done']);
});

flow('word and character counters follow typing; the word goal comes from its prompt', async page => {
  await openFixture(page, novelOf([
    ch('c1', 'Первая', sc('a', 'A', '<p>один два три</p>'), sc('b', 'B', '<p>четыре пять</p>')),
    ch('c2', 'Вторая', sc('c', 'C', '<p>шесть</p>'))
  ]));
  const counters = () => page.evaluate(() => ['#statChapWords', '#statTotalWords', '#statChars', '#statCharsNs'].map(s => document.querySelector(s).textContent));
  const treeWords = () => page.evaluate(() => [...document.querySelectorAll('#chapterList .tree-chapter')].map(c => [
    c.querySelector('.tc-words').textContent, [...c.querySelectorAll('.ts-words')].map(w => w.textContent)
  ]));
  const chars = s => [String(s.length), String(s.replace(/\s/g, '').length)];
  await eventually(counters, ['5', '6', ...chars('один два три')], 'counters on open');
  assert.deepEqual(await treeWords(page), [['5', ['3', '2']], ['1', ['1']]]);

  await typeAtEnd(page, ' семь восемь');
  await eventually(counters, ['7', '8', ...chars('один два три семь восемь')], 'counters after typing');
  await eventually(treeWords, [['7', ['5', '2']], ['1', ['1']]], 'tree word counts after typing');

  // another chapter's counters
  await openSceneFromTree(page, 'C');
  await eventually(counters, ['1', '8', ...chars('шесть')], 'counters in chapter 2');

  // goal: Settings › Word goal ⚙ → prompt
  await expectText(page, '#goalLabel', '0% of 80,000');
  await openAccordion(page, 'settings');
  await page.click('#btnGoal');
  await answerPrompt(page, '16', 'Word goal');
  await expectText(page, '#goalLabel', '50% of 16');
  assert.equal(await page.evaluate(() => document.getElementById('progressBar').style.width), '50%');

  const { data } = await save(page);
  assert.equal(data.settings.wordGoal, 16);
  assert.equal(sceneIn(data, 'A').wordCount, 5);
  assert.equal(data.chapters[0].wordCount, 7);
});

flow('formatting: bold, italic, heading, and the Markdown round trip', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена', '<p>Alpha beta gamma</p><p>Second line</p>'))]));

  await selectInEditor(page, 'beta');
  await page.click('#fmtBold');
  await eventually(async () => /<b>beta<\/b>/.test(await editorHTML(page)), true, 'bold applied');
  await expectIndicator(page, 'Unsaved');
  await selectInEditor(page, 'gamma');
  await page.click('#fmtItalic');
  await eventually(async () => /<i>gamma<\/i>/.test(await editorHTML(page)), true, 'italic applied');

  // caret in the second paragraph → Paragraph style: Heading 2
  const sel = await selectInEditor(page, 'Second');
  await page.mouse.click(sel.x, sel.y);
  await page.selectOption('#styleSelect', 'H2');
  await eventually(async () => /<h2>Second line<\/h2>/.test(await editorHTML(page)), true, 'heading applied');

  // Markdown source view shows the same structure
  await page.click('#btnMarkdownMode');
  await expectShown(page, '#mdEditor');
  await expectShown(page, '#editor', false);
  const md = await page.inputValue('#mdEditor');
  assert.match(md, /Alpha \*\*beta\*\* \*gamma\*/);
  assert.match(md, /^## Second line$/m);

  // edit in Markdown, switch back: formatted HTML
  await page.click('#mdEditor');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nNew **strong** and *soft* line');
  await page.click('#btnMarkdownMode');
  await expectShown(page, '#editor');
  const html = await editorHTML(page);
  assert.match(html, /<b>beta<\/b>/);
  assert.match(html, /<i>gamma<\/i>/);
  assert.match(html, /<h2>Second line<\/h2>/);
  assert.match(html, /New <b>strong<\/b> and <i>soft<\/i> line/);

  const { data } = await save(page);
  const s = sceneIn(data, 'Сцена');
  assert.match(s.content, /<b>beta<\/b>/);
  assert.match(s.content, /<i>gamma<\/i>/);
  assert.match(s.content, /<h2>Second line<\/h2>/);
  assert.match(s.content, /New <b>strong<\/b> and <i>soft<\/i> line/);
  assert.match(s.markdownContent, /New \*\*strong\*\* and \*soft\* line/);
});

flow('margin notes: add, filter, resolve, edit, delete', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена',
    '<p>Старый замок стоял на холме.</p><p>Внизу текла река.</p>'))]));
  await openAccordion(page, 'notes');
  const cards = () => page.evaluate(() => [...document.querySelectorAll('#noteList .note-lcard')].map(c => ({
    quote: c.querySelector('.nl-quote').textContent, body: c.querySelector('.nl-body').textContent, resolved: !!c.querySelector('.nl-check')
  })));
  const dots = () => page.locator('#marginNotes .note-dot').count();
  const pills = () => page.evaluate(() => [...document.querySelectorAll('#noteFilters .filter-pill')].map(p => p.textContent.trim()));
  const card = quote => page.locator('#noteList .note-lcard', { has: page.locator(`.nl-quote:text-is("“${quote}”")`) });

  // 1) select → right-click → Add Note
  const at = await selectInEditor(page, 'замок');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expectShown(page, '#editorCtx');
  await page.click('#editorCtx [data-ectx="addnote"]');
  await expectShown(page, '#notePopup');
  await page.selectOption('#npType', { label: '🟡 Fix' });
  await page.click('#npContent');
  await page.keyboard.type('Проверить архитектуру');
  await page.click('#npAdd');
  await expectShown(page, '#notePopup', false);
  await expectIndicator(page, 'Unsaved');
  await eventually(dots, 1, 'one margin dot');
  await eventually(cards, [{ quote: '“замок”', body: 'Проверить архитектуру', resolved: false }], 'first note listed');

  // 2) select → Ctrl+Shift+M
  await selectInEditor(page, 'река');
  await page.keyboard.press('Control+Shift+M');
  await expectShown(page, '#notePopup');
  await page.selectOption('#npType', { label: '🔴 Idea' });
  await page.click('#npContent');
  await page.keyboard.type('Добавить мост');
  await page.click('#npAdd');
  await eventually(dots, 2, 'two margin dots');
  await eventually(pills, ['All (2)', '🟡 Fix (1)', '🔵 Fact-check (0)', '🟢 Expand (0)', '🟣 Move (0)', '🔴 Idea (1)'], 'filter pills');

  // filter pills
  await page.locator('#noteFilters .filter-pill', { hasText: 'Idea' }).click();
  await eventually(async () => (await cards()).map(c => c.quote), ['“река”'], 'Idea filter');
  await page.locator('#noteFilters .filter-pill', { hasText: 'All' }).click();
  await eventually(async () => (await cards()).map(c => c.quote), ['“замок”', '“река”'], 'All filter');

  // resolve: hidden by "Hide resolved", back with "Show resolved"
  await card('замок').click();
  await expectShown(page, '#noteCard');
  await page.click('#ncResolve');
  await eventually(async () => (await cards()).map(c => c.quote), ['“река”'], 'resolved note hidden');
  await eventually(dots, 1, 'resolved dot hidden');
  await page.keyboard.press('Escape');
  await expectShown(page, '#noteCard', false);
  await page.selectOption('#noteResolvedFilter', 'show');
  await eventually(cards, [
    { quote: '“замок”', body: 'Проверить архитектуру', resolved: true },
    { quote: '“река”', body: 'Добавить мост', resolved: false }
  ], 'Show resolved');
  await page.selectOption('#noteResolvedFilter', 'only');
  await eventually(async () => (await cards()).map(c => c.quote), ['“замок”'], 'Only resolved');
  await page.selectOption('#noteResolvedFilter', 'show');

  // edit
  await card('река').click();
  await expectShown(page, '#noteCard');
  await page.click('#ncEdit');
  await page.click('#ncEditBody');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Добавить мост и мельницу');
  await page.click('#ncSaveEdit');
  await eventually(async () => (await cards()).map(c => c.body), ['Проверить архитектуру', 'Добавить мост и мельницу'], 'edited note');
  await page.keyboard.press('Escape');

  // a third note, then delete it
  await selectInEditor(page, 'холме');
  await page.keyboard.press('Control+Shift+M');
  await expectShown(page, '#notePopup');
  await page.click('#npContent');   // see the todo test on the popup's focus
  await page.keyboard.type('Лишняя');
  await page.click('#npAdd');
  await eventually(async () => (await cards()).length, 3, 'third note');
  await card('холме').click();
  await page.click('#ncDelete');
  await confirmModal(page, 'Delete note');
  await eventually(async () => (await cards()).map(c => c.quote), ['“замок”', '“река”'], 'third note deleted');

  const { data } = await save(page);
  const notes = sceneIn(data, 'Сцена').notes.map(n => ({ typeId: n.typeId, selectedText: n.selectedText, content: n.content, resolved: n.resolved }));
  assert.deepEqual(notes, [
    { typeId: 'fix', selectedText: 'замок', content: 'Проверить архитектуру', resolved: true },
    { typeId: 'idea', selectedText: 'река', content: 'Добавить мост и мельницу', resolved: false }
  ]);
  const n0 = sceneIn(data, 'Сцена').notes[0];
  assert.equal('Старый замок стоял на холме.'.slice(n0.startOffset, n0.endOffset), 'замок');
});

flow('Ctrl+Shift+M always puts the caret in the new note\'s text box', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена', '<p>Старый замок стоял на холме.</p><p>Внизу текла река.</p>'))]));
  const words = ['замок', 'холме', 'река', 'Старый'];
  for (let i = 0; i < 12; i++) {
    const w = words[i % words.length];
    await selectInEditor(page, w);
    await page.keyboard.press('Control+Shift+M');
    await expectShown(page, '#notePopup');
    await eventually(() => page.evaluate(() => document.activeElement && document.activeElement.id), 'npContent', `focus after Ctrl+Shift+M #${i + 1} on "${w}"`, 1500);
    await page.keyboard.type('заметка ' + i);
    await page.click('#npAdd');
    await expectShown(page, '#notePopup', false);
  }
  // nothing typed for a note leaked into the scene
  assert.equal(await editorText(page), 'Старый замок стоял на холме.\n\nВнизу текла река.');
}, { todo: 'bug (intermittent): openAddNote() focuses #npContent on a fixed 30 ms timer while the popup\'s 180 ms notePop entry animation runs; Chromium sometimes refuses that focus(), so the caret stays in the editor with the text still selected and the note text typed next replaces it in the scene (≈2–3 of 16 presses once a note exists; 0 of 20 with the animation off or a 100 ms delay)' });

flow('corkboard: cards, status badge, filter, sort, open a scene', async page => {
  await openFixture(page, novelOf([
    ch('c1', 'Глава 1',
      sc('al', 'Альфа', '<p>раз два три</p>'),
      sc('be', 'Бета', '<p>один</p>', { status: 'review' }),
      sc('ga', 'Гамма', '<p>a b c d e</p>', { status: 'done' })),
    ch('c2', 'Глава 2', sc('de', 'Дельта', '<p>Текст дельты</p>'))
  ]));
  await page.click('#btnCorkboard');
  await expectShown(page, '#corkboard');
  await expectShown(page, '.editor-scroll', false);
  const board = () => page.evaluate(() => [...document.querySelectorAll('#corkGrid .cork-group')].map(g => [
    g.querySelector('.cork-chap').firstChild.textContent.replace('📁', '').trim(),
    [...g.querySelectorAll('.cork-card:not(.cork-ghost) .cc-title')].map(t => t.textContent)
  ]));
  const cardOf = title => page.locator('#corkGrid .cork-card:not(.cork-ghost)', { has: page.locator(`.cc-title:text-is("${title}")`) });
  await eventually(board, [['Глава 1', ['Альфа', 'Бета', 'Гамма']], ['Глава 2', ['Дельта']]], 'cards in order');
  assert.match(await cardOf('Гамма').innerText(), /5 words/);

  // badge cycles Draft → Review → Done → Draft
  const badge = title => cardOf(title).locator('.cc-badge').innerText().then(t => t.trim());
  assert.equal(await badge('Альфа'), 'Draft');
  await cardOf('Альфа').locator('.cc-badge').click();
  await eventually(() => badge('Альфа'), 'Review', 'badge cycled to Review');
  await expectIndicator(page, 'Unsaved');
  assert.equal(await sceneRow(page, 'Альфа').locator('.ts-status').getAttribute('title'), 'Review');
  await cardOf('Дельта').locator('.cc-badge').click();
  await cardOf('Дельта').locator('.cc-badge').click();
  await cardOf('Дельта').locator('.cc-badge').click();
  await eventually(() => badge('Дельта'), 'Draft', 'badge wrapped around to Draft');

  // filter by status
  await page.selectOption('#corkStatus', 'review');
  await eventually(board, [['Глава 1', ['Альфа', 'Бета']], ['Глава 2', []]], 'review filter');
  await page.selectOption('#corkStatus', 'done');
  await eventually(board, [['Глава 1', ['Гамма']], ['Глава 2', []]], 'done filter');
  await page.selectOption('#corkStatus', 'all');

  // sort
  await page.selectOption('#corkSort', 'words');
  await eventually(board, [['Глава 1', ['Гамма', 'Альфа', 'Бета']], ['Глава 2', ['Дельта']]], 'sorted by words');
  await page.selectOption('#corkSort', 'status');
  await eventually(board, [['Глава 1', ['Альфа', 'Бета', 'Гамма']], ['Глава 2', ['Дельта']]], 'sorted by status');
  await page.selectOption('#corkSort', 'order');

  // Escape and Back both close; a card click opens its scene in the editor
  await page.keyboard.press('Escape');
  await expectShown(page, '#corkboard', false);
  await page.click('#btnCorkboard');
  await expectShown(page, '#corkboard');
  await cardOf('Дельта').locator('.cc-title').click();
  await expectShown(page, '#corkboard', false);
  await eventually(() => editorText(page), 'Текст дельты', 'Дельта opened from its card');
  assert.equal(await activeScene(page), 'Дельта');
  assert.deepEqual(await breadcrumb(page), ['Роман', 'Глава 2', 'Дельта']);

  const { data } = await save(page);
  assert.deepEqual(scenesOf(data).map(s => s.status), ['review', 'review', 'done', 'draft']);
  assert.deepEqual(outline(data), [['Глава 1', ['Альфа', 'Бета', 'Гамма']], ['Глава 2', ['Дельта']]], 'sorting the board does not reorder the novel');
});

flow('characters, locations and races: add, edit, delete', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена'))], { characters: [{ id: 'old', name: 'Старик' }] }));
  const names = list => page.evaluate(l => [...document.querySelectorAll(`${l} .entity-head`)].map(h => [h.querySelector('.ename').textContent, h.querySelector('.erole').textContent]), list);

  // character
  const chars = await openAccordion(page, 'chars');
  await chars.locator('#btnAddChar').click();
  const anna = page.locator('#charList .entity').last();
  await eventually(() => names('#charList'), [['Старик', ''], ['(unnamed)', 'Main']], 'new character card');
  await fieldAfter(anna, 'Name').click();
  await page.keyboard.type('Анна');
  await eventually(() => names('#charList'), [['Старик', ''], ['Анна', 'Main']], 'name updates the header live');
  await expectIndicator(page, 'Unsaved');
  await fieldAfter(anna, 'Role').selectOption('supporting');
  await eventually(() => names('#charList'), [['Старик', ''], ['Анна', 'Supporting']], 'role updates the header');
  await fieldAfter(anna, 'Age').click();
  await page.keyboard.type('27');
  await fieldAfter(anna, 'Motivation').click();
  await page.keyboard.type('Найти брата');
  // the POV picker knows her at once
  assert.ok((await page.locator('#metaPov option').allTextContents()).includes('👤 Анна'));

  // location
  const locs = await openAccordion(page, 'locs');
  await locs.locator('#btnAddLoc').click();
  const fort = page.locator('#locList .entity').last();
  await fieldAfter(fort, 'Name').click();
  await page.keyboard.type('Крепость');
  await fieldAfter(fort, 'Type').selectOption('building');
  await fieldAfter(fort, 'Atmosphere').click();
  await page.keyboard.type('Сырость');
  await eventually(() => names('#locList'), [['Крепость', 'Building']], 'location card');
  assert.ok((await page.locator('#metaLoc option').allTextContents()).includes('📍 Крепость'));

  // race
  const races = await openAccordion(page, 'races');
  await races.locator('#btnAddRace').click();
  const elves = page.locator('#raceList .entity').last();
  await fieldAfter(elves, 'Name').click();
  await page.keyboard.type('Эльфы');
  await fieldAfter(elves, 'Special Traits').click();
  await page.keyboard.type('Долгая жизнь');
  await eventually(() => names('#raceList'), [['Эльфы', '']], 'race card');

  // collapse/expand an entity card by its header
  await page.locator('#charList .entity-head', { hasText: 'Анна' }).click();
  await expectShown(page, '#charList .entity:last-child .entity-body', false);
  await page.locator('#charList .entity-head', { hasText: 'Анна' }).click();
  await expectShown(page, '#charList .entity:last-child .entity-body');

  // delete through the confirm modal
  await page.locator('#charList .entity-head', { hasText: 'Старик' }).click();
  await page.locator('#charList .entity', { has: page.locator('.ename:text-is("Старик")') }).locator('.entity-del').click();
  await expectText(page, '#modalBody', 'Delete "Старик"?');
  await confirmModal(page, 'Delete');
  await eventually(() => names('#charList'), [['Анна', 'Supporting']], 'character deleted');

  const { data } = await save(page);
  assert.equal(data.characters.length, 1);
  assert.deepEqual([data.characters[0].name, data.characters[0].role, data.characters[0].age, data.characters[0].motivation], ['Анна', 'supporting', '27', 'Найти брата']);
  assert.deepEqual(data.locations.map(l => [l.name, l.type, l.atmosphere]), [['Крепость', 'building', 'Сырость']]);
  assert.deepEqual(data.races.map(r => [r.name, r.traits]), [['Эльфы', 'Долгая жизнь']]);
});

flow('character graph: add a character and a relationship; legend; Escape closes', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена'))], {
    characters: [{ id: 'anna', name: 'Анна', role: 'main' }, { id: 'boris', name: 'Борис', role: 'supporting' }]
  }));
  await page.keyboard.press('Control+g');
  await expectShown(page, '#graphOverlay');

  await page.click('#graphAddChar');
  await answerPrompt(page, 'Вера', 'Add character');
  await expectIndicator(page, 'Unsaved');
  assert.deepEqual(await page.locator('#charList .ename').allTextContents(), ['Анна', 'Борис', 'Вера']);

  // legend: eight relationship types; it folds away and back
  assert.deepEqual(await page.locator('#legendBody .lg-row').allTextContents(), ['Family', 'Friend', 'Enemy', 'Romance', 'Colleague', 'Mentor', 'Rival', 'Custom']);
  await page.click('#legendToggle');
  await expectShown(page, '#legendBody', false);
  await expectText(page, '#legendToggle', 'Legend ▴');
  await page.click('#legendToggle');
  await expectShown(page, '#legendBody');
  await expectText(page, '#legendToggle', 'Legend ▾');
  // folded, it no longer covers the bottom of the side panel (see the todo test below)
  await page.click('#legendToggle');
  await expectShown(page, '#legendBody', false);

  await page.click('#graphAddRel');
  await expectShown(page, '#graphPanel');
  const label = sel => page.locator(sel).evaluate(s => s.options[s.selectedIndex].textContent);
  assert.equal(await label('#relA'), 'Анна');
  assert.equal(await label('#relB'), 'Борис');
  await page.selectOption('#relB', { label: 'Вера' });
  await page.selectOption('#relType', { label: 'Mentor' });
  await page.click('#relSubtype');
  await page.keyboard.type('наставница');
  await page.selectOption('#relStatus', { label: 'Secret' });
  await page.click('#relSave');
  await expectShown(page, '#graphPanel', false);

  // a character cannot be related to itself
  await page.click('#graphAddRel');
  await page.selectOption('#relB', { label: 'Анна' });
  await page.click('#relSave');
  await expectShown(page, '#graphPanel');   // refused: stays open
  await page.click('#relCancel');
  await expectShown(page, '#graphPanel', false);

  // Escape closes the side panel first, then the graph; Ctrl+G toggles it
  await page.click('#graphAddRel');
  await expectShown(page, '#graphPanel');
  await page.keyboard.press('Escape');
  await expectShown(page, '#graphPanel', false);
  await expectShown(page, '#graphOverlay');
  await page.keyboard.press('Escape');
  await expectShown(page, '#graphOverlay', false);
  await page.keyboard.press('Control+g');
  await expectShown(page, '#graphOverlay');
  await page.keyboard.press('Control+g');
  await expectShown(page, '#graphOverlay', false);
  await openAccordion(page, 'chars');
  await page.click('#btnGraphView');
  await expectShown(page, '#graphOverlay');
  await page.click('#graphClose');
  await expectShown(page, '#graphOverlay', false);

  const { data } = await save(page);
  const vera = data.characters.find(c => c.name === 'Вера');
  assert.ok(vera, 'Вера saved');
  const anna = data.characters.find(c => c.id === 'anna');
  assert.equal(anna.relationships.length, 1);
  const r = anna.relationships[0];
  assert.deepEqual([r.targetCharacterId, r.type, r.subtype, r.status, r.strength], [vera.id, 'mentor', 'наставница', 'secret', 5]);
  for (const c of data.characters) assert.equal(typeof c.graphPosition.x, 'number', 'graph positions are kept');
});

flow('the graph legend does not cover the relationship panel', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена'))], {
    characters: [{ id: 'anna', name: 'Анна' }, { id: 'boris', name: 'Борис' }]
  }));
  await page.keyboard.press('Control+g');
  await expectShown(page, '#graphOverlay');
  await expectShown(page, '#legendBody');   // the legend starts expanded
  await page.click('#graphAddRel');
  await expectShown(page, '#graphPanel');
  const covered = await page.evaluate(() => ['relNotes', 'relCancel', 'relSave'].filter(id => {
    const r = document.getElementById(id).getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(el && el.closest('#' + id));
  }));
  assert.deepEqual(covered, [], 'panel controls hidden under the legend');
  await page.click('#relSave', { timeout: 3000 });
  await expectShown(page, '#graphPanel', false);
}, { todo: 'bug: .graph-legend (absolute, bottom-right of .graph-stage, later in the DOM) paints over the bottom of .graph-panel; at 1400×900 the expanded legend covers the relationship panel\'s Save button and Notes field' });

/* Centres of map pins found by their fill colour on the canvas (pins are filled with the
   location-type colour: city #4a90d9, natural #5cb85c, other #8f887c). */
async function findPins(page, colors) {
  return page.evaluate(cols => {
    const cv = document.getElementById('mapCanvas');
    const k = cv.width / cv.clientWidth;
    const data = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const want = cols.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
    const box = want.map(() => null);
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      const o = (y * cv.width + x) * 4;
      want.forEach((c, i) => {
        if (Math.abs(data[o] - c[0]) <= 2 && Math.abs(data[o + 1] - c[1]) <= 2 && Math.abs(data[o + 2] - c[2]) <= 2) {
          const b = box[i] || (box[i] = { x0: x, y0: y, x1: x, y1: y });
          b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y);
        }
      });
    }
    const r = cv.getBoundingClientRect();
    return box.map(b => b && { x: r.left + (b.x0 + b.x1) / 2 / k, y: r.top + (b.y0 + b.y1) / 2 / k });
  }, colors);
}

flow('world map: place locations, add a layer and a drawing, add a route, Escape closes', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена'))], {
    locations: [{ id: 'town', name: 'Город', type: 'city' }, { id: 'wood', name: 'Лес', type: 'natural' }, { id: 'port', name: 'Порт', type: 'other' }]
  }));
  await openAccordion(page, 'locs');
  await page.click('#btnWorldMap');
  await expectShown(page, '#mapOverlay');
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#mapLocList .map-loc-row')].map(r => [r.querySelector('.mlr-name').textContent, !!r.querySelector('.mlr-place')]));
  await eventually(rows, [['Город', true], ['Лес', true], ['Порт', true]], 'all unplaced');

  await page.locator('#mapLocList .map-loc-row', { hasText: 'Город' }).locator('.mlr-place').click();
  await eventually(rows, [['Город', false], ['Лес', true], ['Порт', true]], 'Город placed');
  await expectIndicator(page, 'Unsaved');
  await page.click('#mapPlaceAll');
  await eventually(rows, [['Город', false], ['Лес', false], ['Порт', false]], 'all placed');

  // the location search filters the list
  await page.click('#mapLocSearch');
  await page.keyboard.type('пор');
  await eventually(async () => (await rows()).map(r => r[0]), ['Порт'], 'search');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await eventually(async () => (await rows()).length, 3, 'search cleared');

  // a drawing layer; draw a stroke on it
  await page.click('#mapAddLayer');
  await eventually(() => page.locator('#mapLayerList .map-layer-row:not(.base) .ml-name').allTextContents(), ['Layer 1'], 'layer row');
  assert.ok((await page.locator('#mapActiveLayer option').allTextContents()).includes('Layer 1'));
  await page.locator('#mapLayerList .map-layer-row:not(.base) .ml-draw').click();
  await expectShown(page, '#mapDrawTools');
  const cv = await page.locator('#mapCanvas').boundingBox();
  await page.mouse.move(cv.x + cv.width * 0.2, cv.y + cv.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(cv.x + cv.width * 0.25, cv.y + cv.height * 0.25, { steps: 5 });
  await page.mouse.move(cv.x + cv.width * 0.3, cv.y + cv.height * 0.2, { steps: 5 });
  await page.mouse.up();
  await page.locator('#mapLayerList .map-layer-row:not(.base) .ml-draw').click();   // back to move/place
  await expectShown(page, '#mapDrawTools', false);

  // a route: Add Route → click Лес → click Порт → name it
  await page.click('#mapAddRoute');
  await expectShown(page, '#mapHint');
  const [, wood, port] = await findPins(page, ['#4a90d9', '#5cb85c', '#8f887c']);
  assert.ok(wood && port, 'pins are drawn on the canvas');
  await page.mouse.click(wood.x, wood.y);
  await eventually(() => textOf(page, '#mapHint'), 'Add Route: click the destination location  (Esc to cancel)', 'route source picked');
  await page.mouse.click(port.x, port.y);
  await expectShown(page, '#routeOverlay');
  await page.click('#rfName');
  await page.keyboard.type('Тракт');
  await page.click('#rfSave');
  await expectShown(page, '#routeOverlay', false);

  await page.keyboard.press('Escape');
  await expectShown(page, '#mapOverlay', false);

  const { data } = await save(page);
  const wm = data.settings.worldMap;
  assert.deepEqual(Object.keys(wm.locations).sort(), ['port', 'town', 'wood']);
  assert.deepEqual([wm.locations.town.x, wm.locations.town.y].map(v => Math.round(v * 100) / 100), [0.5, 0.5]);
  assert.deepEqual(wm.layers.map(l => [l.name, l.drawings.length, l.drawings[0] && l.drawings[0].tool]), [['Layer 1', 1, 'pen']]);
  assert.deepEqual(wm.routes.map(r => [r.fromLocationId, r.toLocationId, r.name]), [['wood', 'port', 'Тракт']]);
});

flow('compile: part divider, section break, drag reorder, rename, preview, TXT export', async page => {
  await openFixture(page, novelOf([
    ch('c1', 'Начало', sc('p', 'Пролог', '<p>Текст пролога.</p>'), sc('m', 'Встреча', '<p>Они встретились.</p>')),
    ch('c2', 'Конец', sc('f', 'Финал', '<p>Всё закончилось.</p>'))
  ], { title: 'Книга' }));
  await page.click('#btnCompile');
  await expectShown(page, '#compileOverlay');
  const order = () => page.evaluate(() => [...document.querySelectorAll('#compOrder .co-item')].map(r =>
    (r.querySelector('.co-title, .co-part-t, .co-break-t') || r).textContent.trim()));
  await eventually(order, ['Пролог', 'Встреча', 'Финал'], 'default order');
  assert.deepEqual(await page.locator('#compAvailable .ca-t').allTextContents(), ['🎬 Пролог', '🎬 Встреча', '🎬 Финал']);

  await page.click('#compAddPart');
  await answerPrompt(page, 'Часть первая', 'Add part divider');
  await page.click('#compAddBreak');
  await eventually(order, ['Пролог', 'Встреча', 'Финал', 'Часть первая', '— section break —'], 'appended');

  const rowAt = i => page.locator('#compOrder .co-item').nth(i);
  // the part to the top, the break before Финал
  await drag(page, pt(await rowAt(3).boundingBox()), pt(await rowAt(0).boundingBox(), 0.2));
  await eventually(order, ['Часть первая', 'Пролог', 'Встреча', 'Финал', '— section break —'], 'part moved to the top');
  await drag(page, pt(await rowAt(4).boundingBox()), pt(await rowAt(3).boundingBox(), 0.2));
  await eventually(order, ['Часть первая', 'Пролог', 'Встреча', '— section break —', 'Финал'], 'break moved before Финал');

  // rename for the compilation only
  await page.locator('#compOrder .co-title:text-is("Встреча")').dblclick();
  await answerPrompt(page, 'Встреча у реки', 'Rename in compilation');
  await eventually(order, ['Часть первая', 'Пролог', 'Встреча у реки', '— section break —', 'Финал'], 'renamed');

  // show scene titles in the output
  await page.selectOption('#compSettingsBody select[data-cs="sceneTitles"]', 'yes');

  await page.click('#compPreviewBtn');
  await expectShown(page, '#compPreview');
  const preview = await page.locator('#compPreview').innerText();
  const inOrder = (text, parts, what) => {
    let at = -1;
    for (const p of parts) {
      const i = text.indexOf(p, at + 1);
      assert.ok(i > at, `${what}: "${p}" missing or out of order in:\n${text}`);
      at = i;
    }
  };
  inOrder(preview, ['Книга', 'Часть первая', 'Глава 1: Начало', 'Пролог', 'Текст пролога.', 'Встреча у реки', 'Они встретились.', '* * *', 'Глава 2: Конец', 'Финал', 'Всё закончилось.'], 'preview');
  await page.click('#compPreviewBtn');
  await expectShown(page, '#compOrder');

  await page.click('#compExportBtn');
  const { name, text } = await downloadOf(page, () => page.click('#compExportMenu [data-comp-export="txt"]'));
  assert.equal(name, 'Книга.txt');
  inOrder(text, ['КНИГА', 'ЧАСТЬ ПЕРВАЯ', 'ГЛАВА 1: НАЧАЛО', 'Пролог', 'Текст пролога.', 'Встреча у реки', 'Они встретились.', '* * *', 'ГЛАВА 2: КОНЕЦ', 'Финал', 'Всё закончилось.'], 'TXT export');

  await page.keyboard.press('Escape');
  await expectShown(page, '#compileOverlay', false);
  // the compilation rename did not touch the novel
  assert.deepEqual(await treeOutline(page), [['Начало', ['Пролог', 'Встреча']], ['Конец', ['Финал']]]);
  const { data } = await save(page);
  assert.deepEqual(outline(data), [['Начало', ['Пролог', 'Встреча']], ['Конец', ['Финал']]]);
});

/* What of the frame is on screen: side-panel widths (a collapsed panel keeps only its 1px
   border, reported as 0) and whether the top bar is in view. */
const layoutOf = page => page.evaluate(() => {
  const w = id => { const r = document.getElementById(id).getBoundingClientRect().width; return r > 1 ? Math.round(r) : 0; };
  return { left: w('leftPanel'), right: w('rightPanel'), top: document.getElementById('topbar').getBoundingClientRect().bottom > 1 };
});

flow('focus mode hides the panels and Escape leaves it; panel toggles', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена', '<p>Текст</p>'))]));
  const layout = () => layoutOf(page);
  await eventually(layout, { left: 250, right: 300, top: true }, 'normal layout');

  await page.click('#editor');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+Shift+F');
  await eventually(layout, { left: 0, right: 0, top: false }, 'focus mode via Ctrl+Shift+F');
  await expectShown(page, '#sceneMeta', false);
  await page.keyboard.type(' в фокусе');   // the caret stays in the editor
  await page.keyboard.press('Escape');
  await eventually(layout, { left: 250, right: 300, top: true }, 'Escape leaves focus mode');
  await expectShown(page, '#sceneMeta');

  await page.click('#btnFocus');
  await eventually(layout, { left: 0, right: 0, top: false }, 'focus mode via the Focus button');
  await page.keyboard.press('Escape');
  await eventually(layout, { left: 250, right: 300, top: true }, 'Escape again');

  // ◀ / ▶ buttons
  await page.click('#toggleLeft');
  await eventually(layout, { left: 0, right: 300, top: true }, 'left collapsed');
  await expectText(page, '#toggleLeft', '▶');
  await page.click('#toggleLeft');
  await eventually(layout, { left: 250, right: 300, top: true }, 'left restored');
  await expectText(page, '#toggleLeft', '◀');
  await page.click('#toggleRight');
  await eventually(layout, { left: 250, right: 0, top: true }, 'right collapsed');
  await expectText(page, '#toggleRight', '◀');
  await page.click('#toggleRight');
  await eventually(layout, { left: 250, right: 300, top: true }, 'right restored');
  await expectText(page, '#toggleRight', '▶');

  // Ctrl+\ and Ctrl+/
  await page.keyboard.press('Control+Backslash');
  await eventually(layout, { left: 0, right: 300, top: true }, 'Ctrl+\\');
  await page.keyboard.press('Control+Slash');
  await eventually(layout, { left: 0, right: 0, top: true }, 'Ctrl+/');
  await page.keyboard.press('Control+Backslash');
  await page.keyboard.press('Control+Slash');
  await eventually(layout, { left: 250, right: 300, top: true }, 'both back');

  const { data } = await save(page);
  assert.match(sceneIn(data, 'Сцена').content, /Текст в фокусе/);
});

flow('focus mode can be left with the mouse (Exit Focus button)', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена', '<p>Текст</p>'))]));
  await page.click('#btnFocus');
  await eventually(() => layoutOf(page), { left: 0, right: 0, top: false }, 'focus mode on');
  const area = await page.locator('#editorArea').boundingBox();
  await page.mouse.move(area.x + area.width / 2, area.y + 2);   // the top edge reveals the exit button
  await page.locator('#exitFocus').click({ timeout: 3000 });
  await eventually(() => layoutOf(page), { left: 250, right: 300, top: true }, 'focus mode off');
}, { todo: 'bug: #exitFocus keeps its .hidden class forever (setFocus never removes it), so in focus mode — where the top bar and its Focus button are hidden too — there is no way out with the mouse' });

async function seedRecoverable(page, text) {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('a', 'Сцена A', '<p>Начало</p>'), sc('b', 'Сцена B'))]));
  await typeAtEnd(page, text);
  await expectIndicator(page, 'Unsaved');
}
const backupHas = (page, text) => page.evaluate(t => Object.keys(localStorage).some(k => (localStorage.getItem(k) || '').includes(t)), text);

flow('recovery: the periodic backup of unsaved work is offered and restored after a reload', async page => {
  await seedRecoverable(page, ' и восстановленный текст');
  // the 10-second backup runs on its own while the novel is dirty
  await eventually(() => backupHas(page, 'восстановленный текст'), true, 'periodic backup written', 15000);
  await page.reload();
  await appReady(page);
  await expectShown(page, '#modalOverlay');
  await expectText(page, '#modalTitle', 'Recover unsaved work');
  await page.click('#modalOk');
  await expectShown(page, '#modalOverlay', false);
  await expectShown(page, '#emptyState', false);
  assert.deepEqual(await treeOutline(page), [['Глава', ['Сцена A', 'Сцена B']]]);
  await eventually(() => editorText(page), 'Начало и восстановленный текст', 'recovered text');
  await expectIndicator(page, 'Unsaved');   // recovered work is not on disk yet
  const { data } = await save(page);
  assert.match(sceneIn(data, 'Сцена A').content, /Начало и восстановленный текст/);

  // once saved there is nothing left to recover
  await page.reload();
  await appReady(page);
  await page.waitForTimeout(300);   // startup's recovery check runs right after the first render
  assert.equal(await isShown(page, '#modalOverlay'), false, 'no recovery offer after a save');
});

flow('recovery: Cancel keeps the start screen and the backup', async page => {
  await seedRecoverable(page, ' — несохранённое');
  await openSceneFromTree(page, 'Сцена B');   // switching scenes with unsaved work backs it up at once
  await eventually(() => backupHas(page, 'несохранённое'), true, 'backup on scene switch');
  await page.reload();
  await appReady(page);
  await expectText(page, '#modalTitle', 'Recover unsaved work');
  await page.click('#modalCancel');
  await expectShown(page, '#modalOverlay', false);
  await expectShown(page, '#emptyState');
  assert.deepEqual(await treeOutline(page), []);
  // declined, not discarded: offered again on the next start
  await page.reload();
  await appReady(page);
  await expectText(page, '#modalTitle', 'Recover unsaved work');
  await expectShown(page, '#modalOverlay');
});

flow('settings: a custom note type appears in the Add Note type list', async page => {
  await openFixture(page, novelOf([ch('c1', 'Глава', sc('s1', 'Сцена', '<p>Герой нашёл ключ.</p>'))]));
  await openAccordion(page, 'settings');
  const typeRows = () => page.evaluate(() => [...document.querySelectorAll('#noteTypeList .nt-row')].map(r => [r.querySelector('.nt-icon').textContent, r.querySelector('.nt-name').textContent, r.querySelector('.nt-color').value]));
  assert.equal((await typeRows()).length, 5, 'five default types');
  await page.click('#btnAddNoteType');
  await page.locator('#noteTypeList .ntf-name').click();
  await page.keyboard.type('Сюжет');
  await page.locator('#noteTypeList .ntf-color').fill('#123456');
  await page.locator('#noteTypeList .ntf-icon').click();
  await page.keyboard.type('★');
  await page.locator('#noteTypeList .ntf-save').click();
  await eventually(async () => (await typeRows()).at(-1), ['★', 'Сюжет', '#123456'], 'custom type row');
  await expectIndicator(page, 'Unsaved');

  await selectInEditor(page, 'ключ');
  await page.keyboard.press('Control+Shift+M');
  await expectShown(page, '#notePopup');
  assert.ok((await page.locator('#npType option').allTextContents()).includes('★ Сюжет'));
  await page.selectOption('#npType', { label: '★ Сюжет' });
  await page.click('#npContent');
  await page.keyboard.type('Откуда ключ?');
  await page.click('#npAdd');
  await openAccordion(page, 'notes');
  await eventually(() => page.locator('#noteList .nl-type').allTextContents().then(t => t.map(s => s.trim())), ['★ Сюжет'], 'note of the custom type');
  assert.ok((await page.locator('#noteFilters .filter-pill').allTextContents()).map(s => s.trim()).includes('★ Сюжет (1)'));
  const dotColor = await page.locator('#marginNotes .note-dot').evaluate(d => getComputedStyle(d).backgroundColor);
  assert.equal(dotColor, 'rgb(18, 52, 86)');

  const { data } = await save(page);
  assert.equal(data.settings.customNoteTypes.length, 1);
  const t = data.settings.customNoteTypes[0];
  assert.deepEqual([t.name, t.color, t.icon], ['Сюжет', '#123456', '★']);
  assert.equal(sceneIn(data, 'Сцена').notes[0].typeId, t.id);
});

flow('export menu: TXT, HTML and Markdown carry the text; notes export TXT and MD', async page => {
  await openFixture(page, novelOf([
    ch('c1', 'Глава первая', sc('s1', 'Утро', '<p>Он проснулся <b>рано</b> и <i>тихо</i> встал.</p>', {
      notes: [{ id: 'n1', typeId: 'fix', content: 'Уточнить время', selectedText: 'рано', startOffset: 12, endOffset: 16, createdAt: '2024-01-15T10:00:00Z' }]
    })),
    ch('c2', 'Глава вторая', sc('s2', 'Вечер', '<p>Наступил вечер.</p>'))
  ], { title: 'Повесть' }));
  await typeAtEnd(page, ' Конец сцены.');   // unsaved text is exported too

  const exportVia = async attr => {
    await page.click('#btnExport');
    await expectShown(page, '#exportMenu');
    return downloadOf(page, () => page.click(`#exportMenu [${attr}]`));
  };
  const txt = await exportVia('data-export="txt"');
  assert.equal(txt.name, 'Повесть.txt');
  assert.match(txt.text, /^ГЛАВА ПЕРВАЯ\n\nОн проснулся рано и тихо встал\. Конец сцены\.\n\n\nГЛАВА ВТОРАЯ\n\nНаступил вечер\.$/);

  const html = await exportVia('data-export="html"');
  assert.equal(html.name, 'Повесть.html');
  assert.match(html.text, /^<!DOCTYPE html><html lang="ru">/);
  assert.match(html.text, /<h1>Глава первая<\/h1>[\s\S]*<h2>Утро<\/h2>[\s\S]*<b>рано<\/b>[\s\S]*<i>тихо<\/i>[\s\S]*Конец сцены\.[\s\S]*<h1>Глава вторая<\/h1>[\s\S]*<h2>Вечер<\/h2>[\s\S]*Наступил вечер\./);

  const md = await exportVia('data-export="md"');
  assert.equal(md.name, 'Повесть.md');
  assert.match(md.text, /^# Глава первая\n\n## Утро\n\nОн проснулся \*\*рано\*\* и \*тихо\* встал\. Конец сцены\.\n\n---\n\n# Глава вторая\n\n## Вечер\n\nНаступил вечер\.$/);

  const ntxt = await exportVia('data-export-notes="txt"');
  assert.equal(ntxt.name, 'Повесть-notes.txt');
  assert.match(ntxt.text, /^NOTES FOR: Глава первая › Утро\n─+\n\[Fix\] “рано” — Уточнить время \(.+\)/);

  const nmd = await exportVia('data-export-notes="md"');
  assert.equal(nmd.name, 'Повесть-notes.md');
  assert.match(nmd.text, /^# Notes\n\n## Глава первая › Утро\n\n- \*\*\[Fix\]\*\* “рано” — Уточнить время _\(.+\)_/);

  await expectIndicator(page, 'Unsaved');   // exporting is not saving
});
