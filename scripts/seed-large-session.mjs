// Seed a realistic FULL-SIZE crawl session: maxScreens (200) unique screens with
// a real tree shape, so the gallery (FR-AP-040) and sitemap graph (FR-AP-050) can
// be exercised at the scale they actually ship at rather than at n=1.
//
// Every screen needs a distinct stateFingerprint AND contentHash or the backend
// dedupes it away at presign (FR-BE-040), so each PNG is genuinely different.
//
// Usage:  node scripts/seed-large-session.mjs [count]
// Needs:  Mongo + a reachable AWS S3 bucket + the API running (npm run dev:api)
// Env:    API_URL, ADMIN_EMAIL, ADMIN_PASSWORD

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const BASE = process.env.API_URL ?? "http://localhost:4000";
const API = `${BASE}/api/v1`;
const EMAIL = process.env.ADMIN_EMAIL ?? "admin@snapcrawl.dev";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "password";
const COUNT = Number(process.argv[2] ?? 200);

const W = 1366;
const H = 900;

async function call(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    // presign is rate-limited to 120/min (FR-BE-040) — honour Retry-After rather
    // than hammering it.
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 5) * 1000;
      process.stdout.write(`  [429 — waiting ${wait / 1000}s] `);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  throw new Error(`${method} ${path} — still rate-limited after retries`);
}

// ── PNG generation (same encoder as e2e-pipeline, seeded per screen) ─────────
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A distinct, screenshot-ish PNG per seed: banded UI-like blocks + noise so the
 *  deflated size lands in the same ballpark as a real capture. */
