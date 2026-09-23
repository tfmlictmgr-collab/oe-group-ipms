import Link from "next/link";
import { legalOrgForHost } from "./legal-org";

// Public legal pages — Terms of Service and Refund Policy.
//
// Required by the payment gateways (Flutterwave, 22 Sept 2026) as a condition of
// account reactivation. Anonymous by design: `/legal` is outside the
// middleware's protected paths, because a reviewer and a prospective tenant
// must both be able to read the terms before they have an account.
export const dynamic = "force-dynamic";

export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const org = await legalOrgForHost();

  return (
    <main className="min-h-dvh bg-background px-4 py-10 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-8 border-b pb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest"
            style={{ color: org.primary }}
          >
            {org.name}
          </p>
          <nav className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <Link href="/legal/terms" className="underline-offset-4 hover:underline">
              Terms of Service
            </Link>
            <Link href="/legal/refunds" className="underline-offset-4 hover:underline">
              Refund Policy
            </Link>
            <Link href="/" className="text-muted-foreground underline-offset-4 hover:underline">
              Back to sign in
            </Link>
          </nav>
        </header>
        <article className="legal-prose space-y-4 text-sm leading-relaxed text-foreground [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_li]:mt-1 [&_a]:underline">
          {children}
        </article>
        <footer className="mt-12 border-t pt-6 text-xs text-muted-foreground">
          © {new Date().getFullYear()} {org.name}
        </footer>
      </div>
    </main>
  );
}
