/* `npm run serve`: the frontend in a plain browser, without Tauri (no file dialogs, Save is a
   download; see the hasTauri fallbacks). src/ cannot be opened from disk: browsers refuse to
   load ES modules from file:// URLs. `npm run serve -- --csp` adds the desktop CSP header.

   The e2e suites serve the app through serveApp() as well. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
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

/* Serve src/ over http on loopback (port 0 = any free port), optionally with the desktop CSP
   header. The tests need http as well: the policy is sent as a response header, which
   Playwright cannot attach to file:// pages, and Chromium refuses fetch() of file:// URLs,
   which the PDF export uses to load src/fonts/pdf/*.ttf.
   Resolves to { url, close }. */
export async function serveApp({ csp = false, port = 0 } = {}) {
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
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const { port: bound } = server.address();
  return { url: `http://127.0.0.1:${bound}/index.html`, close: () => new Promise(r => server.close(r)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serveApp({ csp: process.argv.includes('--csp'), port: Number(process.env.PORT) || 1420 });
  console.log(`NovelCraft (browser mode) at ${url} — Ctrl+C to stop`);
}
