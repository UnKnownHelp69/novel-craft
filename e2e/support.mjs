/* Shared helpers for the e2e suites (e2e/*.e2e.mjs). Not picked up by `npm test`: node --test
 * only collects *.test.* files and files under test/. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

export { serveApp, desktopCsp } from '../scripts/serve.mjs';

export const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/* Every module of the app, as a URL relative to index.html (js/main.js, js/lib/text.js, …). */
export const APP_MODULES = readdirSync(join(SRC, 'js'), { recursive: true })
  .filter(f => f.endsWith('.js')).map(f => relative(SRC, join(SRC, 'js', f)).split(sep).join('/'));

/* Runs in the page, never in node: imports every app module and exposes `window.app`, a
   read-only view of all their exports. Module bindings are live, so `app.dirty` is the
   current value, not a copy; a module instance is shared by URL, so these are the very
   modules the running app uses. The white-box suites (browser, desktop) reach app
   internals through it; e2e/flows.e2e.mjs never does. */
export async function exposeApp(urls) {
  const mods = await Promise.all(urls.map(u => import(new URL(u, location.href).href)));
  window.app = new Proxy({}, {
    get(_, name) {
      for (const m of mods) if (name in m) return m[name];
      throw new ReferenceError(`no app module exports ${String(name)}`);
    }
  });
}

/* A Chromium to drive; playwright-core never downloads one. Tried in order: $CHROME_PATH;
   Playwright's own build (in $PLAYWRIGHT_BROWSERS_PATH or the default cache) — it is looked
   up by the revision this playwright-core expects, which is why package.json pins
   playwright-core to an exact version; the installed Google Chrome (what GitHub runners
   have). */
export async function launchChromium() {
  const { chromium } = await import('playwright-core');
  const attempts = [];
  if (process.env.CHROME_PATH) attempts.push({ executablePath: process.env.CHROME_PATH });
  attempts.push({}, { channel: 'chrome' });
  let last;
  for (const opts of attempts) {
    try { return await chromium.launch(opts); } catch (e) { last = e; }
  }
  throw new Error('no Chromium found for the e2e suite — set CHROME_PATH. Last error: ' + last.message);
}

export async function writeTempNovel(name, novel) {
  const dir = await mkdtemp(join(tmpdir(), 'novelcraft-e2e-'));
  const file = join(dir, name);
  await writeFile(file, typeof novel === 'string' ? novel : JSON.stringify(novel, null, 2));
  return file;
}

/* Open a .novel through the app's own browser-mode Open flow: #esOpen creates a hidden
   <input type=file>, which Playwright answers through the filechooser event. */
export async function openNovel(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#esOpen')]);
  await chooser.setFiles(file);
  await page.waitForFunction(() => document.getElementById('emptyState').classList.contains('hidden'));
}

/* A .novel built to run script through every sink that file data used to reach: scene HTML
   (including mutation-XSS and foreign-content tricks), ids, colours, icons, a word count,
   a compile preset. Every payload pushes a tag onto window.__pwn when it runs. */
export function craftedNovel() {
  const flag = n => `window.__pwn=(window.__pwn||[]).concat('${n}')`;
  const img = n => `<img src=x onerror="${flag(n)}">`;
  return {
    version: '1.0', title: 'Crafted',
    settings: {
      customNoteTypes: [{ id: `t"><img src=x onerror="${flag('typeid')}">`, name: 'T', color: `red">${img('color')}`, icon: img('icon') }],
      noteTypeColors: { fix: `red;}</style>${img('style')}` },
      compilationPresets: [{ id: `p">${img('preset')}`, name: 'P', settings: { font: `x;}</style>${img('font')}`, fontSize: `12pt;}</style>${img('size')}` } }]
    },
    chapters: [{ id: `c1" onmouseover="${flag('chapid')}`, title: 'Глава', scenes: [{
      id: 's1', title: 'Сцена', wordCount: img('wc'),
      content: '<p>Привет - мир <b>жирный</b> <i>курсив</i></p>' + img('scene') +
        `<svg><script>${flag('svg')}</script></svg>` +
        `<noscript><p title="</noscript>${img('mxss')}"></p></noscript>` +
        `<style>body{display:none}</style><a href="javascript:${flag('href')}">ссылка</a>` +
        `<iframe srcdoc="${img('iframe').replace(/"/g, '&quot;')}"></iframe>` +
        `<math><mi xlink:href="javascript:${flag('math')}">x</mi></math>`,
      notes: [{ id: 'n1', typeId: `t"><img src=x onerror="${flag('typeid')}">`, content: 'заметка', selectedText: 'Привет', startOffset: 0, endOffset: 6 }]
    }] }],
    characters: [{ id: 'ch1', name: 'Анна', color: `red" onfocus="${flag('charcolor')}` }],
    locations: [], races: []
  };
}
