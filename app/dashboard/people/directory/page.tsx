import Link from "next/link";
import { redirect } from "next/navigation";
import { Download, Building2, Home, Users, Wrench } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { portfolioLabel, roleLabel } from "@/lib/roles";
import { cn } from "@/lib/utils";
import {
  DIRECTORY_GROUPS,
  NON_STAFF_ROLES,
  isLiveTenancy,
  parseDirectoryGroup,
  type DirectoryGroup,
} from "@/lib/people-directory";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import DirectoryList, { type DirectoryRow } from "./DirectoryList";

// People → Directory. Asked for directly (11 Sept 2026): "a navigable
// staff / landlord / tenant / vendor list … that can be clicked on to reveal /
// view all information / profile about the role, not just downloadable."
//
// 📌 The four rosters existed only as CSVs (`/api/records/export`), and the
// capability behind those — `records.export` — is a DPA control that is OFF
// by default (0239). So for most of the people who reach this section, the
// only list of the organisation's tenants and landlords was a download they
// were not allowed to make. This is the same data on screen, where it never
// leaves the platform, and every row opens.
//
// ⚠️ It widens nothing. Every query below runs as the CALLER, so the rows are
// exactly what `users_select`, `tenancy_schedule`'s audience predicate,
// `property_stakeholders_select` and `vendors_select` already release to them —
// the same sources the Members tab, the tenancy schedule and the vendor list
// already render. The page decides what to SHOW; the database decides what
// exists to be shown.

const ICON: Record<DirectoryGroup, typeof Users> = {
  staff: Users,
  tenants: Home,
  landlords: Building2,
  vendors: Wrench,
};

type UserRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  deactivated_at: string | null;
  approval_tier: number | null;
};

type ScheduleRow = {
  lease_id: string;
  tenant_user_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  tenant_email: string | null;
  property_name: string | null;
  unit_label: string | null;
  status: string | null;
  start_date: string | null;
};

function contactLine(email?: string | null, phone?: string | null): string | undefined {
  const parts = [email, phone].filter((v): v is string => Boolean(v && v.trim()));
  return parts.length ? parts.join(" · ") : undefined;
}

function listSummary(items: string[], max = 2): string | undefined {
  const unique = Array.from(new Set(items.filter(Boolean)));
  if (unique.length === 0) return undefined;
  const shown = unique.slice(0, max).join(", ");
  return unique.length > max ? `${shown} +${unique.length - max} more` : shown;
}

