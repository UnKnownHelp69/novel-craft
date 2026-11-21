/* Stage the licensed editor fonts beside the static frontend for offline use. */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'src/fonts/editor');
await mkdir(out, { recursive: true });
const faces = [];
for (const family of ['lora', 'merriweather', 'inter', 'roboto', 'roboto-mono']) {
  const source = join(root, 'node_modules/@fontsource-variable', family);
  const css = await readFile(join(source, 'wght.css'), 'utf8');
  for (const [, name] of css.matchAll(/url\(\.\/files\/([\w-]+\.woff2)\)/g)) {
    await copyFile(join(source, 'files', name), join(out, name));
  }
  faces.push(css.replaceAll(" Variable'", "'").replaceAll('url(./files/', 'url(./'));
  await copyFile(join(source, 'LICENSE'), join(out, family + '-LICENSE.txt'));
}
await writeFile(join(out, 'faces.css'), faces.join('\n'));
