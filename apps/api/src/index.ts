import "dotenv/config";
import { createApp } from "./app";
import { isProd, envFlag } from "./config/env";
import { connectDb } from "./db";
import { UserModel } from "./models/user";
import { hashPassword } from "./auth";
import { errorFields, log } from "./lib/logger";
import { startBucketEnsurer } from "./lib/s3";
import { resolveAdminSeed } from "./modules/users/service";
import { startPurgeSweeper } from "./modules/projects/purge";
import { startStaleSweeper } from "./modules/sessions/sweep";

// Process lifecycle only — the Express app itself lives in ./app so tests can
// drive the routes without any of these side effects.

const PORT = Number(process.env.PORT ?? 4000);

/**
 * Create the bootstrap admin, if this deployment asked for one (FR-BE-001).
 * Opt-in via SEED_ADMIN=true; see resolveAdminSeed for why the flag — not
 * NODE_ENV — is what keeps a demo account out of production.
 */
async function bootstrapAdmin(): Promise<void> {
  const decision = resolveAdminSeed({
    seedAdmin: envFlag("SEED_ADMIN"),
    email: process.env.SEED_ADMIN_EMAIL,
    password: process.env.SEED_ADMIN_PASSWORD,
    isProd: isProd(),
  });

  if (decision.action === "refuse") throw new Error(decision.reason);

  if (decision.action === "seed") {
    if (await UserModel.findOne({ email: decision.email })) return;
    await UserModel.create({
      name: "Admin",
      email: decision.email,
      passwordHash: hashPassword(decision.password),
      role: "admin",
      status: "active",
      // Pre-verified (FR-BE-008): a bootstrap admin is a trusted operator action,
      // and must stay able to sign in even if REQUIRE_EMAIL_VERIFICATION is on.
      emailVerifiedAt: new Date(),
    });
    // Only ever print a password we generated ourselves, and never in prod. An
    // operator-supplied one is never echoed (FR-BE-001: no plaintext logging).
    if (decision.generated && !isProd()) {
      log.info("seeded admin (generated password — dev only)", {
        email: decision.email,
        password: decision.password,
      });
    } else {
      log.info("seeded admin", { email: decision.email });
    }
    return;
  }

  // Skipped. Warn — never hard-fail — if the deployment has no admin at all:
  // seeding is the only admin-creating path (register hardcodes role "member"
  // and POST /users is admin-gated), so refusing to boot would strand the
  // operator with no way in.
  if ((await UserModel.countDocuments({ role: "admin", status: "active" })) === 0) {
    log.warn("no active admin users exist — the API cannot be administered", {
      fix: "npm run seed:admin -w apps/api",
    });
  }
}

async function start(): Promise<void> {
  // Fail fast if the JWT signing secret is missing (NFR-011 — no hardcoded default).
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required — set it in the environment before starting.");
  }
  await connectDb();
  await bootstrapAdmin();
  // Ensure the screenshot bucket in the BACKGROUND: storage that is slow or not
  // up yet must not hold the listener hostage (an unreachable endpoint costs
  // ~2 min of SDK retries). Captures fail until it converges; auth/projects/
  // sessions serve immediately, and /readyz reports the truth meanwhile.
  startBucketEnsurer();
  // Fail sessions whose extension went silent for > 10 min (FR-BE-032).
  startStaleSweeper();
  // Cascade-delete projects whose 7-day grace period has expired (FR-BE-025).
  startPurgeSweeper();
  createApp().listen(PORT, () => {
    log.info("listening", {
      url: `http://localhost:${PORT}`,
      webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    });
  });
}

start().catch((err: unknown) => {
  log.error("failed to start", errorFields(err));
  process.exit(1);
});
