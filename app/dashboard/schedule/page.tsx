import Link from "next/link";
import { redirect } from "next/navigation";
import { Download, ShieldAlert, Inbox, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import ScheduleFilters from "./ScheduleFilters";

export const dynamic = "force-dynamic";

/**
 * The tenancy / lease schedule.
 *
 * This is `public/MANAGEMENT PORTFOLIO.xlsx` as a live report. That workbook is
 * how this portfolio is actually kept: one sheet per location, a header block
 * naming the LANDLORD and the PROPERTY ADDRESS, then a table of tenancies —
 * tenant, phone, term, rent p.a., service charge, amount paid, size/shop no.,
 * management fee at a rate that varies per property, and a free-text REMARK.
 *
 * Every one of those columns already existed in this database. What did not
 * exist was anything that assembled them, which is the whole reason the
 * spreadsheet survived alongside the product. `tenancy_schedule` (0254) does the
 * assembling; this page groups, filters, prints and exports it.
 *
 * ⚠️ The money columns are DERIVED, never typed here. A "rent received" box on
 * this screen would be a second place for a figure the ledger already owns, and
 * the two would disagree the first time somebody corrected one of them. What is
 * editable is what the workbook actually edits by hand and the database has no
 * other source for — the remark, and the tenancy record itself, both of which
 * open on the tenancy's own page.
 */

const GROUPS = {
  property: { label: "By property", column: "property_name" as const, empty: "Unfiled property" },
  owner: { label: "By landlord", column: "owner_name" as const, empty: "No landlord on record" },
  tenant: { label: "By tenant", column: "tenant_name" as const, empty: "Unassigned" },
} as const;
type GroupKey = keyof typeof GROUPS;

const SORTS = {
  newest: { label: "Newest first", column: "recorded_at", ascending: false },
  oldest: { label: "Oldest first", column: "recorded_at", ascending: true },
  expiry: { label: "Soonest to expire", column: "end_date", ascending: true },
  property: { label: "Property", column: "property_name", ascending: true },
  tenant: { label: "Tenant", column: "tenant_name", ascending: true },
  owner: { label: "Landlord", column: "owner_name", ascending: true },
} as const;
type SortKey = keyof typeof SORTS;

type Row = {
  lease_id: string;
  property_name: string | null;
  property_address: string | null;
  owner_name: string | null;
  unit_label: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  rent_amount: number | null;
  rent_frequency: string | null;
  rent_billed: number | null;
  rent_collected: number | null;
  rent_outstanding: number | null;
  management_fee_pct: number | null;
  management_fees: number | null;
  landlord_net: number | null;
  service_charge_billed: number | null;
  service_charge_collected: number | null;
  remark: string | null;
  recorded_at: string | null;
};

const money = (n: number | null) =>
  n == null
    ? "—"
    : `₦${Number(n).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortDate = (d: string | null) =>
  d
    ? new Date(d).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })
    : "—";

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");
  const profile = session.profile;

  const sp = await searchParams;
  const group: GroupKey = sp.group && sp.group in GROUPS ? (sp.group as GroupKey) : "property";
  const sort: SortKey = sp.sort && sp.sort in SORTS ? (sp.sort as SortKey) : "newest";
  const q = (sp.q ?? "").trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : "";
  const status = sp.status ?? "";

  const supabase = await createClient();

  // Asked of the database rather than inferred from the role — the same rule
  // the tenancy form follows, so this screen agrees with what a write would
  // actually permit.
  const [{ data: canWrite }, { data: canExport }, { data: hasLettings }] = await Promise.all([
    supabase.rpc("has_permission", { p_capability: "leases.write" }),
    supabase.rpc("has_permission", { p_capability: "records.export" }),
    supabase.rpc("org_has_module", { p_org_id: profile.org_id, p_module: "lettings" }),
  ]);

  if (!hasLettings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Tenancy schedule" />
        <EmptyState
          icon={<ShieldAlert />}
          title="Lettings is not enabled here"
          description="Tenancies, rent and landlord schedules belong to the property side of the group."
        />
      </div>
    );
  }

  let query = supabase
    .from("tenancy_schedule")
    .select(
      "lease_id, property_name, property_address, owner_name, unit_label, tenant_name, tenant_phone, status, start_date, end_date, rent_amount, rent_frequency, rent_billed, rent_collected, rent_outstanding, management_fee_pct, management_fees, landlord_net, service_charge_billed, service_charge_collected, remark, recorded_at"
    );

  if (status) query = query.eq("status", status);
  if (from) query = query.gte("start_date", from);
  if (to) query = query.lte("start_date", to);
  if (sp.owner) query = query.eq("owner_name", sp.owner);
  if (sp.property) query = query.eq("property_name", sp.property);
  if (sp.tenant) query = query.eq("tenant_name", sp.tenant);
  // Searched in the database rather than over the fetched page, so a search
  // finds a tenancy that is not on screen — the fault the approvals queue had.
  if (q) {
    const like = `%${q}%`;
    query = query.or(
      `property_name.ilike.${like},owner_name.ilike.${like},tenant_name.ilike.${like},unit_label.ilike.${like},property_address.ilike.${like}`
    );
  }

  const s = SORTS[sort];
  const { data, error } = await query
    .order(s.column, { ascending: s.ascending, nullsFirst: false })
    .limit(1000);

  const rows = (data ?? []) as Row[];

  // Grouped in one pass, in the order the query returned — so the chosen sort
  // decides the order WITHIN each group and the group headings follow first
  // appearance, rather than a second sort quietly overriding the first.
  const grouped = new Map<string, Row[]>();
  for (const r of rows) {
    const key = (r[GROUPS[group].column] as string | null) ?? GROUPS[group].empty;
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }

  const totals = rows.reduce(
    (acc, r) => ({
      billed: acc.billed + Number(r.rent_billed ?? 0),
      collected: acc.collected + Number(r.rent_collected ?? 0),
      outstanding: acc.outstanding + Number(r.rent_outstanding ?? 0),
      fees: acc.fees + Number(r.management_fees ?? 0),
      sc: acc.sc + Number(r.service_charge_billed ?? 0),
    }),
    { billed: 0, collected: 0, outstanding: 0, fees: 0, sc: 0 }
  );

  const exportParams = new URLSearchParams({ type: "schedule" });
  for (const [k, v] of Object.entries({ owner: sp.owner, property: sp.property, tenant: sp.tenant, status, from, to })) {
    if (v) exportParams.set(k, v);
  }

  return (
    <div className="space-y-6">
      {/* The masthead a printed schedule needs. A statement nobody can put on
          paper is not a statement, and this is the page a landlord, a client or
          an auditor is handed. */}
      <div className="hidden print:block">
        <h1 className="text-xl font-semibold">{session.org?.name ?? "Tenancy schedule"}</h1>
        <p className="text-sm">
          Tenancy schedule · {GROUPS[group].label.toLowerCase()} · generated{" "}
          {new Date().toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>

      <div className="print:hidden">
        <PageHeader
          title="Tenancy schedule"
          description="Every tenancy in the portfolio — landlord, unit, term, rent, service charge and management fee — drawn live from the record rather than kept by hand."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {canWrite && (
          <Button asChild size="sm" variant="brand">
            <Link href="/dashboard/leases/new">
              <Plus className="size-4" /> Record a tenancy
            </Link>
          </Button>
        )}
        <Button asChild size="sm" variant="outline">
          <Link href="/dashboard/properties/new">
            <Plus className="size-4" /> Add a property
          </Link>
        </Button>
        {canExport ? (
          <Button asChild size="sm" variant="outline">
            <a href={`/api/records/export?${exportParams}`} download>
              <Download className="size-4" /> Download this view (CSV)
            </a>
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            Bulk download is turned off for this organisation. Your OE Group
            contact can enable it under Settings → Permissions.
          </span>
        )}
      </div>

      <ScheduleFilters
        group={group}
        sort={sort}
        q={q}
        from={from}
        to={to}
        status={status}
        groups={Object.entries(GROUPS).map(([k, v]) => ({ key: k, label: v.label }))}
        sorts={Object.entries(SORTS).map(([k, v]) => ({ key: k, label: v.label }))}
        pinned={{ owner: sp.owner ?? "", property: sp.property ?? "", tenant: sp.tenant ?? "" }}
      />

      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            That schedule could not be read: {error.message}
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="No tenancies match"
          description={
            q || from || to || status || sp.owner || sp.property || sp.tenant
              ? "Nothing matches those filters. Clear them to see the whole portfolio."
              : "Record a tenancy and it appears here, with its landlord, rent and fee."
          }
        />
      ) : (
        <>
          <Card className="print:border-0 print:shadow-none">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {rows.length} tenanc{rows.length === 1 ? "y" : "ies"} ·{" "}
                    {grouped.size} {group === "owner" ? "landlord" : group}
                    {grouped.size === 1 ? "" : "s"}
                  </CardTitle>
                  <CardDescription>
                    Rent and service charge are shown side by side and never
                    added: rent is collected for the landlord and remitted net of
                    fees, service charge into the fund the building spends.
                  </CardDescription>
                </div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  Rent billed {money(totals.billed)} · received{" "}
                  {money(totals.collected)} · outstanding{" "}
                  {money(totals.outstanding)} · fees {money(totals.fees)} ·
                  service charge {money(totals.sc)}
                </div>
              </div>
            </CardHeader>
          </Card>

          {Array.from(grouped.entries()).map(([heading, list]) => {
            const sub = list.reduce(
              (a, r) => ({
                billed: a.billed + Number(r.rent_billed ?? 0),
                collected: a.collected + Number(r.rent_collected ?? 0),
                fees: a.fees + Number(r.management_fees ?? 0),
              }),
              { billed: 0, collected: 0, fees: 0 }
            );
            // The workbook's own header block: the landlord, the address and
            // the description sit above the tenant table, not in it.
            const address = list.find((r) => r.property_address)?.property_address;
            const landlord = list.find((r) => r.owner_name)?.owner_name;

            return (
              <Card key={heading} className="break-inside-avoid print:border print:shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{heading}</CardTitle>
                  <CardDescription className="space-y-0.5">
                    {group !== "owner" && landlord && <div>Landlord: {landlord}</div>}
                    {group !== "tenant" && address && <div>{address}</div>}
                    <div className="tabular-nums">
                      {list.length} tenanc{list.length === 1 ? "y" : "ies"} · billed{" "}
                      {money(sub.billed)} · received {money(sub.collected)} · fees{" "}
                      {money(sub.fees)}
                    </div>
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>S/N</TableHead>
                        {group !== "tenant" && <TableHead>Tenant</TableHead>}
                        <TableHead>Phone</TableHead>
                        {group !== "property" && <TableHead>Property</TableHead>}
                        <TableHead>Unit</TableHead>
                        <TableHead>Tenancy period</TableHead>
                        <TableHead className="text-right">Rent</TableHead>
                        <TableHead className="text-right">Service charge</TableHead>
                        <TableHead className="text-right">Received</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                        <TableHead className="text-right">Mgt fee</TableHead>
                        <TableHead>Remark</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {list.map((r, i) => (
                        <TableRow key={r.lease_id}>
                          <TableCell className="tabular-nums text-muted-foreground">{i + 1}</TableCell>
                          {group !== "tenant" && (
                            <TableCell className="font-medium">
                              {/* Opens the tenancy's own statement — the drawer
                                  card 0225/0226 built. Editing lives there, not
                                  in this grid. */}
                              <Link
                                href={`/dashboard/leases/${r.lease_id}`}
                                className="hover:underline"
                              >
                                {r.tenant_name ?? "Unassigned"}
                              </Link>
                            </TableCell>
                          )}
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {r.tenant_phone ?? "—"}
                          </TableCell>
                          {group !== "property" && (
                            <TableCell>{r.property_name ?? "—"}</TableCell>
                          )}
                          <TableCell>{r.unit_label ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            {shortDate(r.start_date)} – {shortDate(r.end_date)}
                            {r.status && r.status !== "active" && (
                              <Badge variant="outline" className="ml-1.5 text-[10px]">
                                {r.status}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(r.rent_amount)}
                            {r.rent_frequency && r.rent_frequency !== "annual" && (
                              <span className="block text-[10px] text-muted-foreground">
                                {r.rent_frequency}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(r.service_charge_billed)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(r.rent_collected)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(r.rent_outstanding)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(r.management_fees)}
                            {r.management_fee_pct != null && (
                              <span className="block text-[10px] text-muted-foreground">
                                @ {Number(r.management_fee_pct)}%
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[16rem] text-muted-foreground">
                            {r.remark ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
