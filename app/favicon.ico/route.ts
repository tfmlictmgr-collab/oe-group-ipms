import { NextRequest, NextResponse } from "next/server";
import { orgForCurrentHost } from "@/lib/org-host";

// A dynamic /favicon.ico, not the static convention file it replaces.
//
// Next.js will not let a static `app/favicon.ico` and a route at that same
// path coexist — they are the same filesystem name — so this route now owns
// the URL entirely. The default icon that used to live there is unchanged in
// substance, just relocated to `public/favicon-default.ico`.
//
// Why this needs to be dynamic at all: a bound custom domain (`tfmlportal.com`,
// `oeaportal.com`) is a brand's own front door, and browsers request
// `/favicon.ico` directly — a page-level `<link rel="icon">` (which is how
// `/o/[slug]` gets its org's icon, in that page's own `generateMetadata`)
// never gets a chance to apply before that request lands. This is the one path
// that has to answer from the Host header itself.
//
// Redirect, not proxy: the logo already lives at a public Storage URL, so
// serving it again through our own function is a needless second fetch and a
// second place to get content-type wrong. `orgForCurrentHost()` already
// returns null (no DB round trip) for localhost and *.vercel.app, so the
// shared dev host correctly falls through to the default rather than guessing
// which org's icon belongs on a host with no single owner.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const org = await orgForCurrentHost();
  const target = org?.logo_url ?? new URL("/favicon-default.ico", request.url).toString();
  return NextResponse.redirect(target, { status: 307 });
}
