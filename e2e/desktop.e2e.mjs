/* Desktop regression suite: the real Tauri app (WebKitGTK + the Rust backend) driven over
 * WebDriver through tauri-driver. Linux only. Run with `npm run test:desktop` after a debug
 * build (`npx tauri build --debug --no-bundle`), under a display (CI uses xvfb-run).
 *
 * Needs on PATH: tauri-driver (`cargo install tauri-driver --locked`), WebKitWebDriver
 * (package webkit2gtk-driver) and, for the file-dialog check, xdotool.
 * NOVELCRAFT_BIN overrides the app binary (default: src-tauri/target/debug/novelcraft).
 *
 * The app runs with XDG_CONFIG_HOME and XDG_DATA_HOME pointed at a temporary directory, so the
 * developer's own recent-files list, window state and backups are never touched. The backup
 * interval is an hour (NOVELCRAFT_BACKUP_INTERVAL_SECS) so no timing can sneak in a second one.
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const DATA = join(WORK, 'data');
const CRAFTED = join(WORK, 'crafted.novel');
const CRAFTED_JSON = JSON.stringify(craftedNovel(), null, 2);
const BACKUPS = join(DATA, 'com.novelcraft.desktop', 'backups');
const PICKED = join(WORK, 'picked.novel');
const STALE = join(WORK, 'stale.novel');      // in the recent list at launch, dropped from it later
const ORPHAN = join(WORK, 'orphan.novel');    // where a recovery backup claims the novel lived
const smallNovel = title => JSON.stringify({ title, chapters: [{ title: 'C', scenes: [{ title: 'S', content: `<p>${title}</p>` }] }] });
// tauri-driver listens on PORT and starts WebKitWebDriver on NATIVE_PORT. Both are explicit
// and disjoint (the native default, 4445, would collide with a PORT drawn near it).
const PORT = 5000 + Math.floor(Math.random() * 1000);
const NATIVE_PORT = PORT + 1000;

let driver, session;

/* Minimal WebDriver client (tauri-driver speaks plain W3C WebDriver). */
async function wd(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000)   // a wedged driver fails the test instead of hanging the job
  });
  const json = await res.json();
  if (json.value && json.value.error) throw new Error(`${json.value.error}: ${json.value.message}`);
  return json.value;
}
const exec = (script, args = []) => wd('POST', `/session/${session}/execute/sync`, { script, args });
const execAsync = (script, args = []) => wd('POST', `/session/${session}/execute/async`, { script, args });
const invoke = (cmd, args) => execAsync(`const done = arguments[arguments.length - 1];
  window.__TAURI__.core.invoke(arguments[0], arguments[1]).then(v => done({ ok: true, v }), e => done({ ok: false, e: String(e) }));`, [cmd, args]);

/* (Re)start the app in a fresh WebDriver session. Each native file-dialog test gets its own
   app process: under Xvfb (no window manager) GTK file dialogs opened one after another in
   the same process are unreliable — the dialog plugin's own `open` command behaves the same
   way — so a dialog is only ever the first one its process shows. */
async function startApp() {
  if (session) { await wd('DELETE', `/session/${session}`).catch(() => {}); session = null; }
  const created = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: BIN } } } });
  session = created.sessionId;
  await sleep(2500);   // startup: recent menu, recovery check, last-file load
}

test.before(async () => {
  if (skip) return;
  mkdirSync(APP_CONFIG, { recursive: true });
  writeFileSync(CRAFTED, CRAFTED_JSON);
  writeFileSync(PICKED, smallNovel('Picked'));
  writeFileSync(STALE, smallNovel('Stale'));
  writeFileSync(ORPHAN, smallNovel('Orphan on disk'));
  // The crafted file is a "recent" file: opened in an earlier session, so it may be read/written.
  writeFileSync(join(APP_CONFIG, 'recent.json'), JSON.stringify([CRAFTED, STALE]));
  // A crash backup whose path the user never opened in the app (not recent, not last file).
  writeFileSync(join(APP_CONFIG, 'working.novel'), JSON.stringify({ ts: 1, path: ORPHAN, novel: JSON.parse(smallNovel('Recovered')) }));
  driver = spawn('tauri-driver', ['--port', String(PORT), '--native-port', String(NATIVE_PORT)], {
    env: { ...process.env, XDG_CONFIG_HOME: CONFIG, XDG_DATA_HOME: DATA, NOVELCRAFT_BACKUP_INTERVAL_SECS: '3600' }, stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(2000) }); break; } catch { await sleep(200); }
  }
  await startApp();
  await exec(`window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective));`);
});

