// Minimal ZIP writer (STORE / no compression) — zero dependencies. Screenshots
// (PNG) are already compressed, so storing them uncompressed is fine and avoids
// pulling in a zip library. Used to bundle captured screenshots into one file.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}
function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = concat([
      u32(0x04034b50), // local file header signature
      u16(20), u16(0), u16(0), // version needed, flags, compression (0 = store)
      u16(0), u16(0), // mod time, mod date
      u32(crc), u32(size), u32(size), // crc, compressed size, uncompressed size
      u16(name.length), u16(0), // name length, extra length
      name, entry.data,
    ]);
    locals.push(local);

    centrals.push(
      concat([
        u32(0x02014b50), // central directory header signature
        u16(20), u16(20), u16(0), u16(0), // made-by, needed, flags, compression
        u16(0), u16(0), // mod time, mod date
        u32(crc), u32(size), u32(size),
        u16(name.length), u16(0), u16(0), // name, extra, comment lengths
        u16(0), u16(0), u32(0), // disk #, internal attrs, external attrs
        u32(offset), // relative offset of local header
        name,
      ]),
    );
    offset += local.length;
  }

  const central = concat(centrals);
  const eocd = concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), u16(0), // this disk #, disk with CD
    u16(entries.length), u16(entries.length), // records on disk, total records
    u32(central.length), u32(offset), // CD size, CD offset
    u16(0), // comment length
  ]);

  return concat([...locals, central, eocd]);
}

/** Decode a `data:...;base64,XXXX` URL into raw bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
