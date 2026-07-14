"use client";

// Global client providers: toast context + TanStack Query. The QueryClient is
// created inside the tree so its cache-level error handlers can push toasts
// through the uniform error envelope (FR-AP-070). Mounted once in the root
// layout so both public and authenticated routes share them.

import { useState, type ReactNode } from "react";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { ToastProvider, useToast } from "@/components/toast";
import { toEnvelope } from "@/lib/api";

function QueryProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [client] = useState(() => {
    // A 401 (UNAUTHORIZED) is handled by onUnauthorized() in lib/api (clear +
    // redirect to login), so don't toast it or retry it here (FR-AP-004).
    const onError = (err: unknown) => {
      const env = toEnvelope(err);
      if (env.code === "UNAUTHORIZED") return;
      toast.error(env);
    };
    return new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
      defaultOptions: {
        queries: {
          retry: (count, err) => toEnvelope(err).code !== "UNAUTHORIZED" && count < 1,
          staleTime: 30_000,
          refetchOnWindowFocus: false,
        },
      },
    });
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <QueryProvider>{children}</QueryProvider>
    </ToastProvider>
  );
}
