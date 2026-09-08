/**
 * A minimal ZIP writer.
 *
 * The point is not to be a general archiver — it exists so a download can
 * arrive as a folder rather than a loose file, which is the only way a browser
 * can deliver a directory structure. That needs a handful of well-documented
 * record layouts and nothing else, so writing them is cheaper than taking on a
 * dependency in a project that has none.
 *
 * Sizes and CRCs are known before anything is written (everything is held in
 * memory), so no data descriptors are needed and the format stays simple.
 */

import { deflateRawSync } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;

// Bit 11 tells the extractor the name is UTF-8 rather than the legacy code
// page, which is what keeps accents in a company name from being mangled.
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS packed date and time — the only timestamp the base format carries. */
function dosStamp(date) {
  // Nothing before 1980 is representable; clamp rather than write a negative.
  const y = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a ZIP archive in memory.
 *
 * @param files  [{ name, data }] — `name` may contain forward slashes, and a
 *               path like "Folder/file.pdf" is what makes the download expand
 *               into a folder. Backslashes are not path separators in ZIP.
 * @param at     timestamp recorded on every entry
 * @returns Buffer
 */
export function zipSync(files, { at = new Date() } = {}) {
  const { time, date } = dosStamp(at);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(String(file.name).replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);

    // Already-compressed payloads (a PDF, say) can come out larger deflated.
    // Storing them in that case is both smaller and faster to extract.
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);          // version needed to extract
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // no extra field

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(CENTRAL_SIG, 0);
    entry.writeUInt16LE(20, 4);          // version made by
    entry.writeUInt16LE(20, 6);          // version needed to extract
    entry.writeUInt16LE(FLAG_UTF8, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);          // extra
    entry.writeUInt16LE(0, 32);          // comment
    entry.writeUInt16LE(0, 34);          // disk number
    entry.writeUInt16LE(0, 36);          // internal attributes
    entry.writeUInt32LE(0, 38);          // external attributes
    entry.writeUInt32LE(offset, 42);     // where this entry's local header sits

    chunks.push(local, name, body);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4);               // this disk
  end.writeUInt16LE(0, 6);               // disk holding the central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);              // no archive comment

  return Buffer.concat([...chunks, centralBuf, end]);
}

/**
 * Make a string safe to use as a file or folder name on every platform.
 *
 * Windows is the strict one: it rejects <>:"/\|?* outright, and silently drops
 * trailing dots and spaces, which would otherwise make the name that comes out
 * of the archive differ from the one that went in. Hyphens and accents are
 * left alone — they are legal, and job titles are full of both.
 */
export function safeName(s, { max = 80 } = {}) {
  return String(s ?? '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '');
}
