// Project create/update DTOs (FR-BE-020..023). The base-URL-in-allowedDomains
// check (FR-BE-023) is enforced here when domains are supplied; the non-empty
// rule and full validation live in the project service/route.
import { z } from "zod";
import { authorisedUseSchema } from "./audit.js";
import { cursorQuerySchema, objectIdSchema } from "./common.js";
import { crawlConfigSchema } from "./config.js";
import { sessionStatusSchema } from "./session.js";

export const projectStatusSchema = z.enum(["active", "archived", "pending-delete"]);

/** GET /projects query: cursor pagination + case-insensitive name search
 *  (FR-BE-020/073). The cursor is a project ObjectId. */
export const projectListQuerySchema = cursorQuerySchema.extend({
  cursor: objectIdSchema.optional(),
  search: z.string().trim().max(200).optional(),
});

export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

/** Extract the host from a URL without relying on the URL global (shared has no DOM/node libs). */
function hostOf(url: string): string | null {
  const m = /^[a-z][a-z\d+.-]*:\/\/([^/:?#]+)/i.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

/** True when `host` is `domain` or a subdomain of it. */
function hostInDomains(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => {
    const dd = d.toLowerCase();
    return host === dd || host.endsWith(`.${dd}`);
  });
}

const baseFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  baseUrl: z.url(),
  config: crawlConfigSchema.optional(),
};

export const projectCreateSchema = z
  .object(baseFields)
  .superRefine((val, ctx) => {
    const domains = val.config?.allowedDomains;
    if (domains && domains.length > 0) {
      const host = hostOf(val.baseUrl);
      if (host && !hostInDomains(host, domains)) {
        ctx.addIssue({
          code: "custom",
          path: ["config", "allowedDomains"],
          message: "allowedDomains must include the base URL's domain (FR-BE-023).",
        });
      }
    }
  });

export const projectUpdateSchema = z.object({
  name: baseFields.name.optional(),
  description: baseFields.description,
  baseUrl: baseFields.baseUrl.optional(),
  config: crawlConfigSchema.partial().optional(),
  status: projectStatusSchema.optional(),
});

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type ProjectCreate = z.infer<typeof projectCreateSchema>;
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

// ── Response entities (what the API returns; SRS §8.3) ──────────────────────
// Added for the admin panel's list/detail/edit views. The write DTOs above are
// inputs; these are the read model both the panel and API should share.

/** Compact last-run summary shown in the projects list (FR-AP-020). */
export const projectLastRunSchema = z.object({
  sessionId: objectIdSchema,
  status: sessionStatusSchema,
  startedAt: z.coerce.date().nullable(),
  screensCaptured: z.number().int().min(0).default(0),
});

/** Full project record returned by the API (SRS §8.3, config per FR-BE-021). */
export const projectSchema = z.object({
  id: objectIdSchema,
  ownerId: objectIdSchema,
  memberIds: z.array(objectIdSchema).default([]),
  name: z.string(),
  description: z.string().optional(),
  baseUrl: z.string(),
  config: crawlConfigSchema,
  status: projectStatusSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  /** The authorised-use attestation (NFR-020). Null until someone confirms they
   *  own or are authorised to test this target; until then the extension cannot
   *  start a session and the panel should prompt. */
  authorisedUse: authorisedUseSchema.nullable().default(null),
  /** Soft delete (FR-BE-025). Null on every project the normal endpoints return
   *  — deleted projects are filtered out of every read — so this is non-null
   *  only in the trash listing and the response to DELETE itself. */
  deletedAt: z.coerce.date().nullable().default(null),
  /** When the cascade will actually run: `deletedAt` + 7 days. Derived, sent so
   *  the panel can say "restorable until …" without duplicating the constant. */
  purgeDueAt: z.coerce.date().nullable().default(null),
  // Enriched on list responses; omitted/null on plain detail reads.
  lastRun: projectLastRunSchema.nullable().optional(),
});

export type ProjectLastRun = z.infer<typeof projectLastRunSchema>;
export type Project = z.infer<typeof projectSchema>;

// ── Membership (FR-BE-024) ──────────────────────────────────────────────────
// A project's membership list is what `visibilityFilter` reads: owner OR member
// OR global admin. Note there is no PER-PROJECT role — SRS §4.1 defines
// Admin/Member/Viewer as global roles (FR-BE-006), so "assigning Members and
// Viewers to a project" means adding those users to this list; what they may DO
// once inside still comes from their own role. A viewer added here can read the
// project and never write it, with no extra machinery.

/** One entry in a project's people list, resolved to something renderable —
 *  the panel needs names, not a bag of ObjectIds it has to go and look up. */
export const projectMemberSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  email: z.string(),
  role: z.enum(["admin", "member", "viewer"]),
  /** True for the one person who owns the project; owners cannot be removed. */
  isOwner: z.boolean().default(false),
});

/** POST /projects/:id/members body. */
export const projectMemberAddSchema = z.object({
  userId: objectIdSchema,
});

/** GET /projects/:id/members response: the owner first, then members. */
export const projectMemberListSchema = z.object({
  items: z.array(projectMemberSchema),
});

export type ProjectMember = z.infer<typeof projectMemberSchema>;
export type ProjectMemberAdd = z.infer<typeof projectMemberAddSchema>;
export type ProjectMemberList = z.infer<typeof projectMemberListSchema>;
