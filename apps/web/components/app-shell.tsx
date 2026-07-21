"use client";

// Authenticated app shell: left sidebar (role-aware nav) + top bar, wrapping
// every signed-in route. Navigation visibility is role-appropriate — the
// Administration section is Admin-only (FR-AP-005).

import { useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/components/session-provider";
import {
  Button,
  FolderIcon,
  GridIcon,
  KeyIcon,
  Logo,
  MenuIcon,
  UsersIcon,
} from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { FixtureBanner } from "@/components/fixture-banner";

type NavItem = {
  href: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
};

const MAIN: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", Icon: GridIcon },
  { href: "/projects", label: "Projects", Icon: FolderIcon },
  { href: "/tokens", label: "Extension tokens", Icon: KeyIcon },
];

// Admin-only section (FR-AP-005 / FR-AP-060).
const ADMIN: NavItem[] = [{ href: "/users", label: "Users", Icon: UsersIcon }];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isAdmin = user.role === "admin";

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  function NavLink({ item }: { item: NavItem }) {
    const active = isActive(item.href);
    return (
      <Link
        href={item.href}
        className={`sidebar-link${active ? " sidebar-link--active" : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={() => setOpen(false)}
      >
        <item.Icon size={18} />
        {item.label}
      </Link>
    );
  }

  return (
    <div className="app-layout">
      {open ? (
        <div
          className="sidebar__backdrop"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      ) : null}

      <aside className={`sidebar${open ? " sidebar--open" : ""}`}>
        <Link href="/dashboard" className="sidebar__brand" onClick={() => setOpen(false)}>
          <Logo size={26} />
          <strong style={{ fontSize: "var(--text-lg)", color: "var(--color-text)" }}>
            SnapCrawl
          </strong>
        </Link>

        <nav className="sidebar__nav" aria-label="Primary">
          {MAIN.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </nav>

        {isAdmin ? (
          <div className="sidebar__section">
            <div className="sidebar__section-label">Administration</div>
            <nav className="sidebar__nav" aria-label="Administration">
              {ADMIN.map((item) => (
                <NavLink key={item.href} item={item} />
              ))}
            </nav>
          </div>
        ) : null}
      </aside>

      <div className="app-body">
        {/* Above the topbar so it is the first thing on the page in fixture
            mode, and part of the scroll container so it cannot be scrolled away. */}
        <FixtureBanner />
        <header className="app-topbar">
          <button
            type="button"
            className="icon-btn app-hamburger"
            aria-label="Open navigation menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <MenuIcon />
          </button>
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
            }}
          >
            <ThemeToggle />
            <span className="muted app-topbar__email" style={{ fontSize: "var(--text-sm)" }}>
              {user.email}
            </span>
            <Button variant="secondary" size="sm" onClick={logout}>
              Log out
            </Button>
          </span>
        </header>

        <main className="app-main">
          <div className="app-content">{children}</div>
        </main>
      </div>
    </div>
  );
}
