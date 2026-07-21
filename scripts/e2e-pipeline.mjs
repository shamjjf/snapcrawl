// End-to-end proof of the screenshot pipeline (FR-BE-030/031/040/041/044/060, C-05).
//
// This exists because the pipeline it covers — presign → PUT → complete → signed
// GET — shipped as "done" on all three workstreams but had never once executed:
// The S3 bucket was unreachable, so /readyz returned 503 on the live API while every
// component reported green against mocks and contracts. Unit tests could not have
// caught that; only real bytes crossing the real seam can.
//
// Drives the exact contract apps/extension uses, with a real PNG, and asserts the
// bytes come back byte-identical. No mocks.
//
// Usage:  npm run e2e:pipeline
// Needs:  Mongo + a reachable AWS S3 bucket + the API running (npm run dev:api)
// Env:    API_URL, ADMIN_EMAIL, ADMIN_PASSWORD

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const BASE = process.env.API_URL ?? "http://localhost:4000";
const API = `${BASE}/api/v1`;
const EMAIL = process.env.ADMIN_EMAIL ?? "admin@snapcrawl.dev";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "password";

let step = 0;
const head = (t) => console.log(`\n[${++step}] ${t}`);
const ok = (m) => console.log(`  ✓ ${m}`);

async function raw(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { res, text, parsed };
}

