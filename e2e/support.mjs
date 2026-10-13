/* Shared helpers for the e2e suites (e2e/*.e2e.mjs). Not picked up by `npm test`: node --test
 * only collects *.test.* files and files under test/. */
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/* The Content-Security-Policy the desktop app runs under, straight from tauri.conf.json, so
   the browser suite exercises the exact same policy. */
export function desktopCsp() {
  const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const csp = conf.app.security.csp;
  return typeof csp === 'string' ? csp : Object.entries(csp).map(([k, v]) => `${k} ${v}`).join('; ');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};

/* Serve src/ over http (Playwright cannot attach headers to file:// pages), optionally with
   the desktop CSP header. Resolves to { url, close }. */
export async function serveApp({ csp = false } = {}) {
  const policy = csp ? desktopCsp() : null;
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(SRC, path || 'index.html');
    if (!file.startsWith(SRC)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      const headers = { 'content-type': TYPES[extname(file)] || 'application/octet-stream' };
      if (policy) headers['content-security-policy'] = policy;
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/index.html`, close: () => new Promise(r => server.close(r)) };
}

/* A Chromium to drive: $CHROME_PATH if set, else Playwright's own build (when
   PLAYWRIGHT_BROWSERS_PATH has one), else the system Google Chrome (GitHub runners). */
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

/* Open a .novel through the app's own browser-mode Open flow (the file input it creates). */
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
