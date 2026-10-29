/* Lift a block of code out of a UI module of src/js/ to run it in node.
 *
 * Most of the app's logic lives in src/js/lib/, which never touches the DOM when imported,
 * and the suites import it directly. A few functions that are worth testing live in UI
 * modules instead, because they read app state or call a helper that needs a real DOM;
 * importing such a module in node would evaluate its DOM lookups and fail. Those functions
 * sit between `/* --- <name>:start ---` and `/* --- <name>:end --- *\/` marker comments, and
 * a test lifts the block and runs it with stand-ins for everything it reaches outside.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'src', 'js');
// Normalized so liftFunction() finds '\n}\n' whatever line endings the checkout has.
const read = file => readFileSync(join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
// The lifted text is evaluated by new Function(), where `export` is a syntax error.
const unexport = src => src.replace(/^export /gm, '');

/* The source between the `name` markers in src/js/<file>. */
export function lift(file, name) {
  const src = read(file);
  const start = src.indexOf(`/* --- ${name}:start ---`);
  const end = src.indexOf(`/* --- ${name}:end --- */`);
  assert.ok(start !== -1 && end > start, `${name} markers missing from src/js/${file} — the code moved, update this test`);
  return unexport(src.slice(start, end));
}

/* One top-level function declaration of src/js/<file>, by name. */
export function liftFunction(file, name) {
  const src = read(file);
  const start = src.search(new RegExp(`^(export )?function ${name}\\(`, 'm'));
  const end = src.indexOf('\n}\n', start) + 3;
  assert.ok(start !== -1 && end > start, `${name}() not found in src/js/${file} — update this test`);
  return unexport(src.slice(start, end));
}

/* Compile lifted source into a function of the given parameters (the stand-ins), running
   in strict mode like the module it came from. */
export function compile(params, src, ret) {
  return new Function(...params, `'use strict';\n${src}\nreturn ${ret};`);
}
