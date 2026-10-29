/* The ZIP writer behind BOTH the EPUB and the DOCX export, so a defect here corrupts two
   formats at once. test/zip-writer.test.js checks the archives it produces by walking the
   offsets/lengths they record. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/* Minimal ZIP writer: every entry STORED (method 0, no compression), no data descriptors,
   extra fields or archive comment, and a zero DOS date/time, so equal input gives identical
   bytes. Layout: per file a 30-byte local header + name + data, then one 46-byte central
   directory record + name per file (pointing back at its local header's offset), then the
   22-byte end-of-central-directory record. All integers little-endian; version 2.0 is what
   plain stored entries need. Entries keep the given order, which EPUB relies on (mimetype
   first). Names are encoded as UTF-8 but the UTF-8 flag (bit 11) is not set, so keep them
   ASCII. No ZIP64. */
export function makeZip(files) {
  const u16 = n => [n & 255, (n >> 8) & 255];
  const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const parts = [], central = [];
  let offset = 0;
  files.forEach(f => {
    const nameB = new TextEncoder().encode(f.name);
    const data = f.bytes;
    const crc = crc32(data);
    const local = [0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0)];
    parts.push(new Uint8Array(local), nameB, data);
    const cen = [0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)];
    central.push(new Uint8Array(cen), nameB);
    offset += local.length + nameB.length + data.length;
  });
  let cdSize = 0; central.forEach(a => (cdSize += a.length));
  const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const total = all.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0; all.forEach(a => { out.set(a, p); p += a.length; });
  return out;
}
