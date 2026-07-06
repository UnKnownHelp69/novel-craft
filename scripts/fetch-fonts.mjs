/* Downloads the woff2 files for the bundled Google Fonts so the app works
   fully offline. Run once with internet access:  node scripts/fetch-fonts.mjs
   Requires Node 18+ (built-in fetch). */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'src', 'fonts');

// Google Fonts css2 endpoints; we parse out the first woff2 url for weight 400.
const fonts = {
  'lora.woff2': 'https://fonts.googleapis.com/css2?family=Lora:wght@400&display=swap',
  'merriweather.woff2': 'https://fonts.googleapis.com/css2?family=Merriweather:wght@400&display=swap',
  'inter.woff2': 'https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap',
  'roboto.woff2': 'https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap',
  'roboto-mono.woff2': 'https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400&display=swap'
};

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NovelCraft font fetcher' };

async function run() {
  await mkdir(outDir, { recursive: true });
  for (const [file, cssUrl] of Object.entries(fonts)) {
    try {
      const css = await (await fetch(cssUrl, { headers: UA })).text();
      const m = css.match(/url\((https:[^)]+\.woff2)\)/);
      if (!m) { console.warn('No woff2 found for', file); continue; }
      const buf = Buffer.from(await (await fetch(m[1])).arrayBuffer());
      await writeFile(join(outDir, file), buf);
      console.log('saved', file, buf.length, 'bytes');
    } catch (e) {
      console.warn('failed', file, e.message);
    }
  }
  console.log('Done. Fonts are optional — missing files fall back to system fonts.');
}
run();
