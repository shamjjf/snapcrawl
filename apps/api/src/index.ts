import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { connectDb, dbReady } from "./db";
import { UserModel } from "./models/user";
import { requireAuth, hashPassword, type AuthedRequest } from "./auth";
import { getDashboard } from "./dashboard";
import { ApiError, sendError } from "./http/envelope";
import { ensureBucket, s3Ready } from "./lib/s3";
import authRouter from "./modules/auth/routes";
import projectsRouter from "./modules/projects/routes";
import tokensRouter from "./modules/tokens/routes";
import usersRouter from "./modules/users/routes";
import sessionsRouter from "./modules/sessions/routes";
import screensRouter from "./modules/captures/routes";
import extRouter from "./modules/ext/routes";
import { startStaleSweeper } from "./modules/sessions/sweep";

const PORT = Number(process.env.PORT ?? 4000);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const EXT_ORIGIN = process.env.EXT_ORIGIN;

/** Is this an allowed extension origin? Pinned via EXT_ORIGIN in prod; in dev
 *  (EXT_ORIGIN unset) reflect any chrome-extension:// origin (FR-BE-074). */
function isExtensionOrigin(origin: string): boolean {
  return EXT_ORIGIN ? origin === EXT_ORIGIN : origin.startsWith("chrome-extension://");
}

// CORS (FR-BE-074): /ext/* accepts the extension origin; every other (browser)
// route accepts only WEB_ORIGIN.
const corsDelegate: cors.CorsOptionsDelegate<express.Request> = (req, cb) => {
  if (req.path.startsWith("/api/v1/ext")) {
    const origin = req.headers.origin;
    cb(null, { origin: origin && isExtensionOrigin(origin) ? origin : false });
  } else {
    // credentials:true so the httpOnly refresh cookie flows to the panel (FR-BE-002).
    cb(null, { origin: WEB_ORIGIN, credentials: true });
  }
};

const app = express();
app.use(helmet()); // security headers (NFR-010)
app.use(cors(corsDelegate));
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/readyz", async (_req, res) => {
  // Readiness = Mongo AND S3 reachable (FR-BE-072).
  const db = dbReady();
  const s3 = await s3Ready();
  const body = {
    ready: db && s3,
    db: db ? "connected" : "disconnected",
    s3: s3 ? "connected" : "disconnected",
  };
  res.status(db && s3 ? 200 : 503).json(body);
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
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ApiError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  // Mongo duplicate-key → 409 with the uniform envelope.
  if (err && typeof err === "object" && (err as { code?: number }).code === 11000) {
    sendError(res, 409, "CONFLICT", "That resource already exists.");
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[snapcrawl-api] error:", err);
  sendError(res, 500, "INTERNAL", "Something went wrong.");
});

/** Ensure the demo admin exists (idempotent). */
async function seedAdmin(): Promise<void> {
  const email = "admin@snapcrawl.dev";
  if (await UserModel.findOne({ email })) return;
  await UserModel.create({
    name: "Admin",
    email,
    passwordHash: hashPassword("password"),
    role: "admin",
    status: "active",
  });
  // eslint-disable-next-line no-console
  console.log("[snapcrawl-api] seeded admin user (admin@snapcrawl.dev / password)");
}

async function start(): Promise<void> {
  // Fail fast if the JWT signing secret is missing (NFR-011 — no hardcoded default).
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required — set it in the environment before starting.");
  }
  await connectDb();
  await seedAdmin();
  // Ensure the screenshot bucket exists — non-fatal so the API still boots when
  // S3/MinIO is down (captures fail, but auth/projects/sessions keep working).
  await ensureBucket().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn("[snapcrawl-api] S3 bucket ensure failed (continuing):", err);
  });
  // Fail sessions whose extension went silent for > 10 min (FR-BE-032).
  startStaleSweeper();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[snapcrawl-api] listening on http://localhost:${PORT} (CORS: ${WEB_ORIGIN})`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[snapcrawl-api] failed to start:", err);
  process.exit(1);
});
