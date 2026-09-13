import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ShieldCheck, CheckCircle2, Clock } from "lucide-react";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getBrandTheme } from "@/lib/brands";
import { publicOrgName } from "@/lib/org-public";
import { hashPayoutToken } from "@/lib/payout-evidence";
import PayoutDetailsForm from "./PayoutDetailsForm";

// Where somebody we are about to pay tells us their bank account (0289).
//
// Unauthenticated by design: a contractor named on a requisition may never
// have had a login, and making them create one to be paid would be the wrong
// way round. The token in the address is the whole authority; only its
// SHA-256 is stored, and `payout_request_by_token` returns one row or none.

export const dynamic = "force-dynamic";

/** `noindex`: this link is handed to one person, and an indexed copy is an
 *  open door to their bank details. */
export const metadata: Metadata = {
  title: "Your bank details",
  robots: { index: false, follow: false },
};

type RequestRow = {
  request_id: string;
  state: "open" | "submitted" | "lapsed" | "withdrawn";
  org_name: string;
  portal_name: string | null;
  logo_url: string | null;
  theme_primary: string | null;
  delivery_brand: string;
  payee_name: string;
  purpose: string;
  expires_at: string;
  submitted_at: string | null;
  bank_name: string | null;
  account_last4: string | null;
};

function longDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos", day: "numeric", month: "long", year: "numeric",
  });
}

export default async function PayoutDetailsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { data } = await supabaseAdmin.rpc("payout_request_by_token", {
    p_token_hash: hashPayoutToken(decodeURIComponent(token ?? "")),
  });
  const req = (Array.isArray(data) ? data[0] : data) as RequestRow | undefined;

  // A wrong token, a cancelled link and one that never existed all answer the
  // same 404 — anything else tells a stranger which of the three it was.
  if (!req || req.state === "withdrawn") notFound();

  const brandName = publicOrgName({ name: req.org_name, portal_name: req.portal_name });
  const brand = getBrandTheme(req.delivery_brand, { theme_primary: req.theme_primary }).primary;

  return (
    <main
      className="bg-brand-wash min-h-dvh bg-background px-4 py-8 sm:py-12"
      style={{ ["--brand" as string]: brand, ["--brand-fg" as string]: "#ffffff" }}
    >
      <div className="mx-auto w-full max-w-xl space-y-6">
        <header className="flex items-center gap-3">
          {req.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={req.logo_url} alt="" className="h-9 w-auto max-w-[140px] object-contain" />
          ) : (
            <span
              className="flex size-9 items-center justify-center rounded-lg text-sm font-bold shadow-sm"
              style={{ background: brand, color: "#fff" }}
            >
              {brandName.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="font-semibold tracking-tight">{brandName}</span>
        </header>

        <div className="rounded-2xl border border-border/80 bg-card p-5 shadow-[var(--shadow-md)] sm:p-7">
          <div className="space-y-6">
            <div className="space-y-1">
              <p className="eyebrow text-[var(--brand)]">{brandName}</p>
              <h1 className="text-xl font-semibold tracking-tight">Your bank details</h1>
              <p className="text-pretty text-sm text-muted-foreground">
                For {req.payee_name} — so we can pay you for: {req.purpose}.
              </p>
            </div>

            {req.state === "open" && (
              <PayoutDetailsForm token={token} brandName={brandName} payeeName={req.payee_name} />
            )}

            {req.state === "submitted" && (
              <div className="flex items-start gap-3 rounded-xl border border-success/40 bg-success/5 p-4 text-sm">
                <CheckCircle2 className="mt-0.5 size-5 flex-shrink-0 text-success" />
                <p className="text-pretty">
                  Your details reached us on {longDate(req.submitted_at)}
                  {req.bank_name && req.account_last4
                    ? ` — your ${req.bank_name} account ending ${req.account_last4}`
                    : ""}
                  . There is nothing more to do here. If they have changed since, ask whoever sent this
                  link for a new one.
                </p>
              </div>
            )}

            {req.state === "lapsed" && (
              <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm">
                <Clock className="mt-0.5 size-5 flex-shrink-0 text-warning" />
                <p className="text-pretty">
                  This link was open until {longDate(req.expires_at)} and has expired. Reply to the
                  message it came in and ask for a new one — your payment is not affected.
                </p>
              </div>
            )}
          </div>
        </div>

        <ul className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          {[
            "We never ask for your PIN, password or a one-time code",
            "Nobody from us will ask you to pay money to receive money",
            "This link is yours alone — please do not forward it",
          ].map((t) => (
            <li key={t} className="flex items-start gap-1.5">
              <ShieldCheck className="mt-px size-3.5 flex-shrink-0 text-[var(--brand)]" />
              <span className="text-pretty">{t}</span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
