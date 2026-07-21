import type { Request } from "express";
import type { AuditAction, AuditTargetType } from "@snapcrawl/shared";
import { AuditLogModel } from "../models/auditLog";
import { errorFields, log } from "./logger";

// Audit trail writes (FR-BE-012). One helper, called from the handlers that
// perform security-relevant actions, so the trail lives next to the thing it
// records rather than in middleware that has to guess what happened.

export interface AuditContext {
  ip: string | null;
  userAgent: string | null;
}

/** Pull the request fingerprint SRS §8.4 wants on every row. Pure.
 *
 *  NOTE: `req.ip` is the socket peer unless Express is told to trust the proxy.
 *  Behind a load balancer every row would read as the LB's address — set
 *  `app.set("trust proxy", …)` when this deploys behind one, or the ip column
 *  becomes decorative. */
export function auditContextOf(req: Request): AuditContext {
  const ua = req.headers["user-agent"];
  return {
    ip: req.ip ?? null,
    // Cap it: this is attacker-controlled input being written to storage.
    userAgent: typeof ua === "string" ? ua.slice(0, 400) : null,
  };
}

export interface AuditEvent {
  action: AuditAction;
  /** Null when the actor is unknown (e.g. login for an unregistered email). */
  userId?: string | null;
  targetType?: AuditTargetType;
  targetId?: string | null;
  req?: Request;
}

/**
 * Record one security event.
 *
 * Never throws. An audit write must not be able to turn a successful login into
 * a 500 — the user's action already happened, and failing their request would
 * not un-happen it. A dropped row is logged loudly instead, because silence
 * here is the one failure mode that defeats the point of an audit trail.
 */
export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    const ctx = event.req ? auditContextOf(event.req) : { ip: null, userAgent: null };
    await AuditLogModel.create({
      userId: event.userId ?? undefined,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId ?? undefined,
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
  } catch (err) {
    log.error("audit write failed", { action: event.action, ...errorFields(err) });
  }
}

/** Has this project ever been attested as authorised to test (NFR-020)? The
 *  audit log is the record of the confirmation; `projects.authorisedUse` is the
 *  read model the gate actually checks. */
export async function findAuthorisedUse(projectId: string): Promise<Date | null> {
  const row = await AuditLogModel.findOne({
    action: "project.authorised_use",
    targetType: "project",
    targetId: projectId,
  }).sort({ createdAt: 1 });
  return row?.createdAt ?? null;
}
