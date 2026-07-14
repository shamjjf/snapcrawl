import type { ReactNode } from "react";
import { SessionProvider } from "@/components/session-provider";
import { AppShell } from "@/components/app-shell";

// Shared layout for all authenticated routes: gate on the session, then render
// the shell around the page. Grouped under (app) so the URL paths stay flat
// (e.g. /dashboard, /projects) with no shared prefix.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