test.after(async () => {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => {});
  if (driver) driver.kill();
});

test('a backup whose file this session may not write is restored as unsaved', { skip }, async () => {
  // startup shows the recovery prompt; accept it
  await exec(`document.getElementById('modalOk').click();`);
  await sleep(1500);
  const st = await exec(`return { title: novel && novel.title, path: currentFilePath, indicator: document.getElementById('filePathIndicator').textContent, dirty };`);
  assert.strictEqual(st.title, 'Recovered');
  assert.strictEqual(st.path, null, 'the remembered path must be dropped, not kept as an unwritable target');
  assert.strictEqual(st.indicator, '• Unsaved');
  assert.strictEqual(st.dirty, true);
  assert.match(readFileSync(ORPHAN, 'utf8'), /Orphan on disk/, 'the orphan file is untouched');
});

test('the backend refuses paths that were never chosen in a dialog', { skip }, async () => {
  const outside = join(WORK, 'planted.txt');
  for (const [cmd, args] of [
    ['write_text', { path: outside, content: 'x' }],
    ['write_binary', { path: outside, base64: 'aGk=' }],
    ['read_text', { path: '/etc/hostname' }],
    ['add_recent_file', { path: outside }],
    ['set_last_file', { path: outside }],
    ['save_novel', { path: outside, content: 'x' }],
    ['backup_now', { path: outside }],
    ['list_backups', { path: '/etc/hostname' }],
    ['read_backup', { path: outside, name: '1.novel' }]
  ]) {
    const r = await invoke(cmd, args);
    assert.strictEqual(r.ok, false, `${cmd} must be refused`);
    assert.match(r.e, /access denied/, cmd);
  }
  assert.strictEqual(existsSync(outside), false, 'nothing may be written');
  const recent = await invoke('read_text', { path: CRAFTED });
  assert.strictEqual(recent.ok, true, 'a recent file stays readable: ' + recent.e);
});

