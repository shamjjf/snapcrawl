# SnapCrawl

Automated UI crawler. A Chrome extension (MV3) crawls a target web app by
clicking every safe interactive element, captures a screenshot of every
unique UI state, and streams results to an Express API. A Next.js admin
panel shows the gallery and a visual sitemap graph. Solo-developer project.

## Source of truth

`docs/SRS.md` is the spec. Every requirement has an ID:

- FR-BE-* backend · FR-AP-* admin panel · FR-EX-* extension
- NFR-* non-functional · EC-* edge cases · C-* platform constraints

Before implementing anything, read the relevant requirement(s) by ID.
When a task references an ID, restate the requirement in your plan.
Tests reference the IDs they cover in their describe() blocks.

## Stack

- npm workspaces monorepo (Node 24, npm 10). ONE lockfile, at the root.
- `apps/api` — Express 5 + TypeScript + Mongoose (MongoDB 8) + Zod
- `apps/web` — Next.js 16 App Router + React 19 + TanStack Query
- `apps/extension` — CRXJS + Vite + React 19, Chrome Manifest V3
- `packages/shared` — `@snapcrawl/shared`: Zod schemas, inferred types,
  constants (config defaults, destructive blocklist). Single source of
  truth for all cross-app types. Never duplicate a type outside it.
- Tests: Vitest in every workspace.

## Commands

Run everything from the repo ROOT. Never `npm install` inside an app folder.

```
npm install                        # install all workspaces
npm run dev:api | dev:web | dev:ext
npm run dev                        # all three via concurrently
npm run test                       # all workspaces
npm run test -w apps/api           # one workspace
npm install <pkg> -w apps/api      # add a dep to one workspace
docker-compose up -d               # MongoDB :27017
```

Object storage is real AWS S3 in every environment — there is no local
stand-in. `apps/api` refuses to start until `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set; see
`apps/api/.env.example`.

## Hard platform constraints (SRS §2.5 — these shape everything)

- C-01: `captureVisibleTab` works only on the active tab of a focused
  window, ~2 captures/sec. Crawl runs in a dedicated window; space
  captures ≥ 600 ms apart.
- C-02: `captureVisibleTab` is viewport-only. Full page = scroll-and-stitch.
- C-03: MV3 service workers are killed after ~30 s idle. ALL crawl state
  (queue, visited set, click paths, config) checkpoints to chrome.storage
  after every state transition. Every operation must be resumable. Never
  keep crawl state only in worker memory.
- C-04: Content scripts cannot access cross-origin iframes. Skip and log.
- C-05: Extension code is public. NO secrets in the extension bundle,
  ever. It holds only a revocable bearer token.

## Safety rules (never weaken without explicit instruction)

- Never click elements matching destructiveTextBlocklist (FR-EX-070).
- Enforce allowedDomains on every navigation; neutralise window.open and
  target=_blank (FR-EX-071/072).
- Apply maskSelectors overlays before every capture (FR-EX-053).
- Any change under `apps/extension/src/content/safety.ts` requires
  updating `safety.test.ts` in the same commit.

## Conventions

- Validate every API input with Zod schemas from `@snapcrawl/shared`.
- Uniform API error envelope `{ code, message, details[] }` (FR-BE-070).
- API code lives in `apps/api/src/modules/<domain>/` (routes, controller,
  service). Extension auth (`/ext/*`) is bearer-token only, capture scope.
- Extension messaging goes through typed helpers in
  `apps/extension/src/lib/messaging.ts` — no raw untyped
  `chrome.runtime.sendMessage` payloads.
- No floating promises. ESLint + Prettier must pass before commit.
- Commit messages reference requirement IDs, e.g.
  `feat(api): presign + dedupe endpoint (FR-BE-040)`.

## Workflow

- Plan first for anything non-trivial; wait for approval on plans that
  touch auth, S3/presign, or the crawl engine core.
- One requirement cluster per session; keep scope small.
- MoSCoW discipline: Must requirements only, unless explicitly asked for
  a Should/Could.
- Ask before adding any new runtime dependency.
- Current phase: **Phase 1 — backend build-out in apps/api (shared
  schemas → data models → projects/tokens/sessions/captures), in
  parallel with the ongoing extension spike in apps/extension.**
  Backend progress tracked in docs/backend-progress.md + docs/backend-todo.md.
  (Update this line as the project moves.)

## Gotchas

- `next.config.js` needs `transpilePackages: ['@snapcrawl/shared']`.
- Load the extension unpacked from `apps/extension/dist` via
  chrome://extensions with Developer Mode on; CRXJS hot-reloads it.
- Screenshots go to real AWS S3; region/bucket/creds come from `.env`
  (keep `.env.example` current whenever env vars change). `S3_ENDPOINT` is
  blank for AWS — it exists only for an S3-compatible server.
- A hosted extension build needs `SNAPCRAWL_API_ORIGIN` and
  `SNAPCRAWL_S3_ORIGIN` set before `npm run build -w apps/extension`; they
  are baked into the manifest's `host_permissions` and cannot change at
  runtime.
- The S3 bucket needs a CORS rule allowing `PUT` from the extension and
  `GET` from the panel origin, or uploads and downloads fail in the browser
  with no server-side error.

## Definition of done

Types imported from `packages/shared` · tests written and passing ·
lint clean · requirement ID(s) referenced in tests and commit message.
