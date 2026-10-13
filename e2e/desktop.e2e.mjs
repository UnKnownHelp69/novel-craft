/* Desktop regression suite: the real Tauri app (WebKitGTK + the Rust backend) driven over
 * WebDriver through tauri-driver. Linux only. Run with `npm run test:desktop` after a debug
 * build (`npx tauri build --debug --no-bundle`), under a display (CI uses xvfb-run).
 *
 * Needs on PATH: tauri-driver (`cargo install tauri-driver --locked`), WebKitWebDriver
 * (package webkit2gtk-driver) and, for the file-dialog check, xdotool.
 * NOVELCRAFT_BIN overrides the app binary (default: src-tauri/target/debug/novelcraft).
 *
 * The app runs with XDG_CONFIG_HOME pointed at a temporary directory, so the developer's own
 * recent-files list and window state are never touched.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, craftedNovel } from './support.mjs';

const BIN = process.env.NOVELCRAFT_BIN || join(ROOT, 'src-tauri', 'target', 'debug', 'novelcraft');
const has = cmd => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = process.platform !== 'linux' ? 'Linux only'
  : !existsSync(BIN) ? `no app binary at ${BIN} — run \`npx tauri build --debug --no-bundle\``
  : !has('tauri-driver') ? 'tauri-driver is not installed'
  : !process.env.DISPLAY ? 'no DISPLAY — run under xvfb-run'
  : false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WORK = mkdtempSync(join(tmpdir(), 'novelcraft-desktop-'));
const CONFIG = join(WORK, 'config');
const APP_CONFIG = join(CONFIG, 'com.novelcraft.desktop');
const CRAFTED = join(WORK, 'crafted.novel');
const PICKED = join(WORK, 'picked.novel');
const PORT = 4444 + Math.floor(Math.random() * 1000);

let driver, session;

/* Minimal WebDriver client (tauri-driver speaks plain W3C WebDriver). */
async function wd(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (json.value && json.value.error) throw new Error(`${json.value.error}: ${json.value.message}`);
  return json.value;
}
const exec = (script, args = []) => wd('POST', `/session/${session}/execute/sync`, { script, args });
const execAsync = (script, args = []) => wd('POST', `/session/${session}/execute/async`, { script, args });
const invoke = (cmd, args) => execAsync(`const done = arguments[arguments.length - 1];
  window.__TAURI__.core.invoke(arguments[0], arguments[1]).then(v => done({ ok: true, v }), e => done({ ok: false, e: String(e) }));`, [cmd, args]);

