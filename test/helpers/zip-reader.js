/* A ZIP reader that trusts only what an archive *declares* about itself.
 *
 * Shared by test/zip-writer.test.js (which pins makeZip() itself) and
 * test/epub-xml.test.js (which walks a whole compiled EPUB back out). This file holds no
 * tests of its own — it exists so both suites read archives the same strict way instead of
 * keeping two drifting copies.
 *
 * The reader deliberately navigates by the offsets and lengths makeZip() declares —
 * end-of-central-directory -> central directory -> each entry's recorded local-header
 * offset -> that header's name/extra lengths -> the data — rather than by scanning the
 * buffer for PK signatures. Scanning would happily resynchronise past a wrong offset and
 * report a healthy archive, which is exactly the class of bug these tests exist to catch.
 */
import assert from 'node:assert';

export const LOCAL_SIG = 0x04034b50;
export const CENTRAL_SIG = 0x02014b50;
export const EOCD_SIG = 0x06054b50;
export const LOCAL_FIXED = 30;
export const CENTRAL_FIXED = 46;
export const EOCD_FIXED = 22;

const dec = new TextDecoder();

export function readZip(buf) {
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
