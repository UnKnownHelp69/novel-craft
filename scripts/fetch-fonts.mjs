/* `npm run fonts`: downloads the editor's Google Fonts into src/fonts/*.woff2, which
   src/fonts/fonts.css loads when the font is not installed locally. The files are
   ignored by version control, so they are only bundled into builds made after running
   this; CI and release builds never run it. Without them the editor falls back to
   system fonts. (The PDF export's fonts are separate, committed .ttf files in
   src/fonts/pdf/.)

   KNOWN ISSUE: this currently saves nothing. Google Fonts chooses the format by
   User-Agent, and the UA below (no browser engine token) is served TrueType, so the
   woff2 regex never matches. A modern-browser UA gets woff2, but split into
   unicode-range subsets with cyrillic-ext first, so taking only the first url would
   drop Latin. A fix has to fetch the latin and cyrillic subsets (or a full TTF, with
   fonts.css changed to match). */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'src', 'fonts');

// Weight 400 only, although fonts.css declares each face for the range 400–700.
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