test.before(async () => {
  if (skip) return;
  mkdirSync(APP_CONFIG, { recursive: true });
  writeFileSync(CRAFTED, JSON.stringify(craftedNovel(), null, 2));
  writeFileSync(PICKED, JSON.stringify({ title: 'Picked', chapters: [{ title: 'C', scenes: [{ title: 'S', content: '<p>picked</p>' }] }] }));
  // The crafted file is a "recent" file: opened in an earlier session, so it may be read/written.
  writeFileSync(join(APP_CONFIG, 'recent.json'), JSON.stringify([CRAFTED]));
  driver = spawn('tauri-driver', ['--port', String(PORT)], { env: { ...process.env, XDG_CONFIG_HOME: CONFIG }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/status`); break; } catch { await sleep(200); }
  }
  const created = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: BIN } } } });
  session = created.sessionId;
  await sleep(2500);   // startup: recent menu, recovery check, last-file load
  await exec(`window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective));`);
});

test.after(async () => {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => {});
  if (driver) driver.kill();
});

test('the backend refuses paths that were never chosen in a dialog', { skip }, async () => {
  const outside = join(WORK, 'planted.txt');
  for (const [cmd, args] of [
    ['write_text', { path: outside, content: 'x' }],
    ['write_binary', { path: outside, base64: 'aGk=' }],
    ['read_text', { path: '/etc/hostname' }],
    ['add_recent_file', { path: outside }],
    ['set_last_file', { path: outside }]
  ]) {
    const r = await invoke(cmd, args);
    assert.strictEqual(r.ok, false, `${cmd} must be refused`);
    assert.match(r.e, /access denied/, cmd);
  }
  assert.strictEqual(existsSync(outside), false, 'nothing may be written');
  const recent = await invoke('read_text', { path: CRAFTED });
  assert.strictEqual(recent.ok, true, 'a recent file stays readable: ' + recent.e);
});

test('a crafted .novel opens without running its script', { skip }, async () => {
  await execAsync(`const done = arguments[arguments.length - 1]; loadFromPath(arguments[0]).then(() => done(1));`, [CRAFTED]);
  await sleep(1000);
  await exec(`document.querySelectorAll('.accordion').forEach(a => a.classList.add('open'));
    openNoteCard('n1');
    openCompile(); loadPreset(novel.settings.compilationPresets[0].id); compPreview = true; renderComp(); closeCompile();
    openGraph(); openCharPanel(novel.characters[0]); closeGraph();`);
  await sleep(1000);
  const st = await exec(`return { pwn: window.__pwn || null, title: document.title, editor: document.getElementById('editor').innerHTML };`);
  assert.strictEqual(st.pwn, null, 'payloads ran: ' + JSON.stringify(st.pwn));
  assert.strictEqual(st.title, 'NovelCraft — Crafted');
  assert.doesNotMatch(st.editor, /onerror|<svg|<script|<style|<iframe|javascript:/i);
});

test('CSP blocks inline handlers but the app keeps working under it', { skip }, async () => {
  await exec(`const d = document.createElement('div'); d.innerHTML = '<img src="data:," onerror="window.__cspBypass = 1">'; document.body.appendChild(d);`);
  await sleep(800);
  const st = await exec(`return {
    bypass: window.__cspBypass || null, violations: window.__csp,
    rules: (document.getElementById('noteHiliteStyles').sheet || { cssRules: [] }).cssRules.length,
    attr: getComputedStyle(document.querySelector('.ts-status')).getPropertyValue('--sc').trim()
  };`);
  assert.strictEqual(st.bypass, null, 'an inline handler ran');
  assert.ok(st.violations.some(v => v.startsWith('script-src')), 'the blocked handler should be reported');
  assert.ok(st.rules > 0, 'injected <style> rules must still apply');
  assert.notStrictEqual(st.attr, '', 'style attributes must still apply');
  const glyphs = await execAsync(`const done = arguments[arguments.length - 1]; loadPdfFont('F1').then(f => done(f.numGlyphs), e => done('ERR ' + e.message));`);
  assert.ok(typeof glyphs === 'number' && glyphs > 0, 'PDF font fetch (connect-src): ' + glyphs);
});

test('Ctrl+S on a Russian layout saves to the open file', { skip }, async () => {
  await exec(`const ed = document.getElementById('editor'); ed.focus();
    getSelection().selectAllChildren(ed); getSelection().collapseToEnd();
    document.execCommand('insertText', false, ' Добавлено');`);
  await sleep(300);
  await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ы', code: 'KeyS', ctrlKey: true, bubbles: true }));`);
  await sleep(1500);
  const saved = JSON.parse(readFileSync(CRAFTED, 'utf8'));
  assert.match(saved.chapters[0].scenes[0].content, /Добавлено/);
  assert.doesNotMatch(saved.chapters[0].scenes[0].content, /onerror/, 'the saved file is the sanitized one');
  assert.strictEqual(await exec(`return document.getElementById('saveIndicator').textContent`), 'Saved');
});

test('the Open dialog runs off the main thread and grants the picked file', { skip: skip || (!has('xdotool') && 'xdotool is not installed') }, async () => {
  const pending = invoke('pick_open');
  await sleep(2500);
  // GTK file chooser: Ctrl+L opens the location field; type the path and confirm.
  execFileSync('sh', ['-c', `xdotool search --sync --onlyvisible --name "Open" windowfocus --sync key --clearmodifiers ctrl+l;
    sleep 0.5; xdotool type --delay 20 '${PICKED}'; sleep 0.5; xdotool key Return`], { timeout: 20000 });
  const picked = await Promise.race([pending, sleep(20000).then(() => ({ ok: false, e: 'timed out — the dialog froze the app?' }))]);
  assert.strictEqual(picked.ok, true, picked.e);
  assert.strictEqual(picked.v, PICKED);
  const read = await invoke('read_text', { path: picked.v });
  assert.strictEqual(read.ok, true, 'a picked file must be readable: ' + read.e);
  assert.match(read.v, /Picked/);
});
