import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../db";
import { ProjectModel } from "../models/project";

// Flip existing projects to unlimited (FR-BE-021):
//   npm run unlimit-projects -w apps/api
//   npm run unlimit-projects -w apps/api -- --dry-run
//
// New projects default to unlimited already. Existing ones keep whatever they
// were saved with, because silently unbounding a crawler that clicks real
// buttons on live customer sites should be something you do, not something that
// happens to you on deploy. This is that deliberate act — one command for all
// projects rather than a checkbox per project.
//
// Reversible: the previous values are printed before the write, so a project can
// be set back by hand from this output.

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await connectDb();

  const affected = await ProjectModel.find({
    $or: [
      { "config.maxDepth": { $ne: null } },
      { "config.maxScreens": { $ne: null } },
      { "config.maxDurationMin": { $ne: null } },
    ],
  })
    .select("_id name config.maxDepth config.maxScreens config.maxDurationMin")
    .lean();

  if (affected.length === 0) {
    console.log("Nothing to do — every project is already unlimited.");
    await mongoose.disconnect();
    return;
  }

  console.log(`${affected.length} project(s) with a finite limit:`);
  for (const p of affected) {
    const c = (p as { config?: Record<string, unknown> }).config ?? {};
    console.log(
      `  ${String(p._id)}  ${(p as { name?: string }).name ?? "(unnamed)"}` +
        `  depth=${c.maxDepth ?? "unlimited"}` +
        `  screens=${c.maxScreens ?? "unlimited"}` +
        `  minutes=${c.maxDurationMin ?? "unlimited"}`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    await mongoose.disconnect();
    return;
  }

  const res = await ProjectModel.updateMany(
    {},
    { $set: { "config.maxDepth": null, "config.maxScreens": null, "config.maxDurationMin": null } },
  );
  console.log(`\nUpdated ${res.modifiedCount} project(s) to unlimited.`);
  console.log("Crawls on these projects now run until you press Stop.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
