/* Coverage for the hand-rolled ZIP writer behind both the EPUB and the DOCX export.
 *
 * makeZip() is the single shared piece of both exporters, so anything wrong in it
 * corrupts two formats at once — and corrupts them quietly: an archive with a bad CRC or
 * a bad central-directory offset is still a file of plausible size that some readers open
 * and others reject, which is the worst way for an export bug to present.
 *
 * The reader below deliberately navigates by the offsets and lengths makeZip() *declares*
 * — end-of-central-directory -> central directory -> each entry's recorded local-header
 * offset -> that header's name/extra lengths -> the data — rather than by scanning the
 * buffer for PK signatures. Scanning would happily resynchronise past a wrong offset and
 * report a healthy archive, which is exactly the class of bug these tests exist to catch.
 *
 * src/app.js is a single browser script with no module system (see CLAUDE.md), so the
 * writer is lifted out from between the `zip-core` markers and run in isolation, the same
 * technique as test/pdf-cyrillic.test.js and test/migrate-novel.test.js.
 */
import test from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'src', 'app.js'), 'utf8');

function loadZipCore() {
  const start = APP.indexOf('/* --- zip-core:start ---');
  const end = APP.indexOf('/* --- zip-core:end --- */');
  assert.ok(start !== -1 && end > start,
    'zip-core markers missing from src/app.js — the ZIP writer moved, update this test');
  // A new Function body is sloppy-mode by default; src/app.js runs under 'use strict'.
  return new Function(`'use strict';\n${APP.slice(start, end)}\nreturn { crc32, makeZip };`)();
}

const { crc32, makeZip } = loadZipCore();
const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------- a ZIP reader that trusts only the declared offsets and lengths ---------- */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_FIXED = 30;
const CENTRAL_FIXED = 46;
const EOCD_FIXED = 22;

function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = o => dv.getUint16(o, true);
  const u32 = o => dv.getUint32(o, true);

  // makeZip writes no archive comment, so the EOCD is exactly the last 22 bytes. Taking
  // it positionally rather than searching backwards for its signature means a stray
  // 0x06054b50 inside file data cannot be mistaken for the real record.
  const eocdAt = buf.length - EOCD_FIXED;
  assert.ok(eocdAt >= 0, 'archive is shorter than an end-of-central-directory record');
  assert.strictEqual(u32(eocdAt), EOCD_SIG, 'no end-of-central-directory record at the expected offset');

  const eocd = {
    offset: eocdAt,
    diskNumber: u16(eocdAt + 4),
    cdStartDisk: u16(eocdAt + 6),
    entriesThisDisk: u16(eocdAt + 8),
    entriesTotal: u16(eocdAt + 10),
    cdSize: u32(eocdAt + 12),
    cdOffset: u32(eocdAt + 16),
    commentLength: u16(eocdAt + 20)
  };

  const entries = [];
  let p = eocd.cdOffset;
  for (let i = 0; i < eocd.entriesTotal; i++) {
    assert.strictEqual(u32(p), CENTRAL_SIG,
      `central-directory entry ${i} does not start with a central header at offset ${p}`);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const central = {
      offsetInCd: p,
      crc: u32(p + 16),
      compressedSize: u32(p + 20),
      uncompressedSize: u32(p + 24),
      method: u16(p + 10),
      localHeaderOffset: u32(p + 42),
      name: dec.decode(buf.subarray(p + CENTRAL_FIXED, p + CENTRAL_FIXED + nameLen))
    };

    // Follow the recorded offset to the local header. If makeZip miscounted anything at
    // all, this lands in the middle of some other record and the signature check fires.
    const lo = central.localHeaderOffset;
    assert.strictEqual(u32(lo), LOCAL_SIG,
      `entry "${central.name}": central directory points at ${lo}, which is not a local header`);
    const localNameLen = u16(lo + 26);
    const localExtraLen = u16(lo + 28);
    const local = {
      offset: lo,
      crc: u32(lo + 14),
      compressedSize: u32(lo + 18),
      uncompressedSize: u32(lo + 22),
      method: u16(lo + 8),
      name: dec.decode(buf.subarray(lo + LOCAL_FIXED, lo + LOCAL_FIXED + localNameLen))
    };
    const dataStart = lo + LOCAL_FIXED + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + local.compressedSize);

    entries.push({ central, local, data, dataStart });
    p += CENTRAL_FIXED + nameLen + extraLen + commentLen;
  }

  return { eocd, entries, cdEnd: p };
}

/* ---------- fixtures ---------- */

const bytes = s => enc.encode(s);
const allByteValues = new Uint8Array(256).map((_, i) => i);
const longText = bytes('Глава первая. '.repeat(500) + 'The quick brown fox. '.repeat(500));