test('Open Recent entries from launch stay openable after the recent list moves on', { skip }, async () => {
  // The native menu was built from [CRAFTED, STALE]; newer files push STALE out of recent.json.
  writeFileSync(join(APP_CONFIG, 'recent.json'), JSON.stringify([CRAFTED]));
  const r = await invoke('read_text', { path: STALE });
  assert.strictEqual(r.ok, true, 'a path shown in the launch-time menu must stay readable: ' + r.e);
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

test('a save keeps the version it replaces; Restore from Backup brings one back, sanitized', { skip }, async () => {
  // The Ctrl+S above (or an autosave before it) was the first save of CRAFTED: the file as it
  // was is now a backup, byte for byte.
  let list = (await invoke('list_backups', { path: CRAFTED })).v;
  assert.strictEqual(list.length, 1, JSON.stringify(list));
  assert.strictEqual((await invoke('read_backup', { path: CRAFTED, name: list[0].name })).v, CRAFTED_JSON);
  // Another save inside the interval takes none. The edit and the save run in one task, so the
  // 30 s autosave cannot slip in between.
  assert.strictEqual(await execAsync(`const done = arguments[arguments.length - 1];
    const ed = document.getElementById('editor'); ed.focus();
    getSelection().selectAllChildren(ed); getSelection().collapseToEnd();
    document.execCommand('insertText', false, ' Вторая правка');
    doSave().then(done);`), true);
  assert.match(readFileSync(CRAFTED, 'utf8'), /Вторая правка/);
  assert.strictEqual((await invoke('list_backups', { path: CRAFTED })).v.length, 1, 'at most one backup per interval');

  // Restore the original through the dialog. It is the crafted file: it must load sanitized,
  // and the file as it is now must be backed up first even inside the interval.
  await execAsync(`const done = arguments[arguments.length - 1]; openBackups().then(() => done(1));`);
  assert.strictEqual(await exec(`return document.querySelectorAll('#backupOverlay:not(.hidden) .backup-row').length;`), 1);
  await exec(`document.querySelector('#backupList .backup-row button').click();`);
  await sleep(1500);
  const st = await exec(`return { text: document.getElementById('editor').textContent, html: document.getElementById('editor').innerHTML,
    dirty, path: currentFilePath, open: !document.getElementById('backupOverlay').classList.contains('hidden'), pwn: window.__pwn || null };`);
  assert.match(st.text, /Привет/);
  assert.doesNotMatch(st.text, /Добавлено|Вторая правка/);
  assert.doesNotMatch(st.html, /onerror|<svg|<script|<style|<iframe|javascript:/i);
  assert.deepStrictEqual({ path: st.path, open: st.open, pwn: st.pwn }, { path: CRAFTED, open: false, pwn: null });
  const disk = readFileSync(CRAFTED, 'utf8');
  assert.ok(st.dirty ? /Вторая правка/.test(disk) : !/Вторая правка/.test(disk),
    'the restored version is unsaved until a save (or the autosave) writes it');
  list = (await invoke('list_backups', { path: CRAFTED })).v;
  assert.strictEqual(list.length, 2, 'the version on disk was backed up before the restore');
  assert.match((await invoke('read_backup', { path: CRAFTED, name: list[0].name })).v, /Вторая правка/);

  // A backup name is a file name in that file's backup folder, nothing else. Each of these
  // points at a real file the session was never given.
  const [hash] = readdirSync(BACKUPS);
  const names = [ORPHAN, '../../../../orphan.novel', '../../../../config/com.novelcraft.desktop/recent.json', 'source.txt'];
  for (const name of names) {
    assert.ok(existsSync(name.startsWith('/') ? name : join(BACKUPS, hash, name)), `fixture: ${name} exists`);
    const r = await invoke('read_backup', { path: CRAFTED, name });
    assert.strictEqual(r.ok, false, `read_backup must refuse ${name}`);
    assert.match(r.e, /not a backup/, name);
  }
});

test('while a file dialog is open the window is shielded and the work stays unsaved', { skip: skip || (!has('xdotool') && 'xdotool is not installed') }, async () => {
  await startApp();
  await exec(`if (!document.getElementById('modalOverlay').classList.contains('hidden')) document.getElementById('modalCancel').click();
    setCurrentNovel(newNovel('Shield'), null);`);
  await sleep(300);
  await exec(`document.getElementById('editor').focus(); document.execCommand('insertText', false, ' правка');`);
  await sleep(300);
  await exec(`window.__saveAs = doSave(true);`);   // opens the native Save dialog
  await sleep(2500);
  const during = await exec(`const b = document.getElementById('toggleLeft').getBoundingClientRect();
    return { shield: document.body.classList.contains('native-dialog'), dirty,
      overlay: getComputedStyle(document.body, '::after').position,
      hit: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2).tagName };`);
  assert.deepStrictEqual(during, { shield: true, dirty: true, overlay: 'fixed', hit: 'BODY' },
    'shielded (clicks land on the overlay), and nothing counts as saved yet');
  // keyboard and close attempts behind the dialog are ignored: the keystroke never reaches
  // the shortcut handler (or any other listener), so no second save starts
  await exec(`const orig = window.doSave; window.__saves = 0; window.doSave = (...a) => (window.__saves++, orig(...a));
    window.__reached = false; document.addEventListener('keydown', () => { window.__reached = true; });
    document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }));
    requestClose();`);
  await sleep(500);
  const still = await exec(`return { saves: window.__saves, reached: window.__reached,
    closePrompt: !document.getElementById('closeOverlay').classList.contains('hidden'), dirty };`);
  assert.deepStrictEqual(still, { saves: 0, reached: false, closePrompt: false, dirty: true });
  execFileSync('sh', ['-c', 'xdotool search --sync --onlyvisible --name "Save" windowfocus --sync key Escape'], { timeout: 20000 });
  await sleep(1000);
  const after = await exec(`return { shield: document.body.classList.contains('native-dialog'), dirty, indicator: document.getElementById('saveIndicator').textContent };`);
  assert.deepStrictEqual(after, { shield: false, dirty: true, indicator: 'Unsaved' });
});

test('the Open dialog runs off the main thread and grants the picked file', { skip: skip || (!has('xdotool') && 'xdotool is not installed') }, async () => {
  await startApp();
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