async function call(path, opts = {}) {
  const { res, text, parsed } = await raw(path, opts);
  if (!res.ok) {
    throw new Error(`${opts.method ?? "GET"} ${path} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return parsed;
}

/** Assert a call is REFUSED with a specific code — for the gates whose whole
 *  job is to say no. A gate nobody proves refuses is a gate you do not have. */
async function expectRefused(path, opts, status, code) {
  const { res, parsed } = await raw(path, opts);
  if (res.status !== status || parsed?.code !== code) {
    throw new Error(
      `${opts.method ?? "GET"} ${path} → expected HTTP ${status} ${code}, ` +
        `got ${res.status} ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  return parsed;
}

// ── Minimal valid PNG. Real bytes matter: /complete runs HeadObject against the
//    stored object, and the extension's uploader parses dimensions from the IHDR.
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
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[o++] = (x * 5) % 256;
      raw[o++] = (y * 7) % 256;
      raw[o++] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const W = 1366;
const H = 900;
const png = makePng(W, H);
const contentHash = createHash("sha256").update(png).digest("hex");
const stateFingerprint = createHash("sha256").update(`e2e:${Date.now()}`).digest("hex");
const meta = {
  url: "https://example.test/dashboard",
  title: "e2e pipeline",
  depth: 0,
  parentFingerprint: null,
  triggerElement: null,
  viewport: { width: W, height: H },
  fullPage: false,
  clientTimestamp: new Date().toISOString(),
};

try {
  head("Readiness (Mongo + S3 both reachable)");
  const res = await fetch(`${BASE}/readyz`);
  if (!res.ok) {
    // The API ensures the bucket only at boot and never retries, so a 503 here
    // usually means storage came up after the API did.
    throw new Error(
      `/readyz → HTTP ${res.status}. Is the S3 bucket reachable and are the ` +
      `AWS credentials in apps/api/.env correct? ` +
        `If it started after the API, restart the API so ensureBucket reruns.`,
    );
  }
  ok(`readyz: ${JSON.stringify(await res.json())}`);

  head("Login (FR-BE-002)");
  const { token: jwt, user } = await call("/auth/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  ok(`${user.email} (${user.role})`);

  head("Create project (FR-BE-020/021/023)");
  const project = await call("/projects", {
    method: "POST",
    token: jwt,
    body: {
      name: `e2e-pipeline ${Date.now()}`,
      baseUrl: "https://example.test",
      description: "Automated end-to-end pipeline proof",
      config: { allowedDomains: ["example.test"] },
    },
  });
  ok(`project ${project.id}`);

  head("Mint extension token (FR-BE-060, capture scope only)");
  const { rawToken, token: tokenView } = await call("/tokens", {
    method: "POST",
    token: jwt,
    body: { name: "e2e-pipeline" },
  });
  if (JSON.stringify(tokenView.scopes) !== JSON.stringify(["capture"]))
    throw new Error(`unexpected scopes: ${JSON.stringify(tokenView.scopes)}`);
  ok(`raw token issued once, scopes=${JSON.stringify(tokenView.scopes)}`);

  head("Authorised-use gate BLOCKS an unconfirmed project (NFR-020, C-07)");
  if (project.authorisedUse !== null) {
    throw new Error(`new project should not be pre-authorised: ${JSON.stringify(project.authorisedUse)}`);
  }
  await expectRefused(
    "/ext/sessions",
    { method: "POST", token: rawToken, body: { projectId: project.id } },
    403,
    "AUTHORISED_USE_REQUIRED",
  );
  ok("crawl refused until someone confirms they may test the target");

  head("Confirm authorised use (NFR-020)");
  const authorised = await call(`/projects/${project.id}/authorise`, {
    method: "POST",
    token: jwt,
    body: { confirm: true },
  });
  if (!authorised.authorisedUse?.at) throw new Error("attestation was not recorded on the project");
  ok(`attested at ${authorised.authorisedUse.at} by ${authorised.authorisedUse.by}`);

  head("Create session via /ext/sessions (FR-BE-030)");
  const session = await call("/ext/sessions", {
    method: "POST",
    token: rawToken,
    body: { projectId: project.id },
  });
  ok(`session ${session.id} (${session.status})`);

  head("pending → running (FR-BE-031)");
  await call(`/ext/sessions/${session.id}`, {
    method: "PATCH",
    token: rawToken,
    body: { status: "running" },
  });
  ok("transition accepted");

  head("Presign (FR-BE-040)");
  const pre = await call("/ext/captures/presign", {
    method: "POST",
    token: rawToken,
    body: { sessionId: session.id, stateFingerprint, contentHash, contentType: "image/png", meta },
  });
  if (pre.duplicate) throw new Error("first presign unexpectedly reported duplicate");
  if (pre.expiresInSec > 600) throw new Error(`presign TTL ${pre.expiresInSec}s exceeds NFR-013 max of 600s`);
  ok(`key=${pre.key} ttl=${pre.expiresInSec}s`);

  head(`PUT ${png.length} real PNG bytes to object storage`);
  const put = await fetch(pre.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: png,
  });
  if (!put.ok) throw new Error(`PUT → HTTP ${put.status}: ${(await put.text()).slice(0, 300)}`);
  ok(`HTTP ${put.status}`);

  head("Complete — HeadObject verify + persist (FR-BE-041)");
  const screen = await call("/ext/captures/complete", {
    method: "POST",
    token: rawToken,
    body: { sessionId: session.id, stateFingerprint, contentHash, key: pre.key, width: W, height: H, meta },
  });
  ok(`screen ${screen.id}`);

  head("Dedupe — same contentHash must skip upload (FR-BE-040)");
  const dup = await call("/ext/captures/presign", {
    method: "POST",
    token: rawToken,
    body: {
      sessionId: session.id,
      stateFingerprint: `${stateFingerprint}-b`,
      contentHash,
      contentType: "image/png",
      meta,
    },
  });
  if (!dup.duplicate) throw new Error(`dedupe failed — expected duplicate:true, got ${JSON.stringify(dup)}`);
  ok("duplicate:true");

  head("Signed GET round-trip (FR-BE-044)");
  const got = await call(`/screens/${screen.id}`, { token: jwt });
  const url = got.imageUrl ?? got.url ?? got.thumbUrl;
  if (!url) throw new Error(`no signed URL on screen: ${JSON.stringify(got).slice(0, 300)}`);
  const back = Buffer.from(await (await fetch(url)).arrayBuffer());
  const backHash = createHash("sha256").update(back).digest("hex");
  if (backHash !== contentHash)
    throw new Error(`BYTE MISMATCH — sent ${contentHash.slice(0, 16)}…, got ${backHash.slice(0, 16)}…`);
  ok(`${back.length} bytes, SHA-256 identical`);

  head("Gallery read (FR-AP-040 support)");
  const gallery = await call(`/sessions/${session.id}/screens`, { token: jwt });
  if (!gallery.items?.length) throw new Error("gallery returned no items");
  ok(`${gallery.items.length} item(s), thumbUrl present=${Boolean(gallery.items[0].thumbUrl)}`);

  head("Finalize session");
  await call(`/ext/sessions/${session.id}`, {
    method: "PATCH",
    token: rawToken,
    body: { status: "completed", endReason: "limit-reached" },
  });
  ok("running → completed");

  console.log(`\n${"═".repeat(64)}\n  PIPELINE OK — real bytes crossed every seam.\n${"═".repeat(64)}`);
} catch (err) {
  console.error(`\n${"═".repeat(64)}\n  PIPELINE FAILED at step ${step}\n${"═".repeat(64)}`);
  console.error(`  ${err.message}\n`);
  process.exitCode = 1;
}