// Shaped like a real export: EPUB's mandatory first entry, a nested path, an empty file,
// binary data, something large, and Cyrillic payload.
const SAMPLE_FILES = [
  { name: 'mimetype', bytes: bytes('application/epub+zip') },
  { name: 'META-INF/container.xml', bytes: bytes('<?xml version="1.0"?><container/>') },
  { name: 'OEBPS/content.opf', bytes: bytes('<package><metadata><dc:title>Тайна</dc:title></metadata></package>') },
  { name: 'OEBPS/text/ch1.xhtml', bytes: longText },
  { name: 'empty.txt', bytes: new Uint8Array(0) },
  { name: 'binary.dat', bytes: allByteValues },
  { name: 'word/document.xml', bytes: bytes('<w:document><w:body><w:t>Привет, мир</w:t></w:body></w:document>') }
];

/* ---------- crc32 ---------- */

const hasZlibCrc = typeof zlib.crc32 === 'function';

test('crc32 agrees with zlib.crc32 across ASCII, binary and Cyrillic input', { skip: hasZlibCrc ? false : 'zlib.crc32 is unavailable in this Node build' }, () => {
  const inputs = [
    ['empty', new Uint8Array(0)],
    ['single zero byte', new Uint8Array([0])],
    ['short ascii', bytes('hello')],
    ['the classic check vector', bytes('123456789')],
    ['all 256 byte values', allByteValues],
    ['embedded NULs', new Uint8Array([1, 0, 2, 0, 0, 3])],
    ['cyrillic utf-8', bytes('Привет, мир — тест кириллицы')],
    ['mixed scripts', bytes('Mixed Латиница and Кириллица 123 «ёлочки»')],
    ['long text', longText],
    ['high bytes only', new Uint8Array(64).fill(0xFF)]
  ];
  for (const [label, data] of inputs) {
    assert.strictEqual(crc32(data), zlib.crc32(Buffer.from(data)) >>> 0, `crc32 mismatch for ${label}`);
  }
});

test('crc32 matches the published CRC-32 check value', () => {
  // Independent of zlib, so the algorithm is still pinned if the skip above ever fires:
  // 0xCBF43926 is the standard CRC-32 of "123456789".
  assert.strictEqual(crc32(bytes('123456789')), 0xCBF43926);
  assert.strictEqual(crc32(new Uint8Array(0)), 0);
});

/* ---------- makeZip structure ---------- */

test('every declared CRC, offset and size in a built archive is correct', () => {
  const zip = makeZip(SAMPLE_FILES);
  const { eocd, entries, cdEnd } = readZip(zip);

  assert.strictEqual(entries.length, SAMPLE_FILES.length, 'wrong number of entries recovered');
  assert.strictEqual(eocd.entriesTotal, SAMPLE_FILES.length, 'EOCD total entry count is wrong');
  assert.strictEqual(eocd.entriesThisDisk, SAMPLE_FILES.length, 'EOCD per-disk entry count is wrong');
  assert.strictEqual(eocd.diskNumber, 0);
  assert.strictEqual(eocd.cdStartDisk, 0);
  assert.strictEqual(eocd.commentLength, 0);

  // The central directory must span exactly the region the EOCD advertises, and must end
  // exactly where the EOCD begins — no gap, no overlap.
  assert.strictEqual(cdEnd - eocd.cdOffset, eocd.cdSize, 'EOCD central-directory size is wrong');
  assert.strictEqual(cdEnd, eocd.offset, 'central directory does not end where the EOCD starts');

  let expectedLocalOffset = 0;
  entries.forEach((e, i) => {
    const src = SAMPLE_FILES[i];
    const nameBytes = enc.encode(src.name);
    const expectedCrc = crc32(src.bytes);

    assert.strictEqual(e.central.name, src.name, `entry ${i}: central-directory filename`);
    assert.strictEqual(e.local.name, src.name, `entry ${i}: local-header filename`);

    assert.strictEqual(e.local.crc, expectedCrc, `${src.name}: local header CRC`);
    assert.strictEqual(e.central.crc, expectedCrc, `${src.name}: central directory CRC`);
    assert.strictEqual(crc32(e.data), expectedCrc, `${src.name}: CRC does not match the stored bytes`);

    for (const [where, rec] of [['local header', e.local], ['central directory', e.central]]) {
      assert.strictEqual(rec.method, 0, `${src.name}: ${where} must declare store (no compression)`);
      assert.strictEqual(rec.compressedSize, src.bytes.length, `${src.name}: ${where} compressed size`);
      assert.strictEqual(rec.uncompressedSize, src.bytes.length, `${src.name}: ${where} uncompressed size`);
    }

    // The recorded local-header offset must be the real one — computed here independently
    // by accumulating the sizes of everything written before it.
    assert.strictEqual(e.central.localHeaderOffset, expectedLocalOffset,
      `${src.name}: central directory records the wrong local-header offset`);
    expectedLocalOffset += LOCAL_FIXED + nameBytes.length + src.bytes.length;

    assert.deepStrictEqual(Buffer.from(e.data), Buffer.from(src.bytes),
      `${src.name}: content did not round-trip byte for byte`);
  });

  // Local section ends exactly where the central directory starts.
  assert.strictEqual(eocd.cdOffset, expectedLocalOffset,
    'EOCD central-directory offset does not match the end of the local entries');
});

