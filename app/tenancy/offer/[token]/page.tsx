import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ShieldCheck, CalendarClock, CheckCircle2, XCircle, Clock } from "lucide-react";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getBrandTheme } from "@/lib/brands";
import { formatNaira } from "@/lib/currency";
import { hashOfferToken } from "@/lib/tenancy-offer-token";
import {
  offerDate,
  payableOnAcceptance,
  termLabel,
  termLines,
  type OfferTerms,
} from "@/lib/tenancy-offer";
import OfferDecision from "./OfferDecision";

// The letter of offer, as the applicant sees it (0263).
//
// Unauthenticated by design and by necessity: the person reading this has no
// account, and creating one is what ACCEPTING produces. The token in the URL is
// the whole authority — only its SHA-256 is stored, so nobody reading the
// database can accept somebody else's tenancy.
//
// Read with the service role because there is no session to read with, and
// through `tenancy_offer_by_token`, which returns at most one row and cannot be
// made to list.

export const dynamic = "force-dynamic";

/** `noindex`, for the same reason the application form is: this link is handed
 *  to one person and an indexed copy is an open door — to somebody's name,
 *  their flat and what they are paying for it. */
export const metadata: Metadata = {
  title: "Offer of tenancy",
  robots: { index: false, follow: false },
};

type OfferRow = {
  offer_id: string;
  state: "issued" | "accepted" | "declined" | "withdrawn" | "lapsed";
  org_id: string;
  org_name: string;
  portal_name: string | null;
  logo_url: string | null;
  theme_primary: string | null;
  delivery_brand: string;
  applicant_name: string;
  applicant_email: string;
  property_name: string | null;
  property_address: string | null;
  unit_label: string | null;
  rent_amount: string;
  service_charge_amount: string;
  deposit_amount: string;
  other_charges_amount: string;
  other_charges_label: string | null;
  term_months: number;
  commences_on: string;
  expires_on: string;
  conditions: string | null;
  issued_at: string;
  responded_at: string | null;
};

