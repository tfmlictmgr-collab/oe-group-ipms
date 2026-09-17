import Link from "next/link";
import { redirect } from "next/navigation";
import { Download, Building2, Home, Users, Wrench } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { portfolioLabel } from "@/lib/roles";
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
import RoleGate from "../../RoleGate";
import RecordDownloads from "../RecordDownloads";
import MemberActions from "../members/MemberActions";
import DirectoryList, { type DirectoryRow } from "./DirectoryList";

// People → Directory: every person and company the organisation deals with,
// each row opening a whole profile (decision 46).
//
// 📌 12 Sept 2026 — the Members list is folded in here, and both are the
// ADMINISTRATOR's alone. Asked for directly: "Member and Directory seems to be a
// duplicity of tools … only platform and org admins should have access to it."
// Every Members feature lives on: the search, the deactivated toggle and its
// count, the released-address display, the approval-tier picker, the password
// reset, deactivate and restore, freeing an address, the roster downloads, and
// the regional manager's region in brackets. Every account the old list held
// is still reachable here, including the logins a contractor company holds,
// which get their own rows so none of them can only be found by knowing where
// to look.
//
// ⚠️ The facilities, property and regional managers keep People for what they
// actually do there — inviting, vendor applications, occupancy, tenancy
// applications — and lose only this. The lists other screens show them (who is
// attached to a property, a tenancy's tenant, a vendor's people) are untouched:
// only the link from those names into a profile is gone, because a profile is
// this section's and they would follow it into a refusal.
//
// Every query runs as the caller, so the rows are what RLS already releases to
// an administrator — who reads their whole organisation and nobody else's.

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
  former_email: string | null;
  email_released_at: string | null;
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

const USER_COLUMNS =
  "id, full_name, email, phone, role, deactivated_at, approval_tier, former_email, email_released_at";

function contactLine(email?: string | null, phone?: string | null): string | undefined {
  const parts = [email, phone].filter((v): v is string => Boolean(v && v.trim()));
  return parts.length ? parts.join(" · ") : undefined;
}

/** Once released, "released+<uuid>@invalid" tells a reader nothing — show who
 *  they were, and say the address is gone (0199). */
