import Link from "next/link";
import { orgForCurrentHost } from "@/lib/org-host";

// The page a missing address lands on.
//
// 📌 11 Sept 2026. There was none, so Next's own default rendered — a black
// screen reading "404 | This page could not be found", with no name, no way
// back, and nothing to tell an OEA tenant on oeaportal.com that they were still
// on OEA's portal. It was reached by a real tenant pressing "Continue payment"
// (fixed in 0288), but any stale link reaches it.
//
// Branding from the HOST only, exactly like the sign-in doors: it paints a
// name and a colour, and decides nothing — an unbound host gets the neutral
// wording, and no other organisation is ever named (B1).
export default async function NotFound() {
  const org = await orgForCurrentHost().catch(() => null);
  const name = org && !org.is_platform_operator ? org.name : null;
  const primary = (org && !org.is_platform_operator && org.theme_primary) || "#003366";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-16">
      <div className="w-full max-w-md text-center">
        {name && (
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {name}
          </p>
        )}
        <p className="mt-3 text-5xl font-semibold tabular-nums" style={{ color: primary }}>
          404
        </p>
        <h1 className="mt-3 text-lg font-semibold">That page is not here</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The link may be out of date, or the page may have moved. Nothing you were doing has been
          lost — go back to your dashboard and pick up from there.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href="/dashboard"
            className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-white"
            style={{ background: primary }}
          >
            Go to my dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