test('an entry storing zero bytes round-trips as a real, empty entry', () => {
  const { entries } = readZip(makeZip(SAMPLE_FILES));
  const empty = entries.find(e => e.central.name === 'empty.txt');
  assert.ok(empty, 'the empty entry disappeared from the archive');
  assert.strictEqual(empty.data.length, 0);
  assert.strictEqual(empty.local.uncompressedSize, 0);
  assert.strictEqual(empty.central.crc, 0, 'CRC of no bytes must be 0');
});

test('Cyrillic file content survives the archive unchanged', () => {
  // Ties back to the Cyrillic-safety theme running through this codebase's export paths:
  // the DOCX/EPUB payloads are UTF-8 XML and must not be mangled on the way into the zip.
  const { entries } = readZip(makeZip(SAMPLE_FILES));
  const doc = entries.find(e => e.central.name === 'word/document.xml');
  assert.strictEqual(dec.decode(doc.data),
    '<w:document><w:body><w:t>Привет, мир</w:t></w:body></w:document>');
});

test('makeZip([]) produces a structurally valid empty archive instead of throwing', () => {
  const zip = makeZip([]);
  assert.strictEqual(zip.length, EOCD_FIXED, 'an empty archive should be exactly an EOCD record');

  const { eocd, entries, cdEnd } = readZip(zip);
  assert.deepStrictEqual(entries, []);
  assert.strictEqual(eocd.entriesTotal, 0);
  assert.strictEqual(eocd.entriesThisDisk, 0);
  assert.strictEqual(eocd.cdSize, 0);
  assert.strictEqual(eocd.cdOffset, 0);
  assert.strictEqual(cdEnd, eocd.cdOffset);
});

test('file data containing raw ZIP header magic does not confuse the archive', () => {
  // Store-mode data is copied verbatim, so a .xhtml or .docx payload can easily contain
  // the four bytes PK\x03\x04 by coincidence. Navigation by declared length has to be
  // immune to that; anything resynchronising on signatures would not be.
  const magic = [0x50, 0x4b, 0x03, 0x04];
  const eocdMagic = [0x50, 0x4b, 0x05, 0x06];
  const centralMagic = [0x50, 0x4b, 0x01, 0x02];
  const decoy = new Uint8Array([
    ...bytes('before '), ...magic, ...bytes(' middle '), ...centralMagic,
    ...bytes(' and '), ...eocdMagic, ...bytes(' after')
  ]);

  const files = [
    { name: 'a.txt', bytes: bytes('first') },
    { name: 'decoy.bin', bytes: decoy },
    { name: 'z.txt', bytes: bytes('last') }
  ];
  const zip = makeZip(files);

  // Confirm the fixture actually creates the hazard rather than silently not applying.
  let localMagicCount = 0;
  for (let i = 0; i + 4 <= zip.length; i++) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x03 && zip[i + 3] === 0x04) localMagicCount++;
  }
  assert.strictEqual(localMagicCount, files.length + 1,
    'expected one decoy local-header signature on top of the three real ones');

  const { entries, eocd } = readZip(zip);
  assert.strictEqual(eocd.entriesTotal, 3, 'decoy signatures changed the entry count');
  assert.deepStrictEqual(entries.map(e => e.central.name), ['a.txt', 'decoy.bin', 'z.txt']);
  assert.deepStrictEqual(Buffer.from(entries[1].data), Buffer.from(decoy),
    'decoy payload did not round-trip');
  assert.strictEqual(entries[1].central.crc, crc32(decoy));
  assert.strictEqual(dec.decode(entries[2].data), 'last',
    'the entry after the decoy was misread');
});

test('entries keep their given order, which EPUB depends on for mimetype', () => {
  // The EPUB spec requires the mimetype entry to be first and stored uncompressed.
  const { entries } = readZip(makeZip(SAMPLE_FILES));
  assert.deepStrictEqual(entries.map(e => e.central.name), SAMPLE_FILES.map(f => f.name));
  assert.strictEqual(entries[0].central.name, 'mimetype');
  assert.strictEqual(entries[0].local.method, 0);
  assert.strictEqual(entries[0].central.localHeaderOffset, 0);
});

test('filenames with nested paths survive exactly, without separator rewriting', () => {
  // EPUB and DOCX both rely on forward-slash paths resolving; a backslash or a stripped
  // directory component would break the manifest references inside the archive.
  const { entries } = readZip(makeZip(SAMPLE_FILES));
  const names = entries.map(e => e.central.name);
  assert.ok(names.includes('META-INF/container.xml'));
  assert.ok(names.includes('OEBPS/text/ch1.xhtml'));
  assert.ok(!names.some(n => n.includes('\\')), 'a path separator was rewritten');
});
