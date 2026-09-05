import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Users, ArrowRight, ShieldAlert, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/patterns/empty-state";
import { getBrandTheme } from "@/lib/brands";
import DomainField from "./DomainField";
import CreateOrgForm from "./CreateOrgForm";

// The OE Group operator launcher: every organisation on the platform as a card,
// each opening that organisation's own address.
//
// ⚠️ This lives BEHIND the sign-in, not in front of it. B1 is explicit that a
// user on one portal must never see another brand's data *or existence*, and a
// public grid of every org publishes the client list — both brands, the
// service-charge client, and every landlord org onboarded later — to anyone who
// loads the page. `operator_org_directory()` gates the list on
// `caller_is_operator_admin()` inside the query, so a brand administrator gets
// an empty set rather than a refusal; a refusal would itself confirm there is
// something worth refusing.
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  name: string;
  portal_name: string | null;
  slug: string | null;
  custom_domain: string | null;
  logo_url: string | null;
  theme_primary: string | null;
  theme_logo_text: string | null;
  delivery_brand: string;
  is_platform_operator: boolean;
  retired: boolean;
  member_count: number;
  property_count: number;
};

export default async function OrgLauncherPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data } = await supabase.rpc("operator_org_directory");
  const orgs = (data ?? []) as Row[];

  // An empty set is what a non-operator gets — and since /login now routes
  // everyone here first, that is the ordinary path for a tenant user who used
  // the platform door instead of their own. Send them where they were going
  // rather than explaining a page that is not for them.
  //
  // This reveals nothing: they learn they are not an operator, which they knew.
  // It says nothing about whether any other organisation exists.
  if (orgs.length === 0 && session.profile) {
    redirect("/dashboard");
  }

  if (orgs.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-16">
        <EmptyState
          icon={<ShieldAlert />}
          title="This page is for OE Group operators"
          description="Your account belongs to one organisation, and this is where OE Group's own staff move between all of them. Your portal is where you already were."
          action={
            <Button asChild variant="brand" size="sm">
              <Link href="/dashboard">Back to your dashboard</Link>
            </Button>
          }
        />
      </main>
    );
  }

  const live = orgs.filter((o) => !o.retired);
  const retired = orgs.filter((o) => o.retired);

  return (
    <main className="bg-brand-wash min-h-dvh">
      <div className="mx-auto max-w-5xl px-5 py-12 sm:py-16">
        <div className="animate-fade mb-10 space-y-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--brand)] text-sm font-bold text-[var(--brand-fg)] shadow-sm">
              OE
            </span>
            <span className="font-semibold tracking-tight">OE Group</span>
          </div>
          <h1 className="display-lg text-balance">
            Which organisation are you working in?
          </h1>
          <p className="max-w-2xl text-pretty text-muted-foreground">
            Every organisation OE Group administers. Opening one takes you to its
            own address, with its own branding and its own people — the data stays
            separated exactly as it is inside the product.
          </p>
        </div>

        <div className="mb-10 max-w-2xl">
          <CreateOrgForm />
        </div>

        <ul className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {live.map((o) => (
            <OrgCard key={o.id} org={o} />
          ))}
        </ul>

        {retired.length > 0 && (
          // Folded away by default. A retired organisation is something an
          // operator occasionally needs to find, not something that should
          // compete with the live ones for attention every time this page
          // loads — and the count is visible without expanding it.
          <details className="group mt-14">
            <summary className="eyebrow mb-3 inline-flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
              Retired · {retired.length}
            </summary>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {retired.map((o) => (
                <OrgCard key={o.id} org={o} />
              ))}
            </ul>
          </details>
        )}
      </div>
    </main>
  );
}

function OrgCard({ org }: { org: Row }) {
  // ⚠️ Was hardcoded to TFML's own navy for ANY org with no theme_primary set
  // — so an unbranded OEA, or an unbranded new "direct" client, showed up in
  // the operator's own directory wearing another org's colour. The operator's
  // own row is the one deliberate exception: `/login`'s door has always been
  // navy, by its own explicit choice, not by falling through this path — kept
  // identical here rather than silently recoloured to the "direct" house
  // theme meant for OTHER direct-delivered clients.
  const theme = getBrandTheme(org.delivery_brand, {
    name: org.name,
    theme_primary: org.theme_primary,
    theme_logo_text: org.theme_logo_text,
  });
  const primary = org.is_platform_operator ? "#003366" : theme.primary;
  const label = org.portal_name || org.name;
  const href = org.slug ? `/o/${org.slug}` : "/login";

  const card = (
    <div
      className={[
        "group relative flex h-full flex-col gap-3.5 overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-sm)] transition-all duration-200",
        org.retired ? "opacity-60" : "hover:-translate-y-1 hover:shadow-[var(--shadow-lg)]",
      ].join(" ")}
    >
      <span
        className="absolute inset-x-0 top-0 h-1 transition-opacity"
        style={{ background: primary, opacity: org.retired ? 0.3 : 1 }}
        aria-hidden
      />
      {/* A wash of the org's own colour, surfacing on hover — the card previews
          the brand you are about to enter. */}
      {!org.retired && (
        <span
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          style={{ background: `color-mix(in srgb, ${primary} 5%, transparent)` }}
          aria-hidden
        />
      )}

      <div className="relative flex items-start justify-between gap-3">
        {org.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logo_url} alt="" className="h-12 w-12 rounded-xl object-contain" />
        ) : (
          <span
            className="flex h-12 w-12 items-center justify-center rounded-xl text-base font-bold text-white shadow-sm transition-transform duration-200 group-hover:scale-105"
            style={{ background: primary }}
          >
            {/* ⚠️ Was `label.slice(0, 2)`, which spelled "TO" out of "Total
                Facilities Management Limited" — while that same org's own
                door at /o/tfml showed "TF" from its brand theme. One
                organisation, two different monograms depending on which
                page you were looking at. Resolved through the same
                getBrandTheme() both pages now share. */}
            {theme.logoText ?? label.slice(0, 2).toUpperCase()}
          </span>
        )}
        {org.is_platform_operator ? (
          <Badge variant="brand">Operator</Badge>
        ) : org.retired ? (
          <Badge variant="outline">Retired</Badge>
        ) : (
          <Badge variant="outline">{org.delivery_brand}</Badge>
        )}
      </div>

      <div className="relative min-w-0 flex-1 space-y-0.5">
        <p className="truncate font-medium tracking-tight">{label}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {org.slug ? `/o/${org.slug}` : "No address set"}
        </p>
        {!org.retired && <DomainField orgId={org.id} domain={org.custom_domain} />}
      </div>

      <div className="relative flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Users className="size-3.5" />
          {org.member_count} {org.member_count === 1 ? "person" : "people"}
        </span>
        <span className="flex items-center gap-1.5">
          <Building2 className="size-3.5" />
          {org.property_count}
        </span>
        {!org.retired && (
          <ArrowRight className="ml-auto size-4 transition-transform group-hover:translate-x-0.5" />
        )}
      </div>
    </div>
  );

  if (org.retired) return <li>{card}</li>;

  return (
    <li>
      <Link href={href} className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
        {card}
      </Link>
    </li>
  );
}