function userContact(u: UserRow): string | undefined {
  if (u.email_released_at) {
    return [`${u.former_email ?? "address"} — address released`, u.phone].filter(Boolean).join(" · ");
  }
  return contactLine(u.email, u.phone);
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

  // The administrator's alone — an organisation's own, and the platform
  // operator's own for theirs. Everyone else in People is told so plainly.
  if (profile.role !== "admin") return <RoleGate title="Directory" />;

  const brand = org.delivery_brand ?? null;
  const group = parseDirectoryGroup((await searchParams).group);
  const supabase = await createClient();

  const isOperator = Boolean(org.is_platform_operator);
  const { data: canExport } = await supabase.rpc("has_permission", { p_capability: "records.export" });
  const mayDownload = isOperator || Boolean(canExport);
  const exportType = DIRECTORY_GROUPS.find((g) => g.key === group)!.exportType;

  const manage = (u: UserRow) => (
    <MemberActions
      member={{
        id: u.id,
        full_name: u.full_name,
        email: u.email,
        role: u.role,
        deactivated_at: u.deactivated_at,
        email_released_at: u.email_released_at,
        approval_tier: u.approval_tier,
      }}
      currentUserId={profile.id}
    />
  );

  let rows: DirectoryRow[] = [];
  let noun = "people";
  let description = "";
  let emptyHint: React.ReactNode = "Nobody here yet.";

  if (group === "staff") {
    noun = "staff";
    const [{ data: users }, { data: assignments }] = await Promise.all([
      supabase
        .from("users")
        .select(USER_COLUMNS)
        .not("role", "in", `(${NON_STAFF_ROLES.join(",")})`)
        .order("full_name"),
      supabase
        .from("stakeholder_assignments")
        .select("user_id, role, node_id, scope_label"),
    ]);

    // Places each person holds. A regional manager's NODE goes in the role
    // bracket (decision 43 — node rows only: a property attaché row would put a
    // building's name where their region belongs); every place anyone holds
    // goes on the detail line.
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
        contact: userContact(u),
        detail: places ? `Holds: ${places}` : undefined,
        tags: [
          { label: portfolioLabel(u.role, brand, regionsByUser.get(u.id)) },
          ...(u.deactivated_at ? [{ label: "Deactivated", variant: "muted" as const }] : []),
        ],
        inactive: Boolean(u.deactivated_at),
        you: u.id === profile.id,
        actions: manage(u),
      };
    });
    description = "Everyone who works in this organisation, the places each of them holds, and their accounts.";
  } else if (group === "tenants") {
    noun = "tenants";
    const [{ data: users }, { data: schedule }] = await Promise.all([
      supabase.from("users").select(USER_COLUMNS).eq("role", "tenant").order("full_name"),
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
        contact: userContact(u),
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
        actions: manage(u),
      };
    });

    // ⚠️ The tenant OF RECORD with no portal account (decision 37) — a company
    // let, and every row of an imported rent roll. Leaving them out would make
    // this list disagree with the tenancy schedule about who lives where. They
    // have no account to manage and no profile to open; their tenancy page IS
    // their record, and that is where the row goes.
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

    // A live tenancy that names nobody at all — listed, flagged, and opened on
    // the tenancy, where the name can be added (decision 46).
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
      supabase.from("users").select(USER_COLUMNS).eq("role", "property_owner").order("full_name"),
      supabase
        .from("property_stakeholders")
        .select("user_id, properties(name)")
        .eq("relation", "owner"),
    ]);
    const owned = new Map<string, string[]>();
    for (const s of (stakes ?? []) as unknown as { user_id: string; properties: { name: string } | null }[]) {
      if (!s.properties?.name) continue;
      owned.set(s.user_id, [...(owned.get(s.user_id) ?? []), s.properties.name]);
    }
    rows = ((users ?? []) as UserRow[]).map((u) => {
      const props = owned.get(u.id) ?? [];
      return {
        key: u.id,
        href: `/dashboard/people/${u.id}`,
        name: u.full_name || u.email || "Unnamed owner",
        contact: userContact(u),
        detail: props.length ? `Owns: ${listSummary(props, 3)}` : undefined,
        tags: [
          ...(props.length ? [{ label: `${props.length} propert${props.length === 1 ? "y" : "ies"}` }] : []),
          ...(u.deactivated_at ? [{ label: "Deactivated", variant: "muted" as const }] : []),
        ],
        inactive: Boolean(u.deactivated_at),
        actions: manage(u),
      };
    });
    description = "Property owners, the buildings they own, and their accounts.";
    emptyHint = "No landlords yet — invite one as a Property owner and attach them to their building.";
  } else {
    noun = "vendors";
    const [{ data: vendors }, { data: links }, { data: logins }] = await Promise.all([
      supabase
        .from("vendors")
        .select("id, name, service_category, contact_email, contact_phone, status, approval_status, kyc_tier")
        .order("name"),
      supabase.from("vendor_users").select("vendor_id, user_id, vendors:vendor_id(name)"),
      supabase.from("users").select(USER_COLUMNS).eq("role", "vendor").order("full_name"),
    ]);
    const peopleByVendor = new Map<string, number>();
    const companiesByUser = new Map<string, string[]>();
    for (const l of (links ?? []) as unknown as { vendor_id: string; user_id: string; vendors: { name: string } | null }[]) {
      peopleByVendor.set(l.vendor_id, (peopleByVendor.get(l.vendor_id) ?? 0) + 1);
      if (l.vendors?.name) companiesByUser.set(l.user_id, [...(companiesByUser.get(l.user_id) ?? []), l.vendors.name]);
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
          { label: "Company", variant: "outline" as const },
          ...(v.approval_status && v.approval_status !== "approved"
            ? [{
                label: v.approval_status === "pending" ? "Awaiting approval" : String(v.approval_status),
                variant: v.approval_status === "pending" ? ("warning" as const) : ("destructive" as const),
              }]
            : []),
          ...(v.kyc_tier ? [{ label: `${v.kyc_tier} KYC`, variant: "muted" as const }] : []),
        ],
        // Filed under "Show deactivated" rather than hidden outright: a
        // suspended contractor is exactly the one somebody comes looking for.
        inactive:
          (Boolean(v.status) && v.status !== "active") ||
          v.approval_status === "suspended" || v.approval_status === "rejected",
      };
    });
    // The people who log in for a contractor — every one of them an account
    // the old Members list could deactivate, so every one is reachable here.
    const people: DirectoryRow[] = ((logins ?? []) as UserRow[]).map((u) => {
      const at = companiesByUser.get(u.id) ?? [];
      return {
        key: `login:${u.id}`,
        href: `/dashboard/people/${u.id}`,
        name: u.full_name || u.email || "Unnamed contractor login",
        contact: userContact(u),
        detail: at.length ? `Logs in for ${listSummary(at, 2)}` : "A contractor login not linked to any company",
        tags: [
          at.length ? { label: "Contractor login" } : { label: "No company", variant: "warning" as const },
          ...(u.deactivated_at ? [{ label: "Deactivated", variant: "muted" as const }] : []),
        ],
        inactive: Boolean(u.deactivated_at),
        actions: manage(u),
      };
    });
    rows = [...companies, ...people];
    description =
      "Contractor companies, and the people who log in for them. Open a company for its registration, scorecard, jobs and how it is paid.";
    emptyHint = "No vendors yet — they appear here once invited or registered.";
  }

  const label = DIRECTORY_GROUPS.find((g) => g.key === group)!.label;
  const accounts = rows.filter((r) => r.actions);
  const inactiveAccounts = accounts.filter((r) => r.inactive).length;

  return (
    <div className="printable space-y-4">
      <PrintMasthead
        org={org.name}
        title={`Directory — ${label}`}
        by={profile.full_name || profile.email || undefined}
      />

      {mayDownload && (
        <div data-print="screen-only">
          <RecordDownloads isAdmin />
        </div>
      )}

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
            <CardDescription>
              {description}
              {accounts.length > 0 && (
                <span className="mt-1 block">
                  {accounts.length - inactiveAccounts} active account{accounts.length - inactiveAccounts === 1 ? "" : "s"}
                  {inactiveAccounts > 0 ? ` · ${inactiveAccounts} deactivated` : ""}
                </span>
              )}
            </CardDescription>
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

      {/* ⚠️ Stating the whole path, not just the prohibition — carried over
          from the old Members list word for word in substance. "Never deleted"
          alone reads as a missing feature; the product can remove somebody, in
          two deliberate steps, and what survives is the RECORD, not the access. */}
      <p className="text-xs text-muted-foreground" data-print="screen-only">
        To remove somebody completely: Manage → <strong>Deactivate</strong> closes the account, then{" "}
        <strong>Free up their email address</strong> bans the sign-in and frees the address to be
        invited again. Their name stays on what they did — a decision nobody can be traced to is not
        a decision.
      </p>
    </div>
  );
}
