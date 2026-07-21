import sharp from "sharp";

// Perceptual hashing for near-duplicate detection (FR-BE-043). A crawler revisits
// the same UI state by slightly different paths constantly — a hover tooltip, a
// blinking caret, an ad that reloaded — and contentHash (an exact byte match,
// FR-BE-040) never catches those because a single changed pixel is a different
// file. A perceptual hash is close for images that LOOK alike, so a threshold on
// the distance between two hashes flags the near-copies exact dedupe misses.
//
// The algorithm is dHash (difference hash): downscale to a tiny greyscale grid
// and record, per pixel, whether it is brighter than its right-hand neighbour.
// Chosen over aHash (compare-to-mean) because it keys on gradients rather than
// absolute brightness, so a global lightness shift — a dimmed overlay, a theme's
// hover state — does not move the hash. 64 bits, one hex nibble per 4.

/** Grid is (HASH_SIDE+1) wide so each row yields HASH_SIDE horizontal
 *  comparisons; HASH_SIDE tall. 8 ⇒ 8×8 = 64 bits. */
const HASH_SIDE = 8;

/**
 * The largest Hamming distance at which two screenshots count as near-duplicates
 * (FR-BE-043: "a configurable similarity threshold"). 0 ⇒ identical hashes only.
 *
 * Configurable via NEAR_DUPLICATE_MAX_HAMMING. Default 8 of 64 bits (~12%): tight
 * enough that genuinely different screens are not merged, loose enough to absorb
 * the caret/tooltip/scrollbar noise that makes two captures of one state differ.
 * Read at call time, not import, so it is not frozen before the env is set.
 */
export function nearDuplicateThreshold(): number {
  const raw = Number(process.env.NEAR_DUPLICATE_MAX_HAMMING);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 8;
}

/**
 * Compute the dHash of an image as a 16-char hex string. Pure bytes→hash: no S3,
 * no DB — the seam a unit test drives with a known PNG.
 *
 * `.raw()` after a greyscale resize yields exactly one byte per pixel, so the
 * buffer is a plain row-major intensity grid with no format parsing to do.
 */
export async function computePHash(input: Buffer): Promise<string> {
  const width = HASH_SIDE + 1;
  const pixels = await sharp(input)
    .greyscale()
    .resize({ width, height: HASH_SIDE, fit: "fill" })
    .raw()
    .toBuffer();

  const bits: number[] = [];
  for (let row = 0; row < HASH_SIDE; row++) {
    for (let col = 0; col < HASH_SIDE; col++) {
      const left = pixels[row * width + col]!;
      const right = pixels[row * width + col + 1]!;
      bits.push(left < right ? 1 : 0);
    }
  }

  // Pack 64 bits into 16 hex nibbles.
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i]! << 3) | (bits[i + 1]! << 2) | (bits[i + 2]! << 1) | bits[i + 3]!;
    hex += nibble.toString(16);
  }
  return hex;
}

const POPCOUNT = Array.from({ length: 16 }, (_, n) =>
  ((n >> 0) & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1),
);

/**
 * Hamming distance between two equal-length hex hashes: how many bits differ.
 * Pure. Returns Infinity for malformed or mismatched-length input, so a bad
 * stored hash can never masquerade as "distance 0, identical".
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16);
    const y = parseInt(b[i]!, 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return Infinity;
    distance += POPCOUNT[(x ^ y) & 0xf]!;
  }
  return distance;
}

/** Are two hashes within `maxHamming` bits of each other? Pure. */
export function isNearDuplicate(a: string, b: string, maxHamming: number): boolean {
  return hammingDistance(a, b) <= maxHamming;
}

/** The closest prior hash to `target`, or null if none is within threshold. Pure
 *  — the caller supplies the candidate hashes so this needs no DB. */
export function closestWithinThreshold(
  target: string,
  candidates: { id: string; pHash: string }[],
  maxHamming: number,
): { id: string; distance: number } | null {
  let best: { id: string; distance: number } | null = null;
  for (const c of candidates) {
    const distance = hammingDistance(target, c.pHash);
    if (distance <= maxHamming && (!best || distance < best.distance)) {
      best = { id: c.id, distance };
    }
  }
  return best;
}
