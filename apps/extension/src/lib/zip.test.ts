import { describe, it, expect } from "vitest";
import { buildZip, dataUrlToBytes } from "./zip";

function indexOfSig(buf: Uint8Array, sig: number[]): number {
  outer: for (let i = 0; i <= buf.length - sig.length; i++) {
    for (let j = 0; j < sig.length; j++) if (buf[i + j] !== sig[j]) continue outer;
    return i;
  }
  return -1;
}

describe("buildZip", () => {
  const enc = new TextEncoder();

  it("starts with the local-file-header signature (PK\\x03\\x04)", () => {
    const zip = buildZip([{ name: "a.txt", data: enc.encode("hello") }]);
    expect([zip[0], zip[1], zip[2], zip[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("contains an end-of-central-directory record with the right count", () => {
    const zip = buildZip([
      { name: "a.txt", data: enc.encode("hello") },
      { name: "b.png", data: enc.encode("world!") },
    ]);
    const eocd = indexOfSig(zip, [0x50, 0x4b, 0x05, 0x06]);
    expect(eocd).toBeGreaterThan(-1);
    // total-records field is 2 bytes at EOCD offset + 10
    const total = zip[eocd + 10]! + (zip[eocd + 11]! << 8);
    expect(total).toBe(2);
  });

  it("embeds each file name and its data", () => {
    const zip = buildZip([
      { name: "screenshot-001.png", data: enc.encode("PNGDATA") },
    ]);
    const text = new TextDecoder().decode(zip);
    expect(text).toContain("screenshot-001.png");
    expect(text).toContain("PNGDATA");
  });

  it("produces an empty but valid archive for no entries", () => {
    const zip = buildZip([]);
    expect(indexOfSig(zip, [0x50, 0x4b, 0x05, 0x06])).toBe(0); // just the EOCD
  });
});

describe("dataUrlToBytes", () => {
  it("decodes a base64 data URL to bytes", () => {
    const bytes = dataUrlToBytes("data:image/png;base64,aGVsbG8="); // "hello"
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });
});
