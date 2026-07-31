import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Users, ArrowRight, ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/patterns/empty-state";

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

  // An empty set is what a non-operator gets. Said plainly rather than shown as
  // an empty grid, which would read as "the platform has no organisations".
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
    <main className="mx-auto max-w-5xl px-5 py-12 sm:py-16">
      <div className="mb-10 space-y-2">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--brand)] text-sm font-bold text-[var(--brand-fg)]">
            OE
          </span>
          <span className="font-semibold">OE Group</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Which organisation are you working in?
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every organisation OE Group administers. Opening one takes you to its
          own address, with its own branding and its own people — the data stays
          separated exactly as it is inside the product.
        </p>
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {live.map((o) => (
          <OrgCard key={o.id} org={o} />
        ))}
      </ul>

      {retired.length > 0 && (
        <div className="mt-12">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Retired ({retired.length})
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {retired.map((o) => (
              <OrgCard key={o.id} org={o} />
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

function OrgCard({ org }: { org: Row }) {
  const primary = /^#[0-9a-fA-F]{6}$/.test(org.theme_primary ?? "")
    ? org.theme_primary!
    : "#003366";
  const label = org.portal_name || org.name;
  const href = org.slug ? `/o/${org.slug}` : "/login";

  const card = (
    <div
      className={[
        "group relative flex h-full flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card p-5 transition-all",
        org.retired ? "opacity-60" : "hover:-translate-y-0.5 hover:border-transparent hover:shadow-lg",
      ].join(" ")}
    >
      <span
        className="absolute inset-x-0 top-0 h-1 transition-opacity"
        style={{ background: primary, opacity: org.retired ? 0.3 : 1 }}
        aria-hidden
      />

      <div className="flex items-start justify-between gap-3">
        {org.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logo_url} alt="" className="h-12 w-12 rounded-lg object-contain" />
        ) : (
          <span
            className="flex h-12 w-12 items-center justify-center rounded-lg text-base font-bold text-white"
            style={{ background: primary }}
          >
            {org.theme_logo_text || label.slice(0, 2).toUpperCase()}
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

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{label}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {org.slug ? `/o/${org.slug}` : "No address set"}
        </p>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
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