export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) redirect("/login");
  const { profile, org } = session;
  const brand = org.delivery_brand ?? null;
  const group = parseDirectoryGroup((await searchParams).group);

  const supabase = await createClient();

  // Same gate the Members tab applies to its download card, so the button here
  // and the one there cannot disagree about who may take the file away.
  const isOperator = profile.role === "admin" && Boolean(org.is_platform_operator);
  const { data: canExport } =
    ["admin", "finance_approver", "payment_approver", "executive",
     "property_manager", "regional_manager"].includes(profile.role)
      ? await supabase.rpc("has_permission", { p_capability: "records.export" })
      : { data: false };
  const exportType = DIRECTORY_GROUPS.find((g) => g.key === group)!.exportType;
  // The staff roster FILE is the administrator's alone (board, 5 Sept 2026 —
  // see the export route). The on-screen list is not: Members has always shown
  // it to everyone who reaches People.
  const mayDownload =
    (isOperator || Boolean(canExport)) &&
    (group !== "staff" || isOperator || profile.role === "admin");

  let rows: DirectoryRow[] = [];
  let noun = "people";
  let description = "";
  let emptyHint: React.ReactNode = "Nobody here yet.";

  if (group === "staff") {
    noun = "staff";
    const [{ data: users }, { data: assignments }] = await Promise.all([
      supabase
        .from("users")
        .select("id, full_name, email, phone, role, deactivated_at, approval_tier")
        .not("role", "in", `(${NON_STAFF_ROLES.join(",")})`)
        .order("full_name"),
      supabase
        .from("stakeholder_assignments")
        .select("user_id, role, node_id, scope_label"),
    ]);

    // Places each person holds. A regional manager's NODE goes in the role
    // bracket (decision 43 — and only node rows, for the reason recorded on the
    // Members page); every place anyone holds goes on the detail line.
    const regionsByUser = new Map<string, string[]>();
    const placesByUser = new Map<string, string[]>();
    for (const a of assignments ?? []) {
      if (!a.scope_label) continue;
      if (a.role === "regional_manager" && a.node_id) {
        regionsByUser.set(a.user_id, [...(regionsByUser.get(a.user_id) ?? []), a.scope_label]);
      }
      placesByUser.set(a.user_id, [...(placesByUser.get(a.user_id) ?? []), a.scope_label]);
    }

    rows = ((users ?? []) as UserRow[]).map((u) => {
      const places = listSummary(placesByUser.get(u.id) ?? []);
      return {
        key: u.id,
        href: `/dashboard/people/${u.id}`,
        name: u.full_name || u.email || "Unnamed member",
        contact: contactLine(u.email, u.phone),
        detail: places ? `Holds: ${places}` : undefined,
        tags: [
          { label: portfolioLabel(u.role, brand, regionsByUser.get(u.id)) },
          ...(u.role === "payment_approver" && u.approval_tier
            ? [{ label: `Tier ${u.approval_tier}`, variant: "muted" as const }]
            : []),
          ...(u.deactivated_at ? [{ label: "Deactivated", variant: "muted" as const }] : []),
        ],
        inactive: Boolean(u.deactivated_at),
      };
    });
    description = "Everyone who works in this organisation, and the places each of them holds.";
  } else if (group === "tenants") {
    noun = "tenants";
    const [{ data: users }, { data: schedule }] = await Promise.all([
      supabase
        .from("users")
        .select("id, full_name, email, phone, role, deactivated_at, approval_tier")
        .eq("role", "tenant")
        .order("full_name"),
      supabase
        .from("tenancy_schedule")
        .select("lease_id, tenant_user_id, tenant_name, tenant_phone, tenant_email, property_name, unit_label, status, start_date"),
    ]);
    const tenancies = (schedule ?? []) as ScheduleRow[];

    const homesByUser = new Map<string, ScheduleRow[]>();
    for (const t of tenancies) {
      if (!t.tenant_user_id) continue;
      homesByUser.set(t.tenant_user_id, [...(homesByUser.get(t.tenant_user_id) ?? []), t]);
    }
    const place = (t: ScheduleRow) => [t.property_name, t.unit_label].filter(Boolean).join(" · ");

    const withAccounts: DirectoryRow[] = ((users ?? []) as UserRow[]).map((u) => {
      const mine = homesByUser.get(u.id) ?? [];
      const live = mine.filter((t) => isLiveTenancy(t.status));
      const homes = listSummary(live.map(place));
      return {
        key: u.id,
        href: `/dashboard/people/${u.id}`,
        name: u.full_name || u.email || "Unnamed tenant",
        contact: contactLine(u.email, u.phone),
        detail: homes
          ? `Lives in: ${homes}`
          : mine.length
            ? `${mine.length} past tenanc${mine.length === 1 ? "y" : "ies"}, none current`
            : undefined,
        tags: [
          ...(live.length > 1 ? [{ label: `${live.length} tenancies`, variant: "info" as const }] : []),
          ...(u.deactivated_at ? [{ label: "Deactivated", variant: "muted" as const }] : []),
        ],
        inactive: Boolean(u.deactivated_at),
      };
    });

    // ⚠️ The tenant OF RECORD with no portal account (decision 37) — a company
    // let, and every row of an imported rent roll. Leaving them out would make
    // this list disagree with the tenancy schedule about who lives where, which
    // is the one question it exists to answer. They have no profile to open,
    // because there is no person row behind them; their tenancy page IS their
    // record, and that is where the row goes.
    const ofRecord = new Map<string, ScheduleRow[]>();
    for (const t of tenancies) {
      if (t.tenant_user_id || !t.tenant_name) continue;
      const k = `${t.tenant_name.trim().toLowerCase()}|${(t.tenant_phone ?? "").replace(/\D/g, "")}`;
      ofRecord.set(k, [...(ofRecord.get(k) ?? []), t]);
    }
    const withoutAccounts: DirectoryRow[] = Array.from(ofRecord.entries()).map(([k, list]) => {
      const ordered = [...list].sort((a, b) => {
        const liveDiff = Number(isLiveTenancy(b.status)) - Number(isLiveTenancy(a.status));
        return liveDiff || (b.start_date ?? "").localeCompare(a.start_date ?? "");
      });
      const live = ordered.filter((t) => isLiveTenancy(t.status));
      const homes = listSummary((live.length ? live : ordered).map(place));
      return {
        key: `record:${k}`,
        href: `/dashboard/leases/${ordered[0].lease_id}`,
        name: ordered[0].tenant_name!,
        contact: contactLine(ordered[0].tenant_email, ordered[0].tenant_phone),
        detail: homes ? `${live.length ? "Lives in" : "Was in"}: ${homes}` : undefined,
        tags: [
          { label: "No portal account", variant: "muted" as const },
          ...(list.length > 1 ? [{ label: `${list.length} tenancies`, variant: "info" as const }] : []),
        ],
      };
    });

    // ⚠️ And a tenancy that names NOBODY — no portal account and no tenant of
    // record. Measured on staging the day this was built: four live OEA
    // tenancies in exactly that state, created before decision 37 gave a lease
    // somewhere to hold a name. Grouping them by name (above) silently drops
    // them, so the one list whose purpose is "who lives where" would have had
    // four occupied homes missing from it with nothing to say so. They are
    // listed, flagged, and open on the tenancy — where the name can be added.
    const unnamed: DirectoryRow[] = tenancies
      .filter((t) => !t.tenant_user_id && !t.tenant_name && isLiveTenancy(t.status))
      .map((t) => ({
        key: `unnamed:${t.lease_id}`,
        href: `/dashboard/leases/${t.lease_id}`,
        name: `No tenant recorded — ${place(t) || "tenancy"}`,
        detail: "A live tenancy with no portal account and no tenant name. Open it to record who the tenant is.",
        tags: [{ label: "Tenant not named", variant: "warning" as const }],
      }));

    rows = [
      ...[...withAccounts, ...withoutAccounts].sort((a, b) => a.name.localeCompare(b.name)),
      ...unnamed,
    ];
    description =
      "Every tenant — with a portal account or recorded on a tenancy without one. " +
      "A tenant with no account opens on their tenancy, which is their record.";
    emptyHint = "No tenants yet — they appear here when invited, or when a tenancy is recorded for them.";
  } else if (group === "landlords") {
    noun = "landlords";
    const [{ data: users }, { data: stakes }] = await Promise.all([
      supabase
        .from("users")
        .select("id, full_name, email, phone, role, deactivated_at, approval_tier")
        .eq("role", "property_owner")
        .order("full_name"),
      supabase
        .from("property_stakeholders")
        .select("user_id, properties(name)")
        .eq("relation", "owner"),
    ]);
    const owned = new Map<string, string[]>();
    for (const s of (stakes ?? []) as unknown as { user_id: string; properties: { name: string } | null }[]) {
      // A property outside this viewer's remit embeds as null (properties_select),
      // so it is simply not named — never counted, never hinted at.
      if (!s.properties?.name) continue;
      owned.set(s.user_id, [...(owned.get(s.user_id) ?? []), s.properties.name]);
    }
    rows = ((users ?? []) as UserRow[]).map((u) => {
      const props = owned.get(u.id) ?? [];
      return {
        key: u.id,
        href: `/dashboard/people/${u.id}`,
        name: u.full_name || u.email || "Unnamed owner",
        contact: contactLine(u.email, u.phone),
        detail: props.length ? `Owns: ${listSummary(props, 3)}` : undefined,
        tags: [
          ...(props.length ? [{ label: `${props.length} propert${props.length === 1 ? "y" : "ies"}` }] : []),
          ...(u.deactivated_at ? [{ label: "Deactivated", variant: "muted" as const }] : []),
        ],
        inactive: Boolean(u.deactivated_at),
      };
    });
    description = "Property owners and the buildings they own that you can see.";
    emptyHint = "No landlords yet — invite one as a Property owner and attach them to their building.";
  } else {
    noun = "vendors";
    const [{ data: vendors }, { data: links }, { data: loose }] = await Promise.all([
      supabase
        .from("vendors")
        .select("id, name, service_category, contact_email, contact_phone, status, approval_status, kyc_tier")
        .order("name"),
      supabase.from("vendor_users").select("vendor_id, user_id"),
      supabase
        .from("users")
        .select("id, full_name, email, phone, role, deactivated_at, approval_tier")
        .eq("role", "vendor")
        .order("full_name"),
    ]);
    const peopleByVendor = new Map<string, number>();
    const linkedUsers = new Set<string>();
    for (const l of links ?? []) {
      peopleByVendor.set(l.vendor_id, (peopleByVendor.get(l.vendor_id) ?? 0) + 1);
      linkedUsers.add(l.user_id);
    }
    const companies: DirectoryRow[] = (vendors ?? []).map((v) => {
      const n = peopleByVendor.get(v.id) ?? 0;
      return {
        key: v.id,
        href: `/dashboard/vendors/${v.id}`,
        name: v.name,
        contact: contactLine(v.contact_email, v.contact_phone),
        detail: [
          v.service_category ? String(v.service_category).replace(/_/g, " ") : null,
          n ? `${n} ${n === 1 ? "person" : "people"} with a login` : "no portal login yet",
        ].filter(Boolean).join(" · "),
        tags: [
          ...(v.approval_status && v.approval_status !== "approved"
            ? [{
                label: v.approval_status === "pending" ? "Awaiting approval" : String(v.approval_status),
                variant: v.approval_status === "pending" ? ("warning" as const) : ("destructive" as const),
              }]
            : []),
          ...(v.kyc_tier ? [{ label: `${v.kyc_tier} KYC`, variant: "muted" as const }] : []),
          ...(v.status && v.status !== "active"
            ? [{ label: String(v.status).replace(/_/g, " "), variant: "muted" as const }]
            : []),
        ],
        // Filed under "Show deactivated" rather than hidden outright: a
        // suspended contractor is exactly the one somebody comes looking for.
        inactive:
          (Boolean(v.status) && v.status !== "active") ||
          v.approval_status === "suspended" || v.approval_status === "rejected",
      };
    });
    // A vendor login that belongs to no company — rare (an invitation accepted
    // before its company link was written), and exactly the row nobody would
    // otherwise find, so it is listed rather than dropped.
    const orphans: DirectoryRow[] = ((loose ?? []) as UserRow[])
      .filter((u) => !linkedUsers.has(u.id))
      .map((u) => ({
        key: u.id,
        href: `/dashboard/people/${u.id}`,
        name: u.full_name || u.email || "Unnamed vendor login",
        contact: contactLine(u.email, u.phone),
        detail: "Vendor login not linked to a company",
        tags: [{ label: "No company", variant: "warning" as const }],
        inactive: Boolean(u.deactivated_at),
      }));
    rows = [...companies, ...orphans];
    description =
      "Contractor companies. Open one for its registration, scorecard, jobs and the people who log in for it.";
    emptyHint = "No vendors yet — they appear here once invited or registered.";
  }

  const label = DIRECTORY_GROUPS.find((g) => g.key === group)!.label;

  return (
    <div className="printable space-y-4">
      <PrintMasthead
        org={org.name}
        title={`Directory — ${label}`}
        by={profile.full_name || profile.email || undefined}
      />

      {/* Groups are links, not client tabs: each is an address somebody can
          bookmark or be sent, and the back button returns to the group they
          were in rather than to Staff. */}
      <nav aria-label="Directory groups" data-print="screen-only" className="flex flex-wrap gap-2">
        {DIRECTORY_GROUPS.map((g) => {
          const Icon = ICON[g.key];
          const active = g.key === group;
          return (
            <Link
              key={g.key}
              href={`/dashboard/people/directory?group=${g.key}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="size-4" />
              {g.label}
            </Link>
          );
        })}
      </nav>

      <Card>
        <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">{label}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex flex-shrink-0 gap-2" data-print="screen-only">
            <PrintButton />
            {mayDownload && (
              <Button asChild variant="outline" size="sm">
                <a href={`/api/records/export?type=${exportType}`} download>
                  <Download className="size-4" /> CSV
                </a>
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <DirectoryList rows={rows} noun={noun} emptyHint={emptyHint} />
        </CardContent>
      </Card>

      {group !== "staff" && group !== "vendors" && (
        <p className="text-xs text-muted-foreground" data-print="screen-only">
          {roleLabel(profile.role, brand)}: you see the {noun} this organisation
          records, and on each profile only the tenancies, buildings, requests and
          payments your own role already reaches.
        </p>
      )}
    </div>
  );
}