export default async function OfferPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const { data } = await supabaseAdmin.rpc("tenancy_offer_by_token", {
    p_token_hash: hashOfferToken(decodeURIComponent(token ?? "")),
  });
  const offer = (Array.isArray(data) ? data[0] : data) as OfferRow | undefined;

  // A wrong token, a withdrawn offer and a token that never existed all answer
  // the same 404 — the alternative tells a stranger which of the three it was.
  if (!offer || offer.state === "withdrawn") notFound();

  const brandName = offer.portal_name || offer.org_name;
  const brand = getBrandTheme(offer.delivery_brand, {
    theme_primary: offer.theme_primary,
  }).primary;

  const terms: OfferTerms = {
    rentAmount: Number(offer.rent_amount),
    serviceChargeAmount: Number(offer.service_charge_amount),
    depositAmount: Number(offer.deposit_amount),
    otherChargesAmount: Number(offer.other_charges_amount),
    otherChargesLabel: offer.other_charges_label,
    termMonths: offer.term_months,
    commencesOn: offer.commences_on,
    expiresOn: offer.expires_on,
    conditions: offer.conditions,
  };

  return (
    <Shell brandName={brandName} brand={brand} logo={offer.logo_url}>
      <div className="space-y-6">
        <div className="space-y-1">
          <p className="eyebrow text-[var(--brand)]">{brandName}</p>
          <h1 className="text-xl font-semibold tracking-tight">Offer of tenancy</h1>
          <p className="text-sm text-muted-foreground">
            Prepared for {offer.applicant_name} on {offerDate(offer.issued_at)}.
          </p>
        </div>

        {/* ── What is being offered ─────────────────────────────────────── */}
        <dl className="space-y-2 rounded-xl border border-border bg-muted/30 p-4 text-sm">
          <Row label="Property">
            {offer.property_name ?? "—"}
            {offer.property_address ? (
              <span className="block text-xs text-muted-foreground">
                {offer.property_address}
              </span>
            ) : null}
          </Row>
          <Row label="Unit">{offer.unit_label ?? "—"}</Row>
          <Row label="Term">
            {termLabel(terms.termMonths)}, commencing {offerDate(terms.commencesOn)}
          </Row>
        </dl>

        {/* ── The money ─────────────────────────────────────────────────────
            ⚠️ Rent and service charge are listed separately and never added
            into one "rent" figure (decision 25) — they are different money
            going to different places. The one total below answers a different
            question: what has to be transferred to take the unit. */}
        <dl className="space-y-2 rounded-xl border border-border p-4 text-sm">
          {termLines(terms).map((l) => (
            <Row key={l.label} label={l.label}>
              {l.value}
            </Row>
          ))}
          <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-border pt-3">
            <dt className="font-medium">Payable to accept</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {formatNaira(payableOnAcceptance(terms))}
            </dd>
          </div>
        </dl>

        <p className="text-xs text-muted-foreground">
          Rent and service charge are payable annually in advance. The service
          charge is not rent — it goes into the fund that runs the building and is
          accounted for separately.
        </p>

        {terms.conditions ? (
          <div className="rounded-xl border border-border p-4 text-sm">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Conditions of this offer
            </p>
            <p className="whitespace-pre-wrap text-pretty">{terms.conditions}</p>
          </div>
        ) : null}

        {/* ── What happens now ──────────────────────────────────────────── */}
        {offer.state === "issued" ? (
          <>
            <div className="flex items-start gap-2 rounded-xl border border-[var(--brand)]/30 bg-[var(--brand)]/5 p-4 text-sm">
              <CalendarClock className="mt-0.5 size-4 flex-shrink-0 text-[var(--brand)]" />
              <p className="text-pretty">
                This offer is open until{" "}
                <span className="font-medium">{offerDate(terms.expiresOn)}</span>. It
                is an offer of terms and does not create a tenancy — no tenancy
                exists until you accept and the amount above is received in
                cleared funds.
              </p>
            </div>

            <OfferDecision token={token} brandName={brandName} />
          </>
        ) : (
          <Answered state={offer.state} respondedAt={offer.responded_at} expiresOn={terms.expiresOn} />
        )}

        {/* ⚠️ Stated on the page, not only in the email. Advance-fee fraud
            against prospective tenants is ordinary in this market, and the
            defence is a person who knows the real figures and expects them in
            writing. This page IS the writing. */}
        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Pay only to {brandName}&rsquo;s own account, and only after accepting
          here. If anything above does not match what you were told, reply to the
          email this link came from <span className="font-medium">before paying anything</span>.
        </p>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function Answered({
  state,
  respondedAt,
  expiresOn,
}: {
  state: "accepted" | "declined" | "lapsed";
  respondedAt: string | null;
  expiresOn: string;
}) {
  const look = {
    accepted: {
      icon: <CheckCircle2 className="mt-0.5 size-4 flex-shrink-0 text-success" />,
      title: "You accepted this offer",
      body: `Accepted on ${offerDate(respondedAt)}. We emailed you a link to set up your tenant account — check your inbox, including the spam folder. The tenancy agreement follows for signature.`,
      cls: "border-success/40 bg-success/5",
    },
    declined: {
      icon: <XCircle className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground" />,
      title: "You declined this offer",
      body: `Declined on ${offerDate(respondedAt)}. Nothing further is owed. If this was a mistake, reply to the email this link came from and we will look at it.`,
      cls: "border-border bg-muted/30",
    },
    lapsed: {
      icon: <Clock className="mt-0.5 size-4 flex-shrink-0 text-warning" />,
      title: "This offer has lapsed",
      body: `It was open until ${offerDate(expiresOn)} and was not accepted, so it can no longer be taken up. If you are still interested, reply to the email this link came from and ask whether the unit is still available.`,
      cls: "border-warning/40 bg-warning/5",
    },
  }[state];

  return (
    <div className={`flex items-start gap-2 rounded-xl border p-4 text-sm ${look.cls}`}>
      {look.icon}
      <div>
        <p className="font-medium">{look.title}</p>
        <p className="text-pretty text-muted-foreground">{look.body}</p>
      </div>
    </div>
  );
}

/** The same public shell the application form uses, so one applicant does not
 *  meet two different-looking front doors from the same organisation. */
function Shell({
  brandName,
  brand,
  logo,
  children,
}: {
  brandName: string;
  brand: string;
  logo: string | null;
  children: React.ReactNode;
}) {
  return (
    <main
      className="bg-brand-wash min-h-dvh bg-background px-4 py-8 sm:py-12"
      style={{ ["--brand" as string]: brand, ["--brand-fg" as string]: "#ffffff" }}
    >
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <header className="animate-fade flex items-center gap-3">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className="h-9 w-auto max-w-[140px] object-contain" />
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

        <div className="animate-rise rounded-2xl border border-border/80 bg-card p-5 shadow-[var(--shadow-md)] sm:p-7">
          {children}
        </div>

        <ul className="stagger grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          {[
            "A tenancy starts when you accept, not before",
            "Nothing is payable until you have accepted",
            "This link is yours alone — do not forward it",
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
