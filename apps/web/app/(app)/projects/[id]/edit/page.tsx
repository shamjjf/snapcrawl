"use client";

// Edit project (FR-AP-020). Pre-fills the form from the loaded project; the
// form covers every FR-BE-021 field.

import { useParams, useRouter } from "next/navigation";
import { Alert, PageHeader, Spinner } from "@/components/ui";
import { ProjectForm } from "@/components/project-form";
import { useToast } from "@/components/toast";
import { useProject, useUpdateProject } from "@/lib/queries";

export default function EditProjectPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const toast = useToast();

  const query = useProject(id);
  const update = useUpdateProject(id);

  if (query.isLoading) {
    return (
      <>
        <PageHeader title="Edit project" />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--color-text-muted)",
          }}
        >
          <Spinner /> Loading…
        </div>
      </>
    );
  }

  if (query.isError || !query.data) {
    return (
      <>
        <PageHeader title="Edit project" />
        <Alert tone="danger">Couldn&apos;t load this project.</Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Edit project" subtitle={query.data.name} />
      <ProjectForm
        mode="edit"
        initial={query.data}
        submitting={update.isPending}
        onSubmit={(payload) =>
          update.mutate(payload, {
            onSuccess: () => {
              toast.success("Project updated.");
              router.push("/projects");
            },
          })
        }
      />
    </>
  );
}
