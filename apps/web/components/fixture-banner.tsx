"use client";

// A permanent, unmissable marker that the data on screen is invented.
//
// Fixture mode is dangerous precisely because it does NOT look broken: auth,
// /me and /dashboard have no fixture branch, so you sign in for real and see
// real KPI counts, and only the projects, sessions and screenshots underneath
// them are fabricated. Without this banner the panel is indistinguishable from a
// working one — which is how a demo ends up presenting invented numbers as real.
//
// Deliberately not dismissible: the whole point is that it cannot be mistaken
// for a transient notice. It renders nothing at all in live mode, so it costs
// normal users nothing.

import { USE_FIXTURES } from "@/lib/api";

export function FixtureBanner() {
  if (!USE_FIXTURES) return null;
  return (
    <div className="fixture-banner" role="status">
      <strong>Demo data.</strong> Projects, sessions and screenshots on this page are{" "}
      <strong>invented fixtures</strong>, not real crawl results. Unset{" "}
      <code>NEXT_PUBLIC_USE_FIXTURES</code> to use the API.
    </div>
  );
}
