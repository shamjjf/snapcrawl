import mongoose from "mongoose";
import { log } from "./lib/logger";

/** Connect to MongoDB. Reads MONGODB_URI at call time (after env is loaded). */
export async function connectDb(): Promise<void> {
  const uri =
    process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/snapcrawl";
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  log.info("MongoDB connected", { uri });
}

export function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}
