import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// S3 object storage for screenshots (FR-BE-040/041/044, NFR-013). MinIO stands
// in for S3 locally (path-style + custom endpoint); real S3/CloudFront in prod.
const ENDPOINT = process.env.S3_ENDPOINT || undefined;
const REGION = process.env.S3_REGION ?? "us-east-1";
export const S3_BUCKET = process.env.S3_BUCKET ?? "snapcrawl";
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID ?? "minioadmin";
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin";
const FORCE_PATH_STYLE = (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true";

/** Hard limits (NFR-013): uploads ≤ 15 MB, PUT presign ≤ 10 min, GET signed ≤ 1 h. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const PUT_TTL_SEC = 600;
export const GET_TTL_SEC = 3600;

export const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: FORCE_PATH_STYLE,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

/** Create the bucket if it does not exist. Called on boot; non-fatal. */
export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  }
}

/** Readiness probe input (FR-BE-072): can we reach the bucket? */
export async function s3Ready(): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    return true;
  } catch {
    return false;
  }
}

/** Time-limited presigned PUT for a single server-chosen key + content type. */
export function presignPut(
  key: string,
  contentType: string,
  ttlSec: number = PUT_TTL_SEC,
): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(s3, cmd, { expiresIn: ttlSec });
}

/** Short-lived presigned GET for authorised reads (FR-BE-044). */
export function presignGet(key: string, ttlSec: number = GET_TTL_SEC): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), {
    expiresIn: ttlSec,
  });
}

/** Object metadata, or null if it does not exist. Used to verify uploads. */
export async function headObject(
  key: string,
): Promise<{ size: number; contentType?: string } | null> {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return { size: r.ContentLength ?? 0, contentType: r.ContentType };
  } catch {
    return null;
  }
}

/** Best-effort delete (e.g. to drop an oversize upload). */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } catch {
    /* best effort */
  }
}
