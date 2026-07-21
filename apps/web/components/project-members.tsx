"use client";

// Project membership management (FR-AP-023 → FR-BE-024). A project's people list
// is owner + members; adding someone here is what lets them SEE the project
// (visibilityFilter). There is no per-project role — Admin/Member/Viewer are
// global (FR-BE-006) — so this only controls access, and what a person may DO
// once in still comes from their own role. That is why a "viewer" added here can
// read and never write, with no extra machinery.
//
// A contract wrinkle worth stating: the add endpoint takes a userId, and the
// only way to resolve a name/email to an id is the admin-only GET /users. So the
// people PICKER only populates for admins; a non-admin owner can still remove
// members (the API allows it) but is told that adding needs an admin, rather
// than shown an empty or broken picker.

import { useMemo, useState } from "react";
import type { Project } from "@snapcrawl/shared";
import { Alert, Badge, Button, Select, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { useSession as useAuthSession } from "@/components/session-provider";
import {
  useAddProjectMember,
  useProjectMembers,
  useRemoveProjectMember,
  useUsers,
} from "@/lib/queries";

export function ProjectMembers({ project }: { project: Project }) {
  const { user } = useAuthSession();
  const toast = useToast();
  const membersQ = useProjectMembers(project.id);
  const add = useAddProjectMember(project.id);
  const remove = useRemoveProjectMember(project.id);
  const [pick, setPick] = useState("");

  // Manage = owner or admin, mirroring the API's canManage (a non-owner member
  // gets 403 on add/remove), so we don't show controls that would fail.
  const canManage = user.role === "admin" || project.ownerId === user.id;
  // The picker needs the user directory, which is admin-only.
  const canPickUsers = user.role === "admin";
  const usersQ = useUsers("");

  const members = membersQ.data ?? [];
  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);

  // Candidates to add: active users not already on the list (the API rejects
  // deactivated accounts, so don't offer them).
  const candidates = useMemo(() => {
    const all = usersQ.data?.pages.flatMap((p) => p.items) ?? [];
    return all.filter((u) => u.status === "active" && !memberIds.has(u.id));
  }, [usersQ.data, memberIds]);

  function doAdd() {
    if (!pick) return;
    add.mutate(pick, {
      onSuccess: () => {
        toast.success("Member added.");
        setPick("");
      },
      onError: (e) => toast.error(e as never),
    });
  }

  function doRemove(id: string, name: string) {
    remove.mutate(id, {
      onSuccess: () => toast.success(`Removed ${name}.`),
      onError: (e) => toast.error(e as never),
    });
  }

  return (
    <section className="card" style={{ padding: "var(--space-5)" }}>
      <h2 className="form-section__title" style={{ marginBottom: "var(--space-1)" }}>
        Members
      </h2>
      <p className="subtle" style={{ margin: "0 0 var(--space-4)", fontSize: "var(--text-sm)" }}>
        People who can see this project. Access only — what each person may do comes
        from their own role.
      </p>

      {membersQ.isLoading ? (
        <div className="loading-row">
          <Spinner /> Loading members…
        </div>
      ) : membersQ.isError ? (
        <Alert tone="danger">Couldn&apos;t load the member list.</Alert>
      ) : (
        <ul className="member-list">
          {members.map((m) => (
            <li key={m.id} className="member-list__item">
              <div style={{ minWidth: 0 }}>
                <div className="member-list__name">
                  {m.name}
                  {m.isOwner ? (
                    <Badge tone="neutral">owner</Badge>
                  ) : (
                    <Badge tone="neutral">{m.role}</Badge>
                  )}
                </div>
                <div className="subtle mono" style={{ fontSize: "var(--text-xs)" }}>
                  {m.email}
                </div>
              </div>
              {canManage && !m.isOwner ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => doRemove(m.id, m.name)}
                  disabled={remove.isPending}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        canPickUsers ? (
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
            <Select
              aria-label="Add a member"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              disabled={usersQ.isLoading || candidates.length === 0}
              style={{ maxWidth: 320 }}
            >
              <option value="">
                {usersQ.isLoading
                  ? "Loading users…"
                  : candidates.length === 0
                    ? "Everyone already has access"
                    : "Add a person…"}
              </option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email}) · {u.role}
                </option>
              ))}
            </Select>
            <Button variant="secondary" onClick={doAdd} disabled={!pick || add.isPending}>
              Add
            </Button>
          </div>
        ) : (
          <Alert tone="info">
            Ask an admin to add members — resolving a person to add requires the user
            directory, which only admins can list.
          </Alert>
        )
      ) : null}
    </section>
  );
}