function makePng(seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(H * (1 + W * 3));
  let o = 0;
  let rnd = seed * 2654435761 % 2147483647;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff);
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    const band = Math.floor(y / 60) + seed;
    for (let x = 0; x < W; x++) {
      const block = Math.floor(x / 80) ^ band;
      const n = next() % 24;
      raw[o++] = (block * 37 + n) % 256;
      raw[o++] = (block * 91 + seed * 7 + n) % 256;
      raw[o++] = (200 - (block * 13) % 180 + n) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── A realistic crawl tree: root → sections → items, depth 0..4 ──────────────
const SECTIONS = ["dashboard", "projects", "sessions", "reports", "settings", "billing", "users"];
function shapeFor(i) {
  if (i === 0) return { url: "https://example.test/", title: "Home", depth: 0, parent: null };
  const section = SECTIONS[i % SECTIONS.length];
  const depth = i < 8 ? 1 : i < 40 ? 2 : i < 120 ? 3 : 4;
  const parent = i < 8 ? 0 : Math.max(0, Math.floor(i / 3) - 1);
  const url =
    depth === 1
      ? `https://example.test/${section}`
      : `https://example.test/${section}/item-${i}?tab=${i % 3}`;
  return {
    url,
    title: `${section[0].toUpperCase()}${section.slice(1)} — item ${i}`,
    depth,
    parent,
  };
}

const t0 = Date.now();
try {
  const { token: jwt } = await call("/auth/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });

  const project = await call("/projects", {
    method: "POST",
    token: jwt,
    body: {
      name: `scale-${COUNT} ${new Date(Date.now()).toISOString().slice(0, 19)}`,
      baseUrl: "https://example.test",
      description: `Scale fixture: ${COUNT} screens for FR-AP-040/050 testing`,
      config: { allowedDomains: ["example.test"], maxScreens: Math.max(COUNT, 200), maxDepth: 5 },
    },
  });

  // The authorised-use gate (NFR-020/C-07): POST /ext/sessions 403s
  // AUTHORISED_USE_REQUIRED until someone attests for the project. Attesting here
  // is honest rather than a bypass — this seeder invents its own project against
  // the reserved `example.test` domain and never touches a real site. A human
  // does this in the panel; this is the same call the panel makes.
  await call(`/projects/${project.id}/authorise`, {
    method: "POST",
    token: jwt,
    body: { confirm: true },
  });

  const { rawToken } = await call("/tokens", {
    method: "POST",
    token: jwt,
    body: { name: `scale-seed-${Date.now()}` },
  });

  const session = await call("/ext/sessions", {
    method: "POST",
    token: rawToken,
    body: { projectId: project.id },
  });
  await call(`/ext/sessions/${session.id}`, {
    method: "PATCH",
    token: rawToken,
    body: { status: "running" },
  });

  console.log(`project ${project.id}`);
  console.log(`session ${session.id}`);
  console.log(`seeding ${COUNT} screens…`);

  const fpOf = [];
  let bytes = 0;
  const edges = [];

  // The panel reads session.stats — "View gallery (N)", the Screens tile, and the
  // count in the sessions list all come from stats.screensCaptured, NOT from
  // counting the screens collection. Uploading captures does not update it; only
  // PATCH /ext/sessions/:id does, which is what the real extension sends as it
  // crawls. Without this the demo reads "0 screens captured" next to a gallery of
  // 200 — the session looks broken when it is actually fine.
  const stats = {
    screensCaptured: 0,
    edgesRecorded: 0,
    duplicatesSkipped: 0,
    errorsCount: 0,
    maxDepthReached: 0,
    currentUrl: "",
  };
  /** PATCH the running tally, plus whatever else this call needs to say. */
  const pushStats = (extra = {}) =>
    call(`/ext/sessions/${session.id}`, {
      method: "PATCH",
      token: rawToken,
      body: { stats, ...extra },
    });

  for (let i = 0; i < COUNT; i++) {
    const shape = shapeFor(i);
    const png = makePng(i + 1);
    bytes += png.length;
    const contentHash = createHash("sha256").update(png).digest("hex");
    const stateFingerprint = createHash("sha256").update(`scale:${session.id}:${i}`).digest("hex");
    fpOf[i] = stateFingerprint;

    const meta = {
      url: shape.url,
      title: shape.title,
      depth: shape.depth,
      parentFingerprint: shape.parent === null ? null : fpOf[shape.parent] ?? null,
      triggerElement:
        shape.parent === null
          ? null
          : {
              selector: `a[href="${shape.url.replace("https://example.test", "")}"]`,
              text: shape.title,
              tag: "a",
              role: "link",
            },
      viewport: { width: W, height: H },
      fullPage: false,
      clientTimestamp: new Date().toISOString(),
    };

    const pre = await call("/ext/captures/presign", {
      method: "POST",
      token: rawToken,
      body: { sessionId: session.id, stateFingerprint, contentHash, contentType: "image/png", meta },
    });
    if (pre.duplicate) {
      stats.duplicatesSkipped += 1;
      process.stdout.write("d");
      continue;
    }
    let put;
    try {
      put = await fetch(pre.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: png,
      });
    } catch (e) {
      throw new Error(
        `PUT #${i} to ${new URL(pre.uploadUrl).origin} failed: ${e.cause?.code ?? e.message}`,
      );
    }
    if (!put.ok) throw new Error(`PUT #${i} → ${put.status}: ${(await put.text()).slice(0, 200)}`);

    await call("/ext/captures/complete", {
      method: "POST",
      token: rawToken,
      body: { sessionId: session.id, stateFingerprint, contentHash, key: pre.key, width: W, height: H, meta },
    });

    if (shape.parent !== null) {
      edges.push({
        fromFingerprint: fpOf[shape.parent],
        toFingerprint: stateFingerprint,
        element: meta.triggerElement,
        // A same-page state change is a "substate"; a URL change is "navigation"
        // (FR-BE-045). Mirror that so the graph has a realistic mix of kinds.
        kind: shape.url === shapeFor(shape.parent).url ? "substate" : "navigation",
      });
    }
    stats.screensCaptured += 1;
    stats.maxDepthReached = Math.max(stats.maxDepthReached, shape.depth);
    stats.currentUrl = shape.url;
    // Flush periodically, as a real crawl does, so a session watched mid-seed
    // shows movement instead of jumping 0 → 200 at the end.
    if (stats.screensCaptured % 25 === 0) await pushStats({ heartbeat: true });

    process.stdout.write(i % 50 === 0 ? `\n  ${i} ` : ".");
  }

  // Edges in batches of <=100 (FR-BE-045).
  for (let i = 0; i < edges.length; i += 100) {
    const { recorded } = await call("/ext/edges", {
      method: "POST",
      token: rawToken,
      body: { sessionId: session.id, edges: edges.slice(i, i + 100) },
    });
    stats.edgesRecorded += recorded ?? 0;
  }

  // Final flush carries the true totals — this is what the sessions list, the
  // Screens tile and "View gallery (N)" all read.
  await pushStats({ status: "completed", endReason: "limit-reached" });

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n\n${"═".repeat(62)}`);
  console.log(`  SEEDED ${COUNT} screens · ${(bytes / 1e6).toFixed(1)} MB of PNG · ${edges.length} edges · ${secs}s`);
  console.log(`  project  ${project.id}`);
  console.log(`  session  ${session.id}`);
  console.log(`  gallery  /projects/${project.id}/sessions/${session.id}/gallery`);
  console.log(`  graph    /projects/${project.id}/sessions/${session.id}/graph`);
  console.log(`${"═".repeat(62)}`);
} catch (err) {
  console.error(`\nSEED FAILED: ${err.message}`);
  if (err.cause) console.error(`  cause: ${err.cause.code ?? ""} ${err.cause.message ?? err.cause}`);
  process.exitCode = 1;
}
