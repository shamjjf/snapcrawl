"use client";

// User administration (FR-AP-060 / FR-BE-010). Admin-only: list real users from
// the database, create new users, change roles, and deactivate/reactivate.

import { useState, type FormEvent } from "react";
import { userCreateSchema, type AdminUser, type Role } from "@snapcrawl/shared";
import { useSession } from "@/components/session-provider";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  PageHeader,
  PagePlaceholder,
  Select,
  Spinner,
} from "@/components/ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast";
import { useCreateUser, useUpdateUser, useUsers } from "@/lib/queries";
import { fmtDateTime } from "@/lib/format";

const ROLES: Role[] = ["admin", "member", "viewer"];

type CreateErrors = Record<string, string>;

export default function UsersPage() {
  const { user } = useSession();
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [errors, setErrors] = useState<CreateErrors>({});
  const [toDeactivate, setToDeactivate] = useState<AdminUser | null>(null);

  const query = useUsers(search);
  const create = useCreateUser();
  const update = useUpdateUser();

  // Access control, not just hidden nav (FR-AP-005 / FR-AP-060).
  if (user.role !== "admin") {
    return (
      <>
        <PageHeader title="Users" />
        <PagePlaceholder title="Admins only">
          You don&apos;t have permission to manage workspace users.
        </PagePlaceholder>
      </>
    );
  }

  const users = query.data?.pages.flatMap((p) => p.items) ?? [];

  function resetForm() {
    setName("");
    setEmail("");
    setPassword("");
    setRole("member");
    setErrors({});
    setShowCreate(false);
  }

  function submitCreate(e: FormEvent) {
    e.preventDefault();
    if (create.isPending) return;
    const parsed = userCreateSchema.safeParse({
      name: name.trim(),
      email: email.trim(),
      password,
      role,
    });
    if (!parsed.success) {
      const map: CreateErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (!map[key]) map[key] = issue.message;
      }
      setErrors(map);
      return;
    }
    setErrors({});
    create.mutate(parsed.data, {
      onSuccess: (u) => {
        toast.success(`User "${u.name}" created.`);
        resetForm();
      },
    });
  }

  function changeRole(target: AdminUser, next: Role) {
    if (next === target.role) return;
    update.mutate(
      { id: target.id, input: { role: next } },
      { onSuccess: () => toast.success(`${target.name} is now ${next}.`) },
    );
  }

  function reactivate(target: AdminUser) {
    update.mutate(
      { id: target.id, input: { status: "active" } },
      { onSuccess: () => toast.success(`Reactivated ${target.name}.`) },
    );
  }

  function confirmDeactivate() {
    if (!toDeactivate) return;
    const name_ = toDeactivate.name;
    update.mutate(
      { id: toDeactivate.id, input: { status: "deactivated" } },
      {
        onSuccess: () => {
          toast.success(`Deactivated ${name_}.`);
          setToDeactivate(null);
        },
      },
    );
  }

  const rowBusy = (id: string) => update.isPending && update.variables?.id === id;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Manage workspace members and roles."
        actions={
          <Button variant="primary" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? "Cancel" : "New user"}
          </Button>
        }
      />

      {showCreate ? (
        <section className="card form-section">
          <h2 className="form-section__title">Create a user</h2>
          <form onSubmit={submitCreate} noValidate>
            <div className="form-grid">
              <Field label="Name" htmlFor="u-name" error={errors.name}>
                <Input
                  id="u-name"
                  value={name}
                  invalid={!!errors.name}
                  placeholder="Jane Doe"
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Email" htmlFor="u-email" error={errors.email}>
                <Input
                  id="u-email"
                  type="email"
                  value={email}
                  invalid={!!errors.email}
                  placeholder="jane@company.com"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field
                label="Temporary password"
                htmlFor="u-password"
                error={errors.password}
                hint="At least 8 characters. Share it with the user to sign in."
              >
                <Input
                  id="u-password"
                  type="text"
                  value={password}
                  invalid={!!errors.password}
                  autoComplete="off"
                  placeholder="••••••••"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label="Role" htmlFor="u-role" error={errors.role}>
                <Select
                  id="u-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="form-actions" style={{ marginTop: "var(--space-4)" }}>
              <Button type="submit" variant="primary" loading={create.isPending}>
                Create user
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      <div style={{ maxWidth: 420 }}>
        <Input
          type="search"
          placeholder="Search by name or email…"
          aria-label="Search users"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {query.isLoading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--color-text-muted)",
          }}
        >
          <Spinner /> Loading users…
        </div>
      ) : query.isError ? (
        <Alert tone="danger">Couldn&apos;t load users. Please try again.</Alert>
      ) : users.length === 0 ? (
        <PagePlaceholder title={search ? "No users match your search" : "No users yet"}>
          {search ? "Try a different term." : "Create the first user above."}
        </PagePlaceholder>
      ) : (
        <>
          <section className="card" style={{ padding: "var(--space-2)" }}>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Last login</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = u.id === user.id;
                    const busy = rowBusy(u.id);
                    return (
                      <tr key={u.id}>
                        <td style={{ fontWeight: "var(--weight-medium)" }}>
                          {u.name}
                          {isSelf ? <span className="subtle"> (you)</span> : null}
                        </td>
                        <td className="muted">{u.email}</td>
                        <td>
                          <Select
                            aria-label={`Role for ${u.name}`}
                            value={u.role}
                            disabled={isSelf || busy}
                            onChange={(e) => changeRole(u, e.target.value as Role)}
                            style={{ height: 32, minWidth: 110 }}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td>
                          <Badge tone={u.status === "active" ? "success" : "neutral"}>
                            {u.status === "active" ? "Active" : "Deactivated"}
                          </Badge>
                        </td>
                        <td className="muted">{fmtDateTime(u.lastLoginAt)}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {isSelf ? (
                            <span className="subtle">—</span>
                          ) : u.status === "active" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => setToDeactivate(u)}
                            >
                              Deactivate
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={busy}
                              onClick={() => reactivate(u)}
                            >
                              Reactivate
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {query.hasNextPage ? (
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Button
                variant="secondary"
                onClick={() => void query.fetchNextPage()}
                loading={query.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={!!toDeactivate}
        title="Deactivate user"
        confirmLabel="Deactivate"
        busy={update.isPending}
        onConfirm={confirmDeactivate}
        onCancel={() => setToDeactivate(null)}
      >
        <p style={{ margin: 0 }}>
          Deactivating <strong>{toDeactivate?.name}</strong> signs them out and immediately
          revokes their extension tokens. You can reactivate them later.
        </p>
      </ConfirmDialog>
    </>
  );
}
