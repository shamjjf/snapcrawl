import express from "express";
import cors from "cors";
import helmet from "helmet";
import { dbReady } from "./db";
import { requireAuth, type AuthedRequest } from "./auth";
import { getDashboard } from "./dashboard";
import { ApiError, sendError } from "./http/envelope";
import { currentRequestId, errorFields, log } from "./lib/logger";
import { snapshot } from "./lib/metrics";
import { s3Ready } from "./lib/s3";
import { requestId } from "./middleware/requestId";
import authRouter from "./modules/auth/routes";
import projectsRouter from "./modules/projects/routes";
import tokensRouter from "./modules/tokens/routes";
import usersRouter from "./modules/users/routes";
import sessionsRouter from "./modules/sessions/routes";
import screensRouter from "./modules/captures/routes";
import extRouter from "./modules/ext/routes";

// The Express app, built in isolation from the process lifecycle. index.ts owns
// the side effects (env, Mongo, seeding, storage, timers, listen); this module
// owns only wiring, so tests can drive the real routes via supertest without
// booting a server or touching those side effects.

/** Is this an allowed extension origin? Pinned via EXT_ORIGIN in prod; in dev
 *  (EXT_ORIGIN unset) reflect any chrome-extension:// origin (FR-BE-074). */
function isExtensionOrigin(origin: string, extOrigin?: string): boolean {
  return extOrigin ? origin === extOrigin : origin.startsWith("chrome-extension://");
}

export function createApp(): express.Express {
  // Read origins per call (not at module scope) so a test can set the env and
  // build a fresh app. index.ts calls this once, after dotenv, so runtime
  // behaviour is unchanged.
  const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const EXT_ORIGIN = process.env.EXT_ORIGIN;

  // CORS (FR-BE-074): /ext/* accepts the extension origin; every other (browser)
  // route accepts only WEB_ORIGIN.
  const corsDelegate: cors.CorsOptionsDelegate<express.Request> = (req, cb) => {
    if (req.path.startsWith("/api/v1/ext")) {
      const origin = req.headers.origin;
      cb(null, { origin: origin && isExtensionOrigin(origin, EXT_ORIGIN) ? origin : false });
    } else {
      // credentials:true so the httpOnly refresh cookie flows to the panel (FR-BE-002).
      cb(null, { origin: WEB_ORIGIN, credentials: true });
    }
  };

  const app = express();
  // FIRST: everything downstream — including helmet/cors rejections — should be
  // correlatable, and the id must be on the response however it ends (FR-BE-071).
  app.use(requestId);
  app.use(helmet()); // security headers (NFR-010)
  app.use(cors(corsDelegate));
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/readyz", async (_req, res) => {
    // Readiness = Mongo AND S3 reachable (FR-BE-072). Observation only — never
    // mutates storage, since this probe is public and unauthenticated.
    const db = dbReady();
    const s3 = await s3Ready();
    const body = {
      ready: db && s3,
      db: db ? "connected" : "disconnected",
      s3: s3 ? "connected" : "disconnected",
    };
    res.status(db && s3 ? 200 : 503).json(body);
  });

  // Structured observability counters (NFR-022 groundwork): sessions
  // started/completed/failed/cancelled, captures completed/failed, and the
  // derived upload-failure rate. Public and read-only alongside healthz/readyz —
  // it exposes only process-local aggregate counts, no per-user or crawl data, so
  // a scraper can poll it without a bearer token. Sums across instances (NFR-004).
  app.get("/metrics", (_req, res) => {
    res.json(snapshot(Math.round(process.uptime())));
  });

  app.use("/api/v1/auth", authRouter);

  app.get("/api/v1/dashboard", requireAuth, async (req: AuthedRequest, res) => {
    res.json(await getDashboard(req.user!));
  });

  // Projects + Tokens + Users + extension pairing (FR-BE-010, 020..023, 060..063).
  app.use("/api/v1/projects", projectsRouter);
  app.use("/api/v1/tokens", tokensRouter);
  app.use("/api/v1/users", usersRouter);
  app.use("/api/v1/sessions", sessionsRouter);
  app.use("/api/v1/screens", screensRouter);
  app.use("/api/v1/ext", extRouter);

  // Uniform error envelope for anything that throws (FR-BE-070).
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof ApiError) {
        sendError(res, err.status, err.code, err.message, err.details);
        return;
      }
      // Mongo duplicate-key → 409 with the uniform envelope.
      if (err && typeof err === "object" && (err as { code?: number }).code === 11000) {
        sendError(res, 409, "CONFLICT", "That resource already exists.");
        return;
      }
      // body-parser rejects malformed / oversize bodies with a 4xx already
      // attached. Without this they fall through to the 500 branch below:
      // a client sending broken JSON is not a server fault (FR-BE-070 wants
      // correct status codes), and logging it as "unhandled error" buries real
      // 500s under routine client mistakes.
      const parseErr = err as { type?: string; status?: number; statusCode?: number };
      const parseStatus = parseErr?.status ?? parseErr?.statusCode;
      if (
        typeof parseErr?.type === "string" &&
        parseErr.type.startsWith("entity.") &&
        typeof parseStatus === "number" &&
        parseStatus >= 400 &&
        parseStatus < 500
      ) {
        const code = parseErr.type === "entity.too.large" ? "PAYLOAD_TOO_LARGE" : "INVALID_BODY";
        const message =
          parseErr.type === "entity.too.large"
            ? "Request body is too large."
            : "Request body is not valid JSON.";
        log.warn("rejected malformed request body", { type: parseErr.type, status: parseStatus });
        sendError(res, parseStatus, code, message);
        return;
      }
      log.error("unhandled error", errorFields(err));
      // Surface the correlation id on the 500 itself: it is the only thing that
      // lets a user's "it broke" turn into the exact log line (FR-BE-071). It
      // identifies a request, not a user, so it is safe to hand out — unlike the
      // underlying error, which stays server-side.
      sendError(res, 500, "INTERNAL", "Something went wrong.", [
        { path: "requestId", message: currentRequestId() ?? "unknown" },
      ]);
    },
  );

  return app;
}
