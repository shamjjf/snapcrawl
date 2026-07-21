import "dotenv/config";
import mongoose from "mongoose";
import { registerSchema } from "@snapcrawl/shared";
import { hashPassword } from "../auth";
import { connectDb } from "../db";
import { UserModel } from "../models/user";
import { resolveAdminSeed } from "../modules/users/service";

// Deliberate admin bootstrap (FR-BE-001, NFR-011):
//   SEED_ADMIN_EMAIL=… SEED_ADMIN_PASSWORD=… npm run seed:admin -w apps/api
//
// This is the supported way to create the first admin — boot-time seeding is
// opt-in and never invents credentials in production, so an operator needs one
// explicit command rather than a known default account. Credentials must be
// supplied: this script never generates or guesses one.

async function main(): Promise<void> {
  const decision = resolveAdminSeed({
    seedAdmin: true, // running this script IS the opt-in
    email: process.env.SEED_ADMIN_EMAIL,
    password: process.env.SEED_ADMIN_PASSWORD,
    isProd: true, // always demand explicit credentials, whatever NODE_ENV says
  });

  if (decision.action !== "seed") {
    throw new Error(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are both required.\n" +
        "  Example: SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='…' " +
        "npm run seed:admin -w apps/api",
    );
  }

  // Hold the seeded credentials to exactly the same rules as a real
  // registration, rather than inventing a second standard (FR-BE-001).
  const creds = registerSchema.pick({ email: true, password: true }).safeParse({
    email: decision.email,
    password: decision.password,
  });
  if (!creds.success) {
    throw new Error(
      `invalid seed credentials:\n${creds.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }

  await connectDb();
  try {
    const email = creds.data.email.toLowerCase();
    const existing = await UserModel.findOne({ email });
    if (existing) {
      // Idempotent and non-destructive: never silently reset a live password.
      // eslint-disable-next-line no-console
      console.log(`[seed-admin] ${email} already exists (role: ${existing.role}) — nothing to do.`);
      return;
    }
    await UserModel.create({
      name: process.env.SEED_ADMIN_NAME ?? "Admin",
      email,
      passwordHash: hashPassword(creds.data.password),
      role: "admin",
      status: "active",
      // Pre-verified (FR-BE-008): the operator who ran this command already
      // controls the account, and if REQUIRE_EMAIL_VERIFICATION is later turned
      // on, the bootstrap admin must not be the one account locked out of the
      // system it administers by a link it may have no inbox to receive.
      emailVerifiedAt: new Date(),
    });
    // The operator supplied the password, so it is never echoed back.
    // eslint-disable-next-line no-console
    console.log(`[seed-admin] created admin ${email}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[seed-admin] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
