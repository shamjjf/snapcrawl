"use client";

// Create project (FR-AP-020).

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { ProjectForm } from "@/components/project-form";
import { useToast } from "@/components/toast";
import { useCreateProject } from "@/lib/queries";

export default function NewProjectPage() {
  const router = useRouter();
  const toast = useToast();
  const create = useCreateProject();

  return (
    <>
      <PageHeader title="New project" subtitle="Define a crawl target and its configuration." />
      <ProjectForm
        mode="create"
        submitting={create.isPending}
        onSubmit={(payload) =>
          create.mutate(payload, {
            onSuccess: (project) => {
              toast.success(`Project "${project.name}" created.`);
              router.push("/projects");
            },
          })
        }
      />
    </>
  );
}
