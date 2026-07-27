import { redirect } from "next/navigation";
import { Package, Building2, Building, Inbox, ShieldCheck, Gauge } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { PageHeader } from "@/components/patterns/page-header";
import { StatCard } from "@/components/patterns/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";

// The read-only observer's single destination.
//
// Everything here comes from what a viewer's own session can actually read
// (0038) — no service role, no elevated query. If a figure appears on this page
// it is because RLS permitted it, which means the page cannot accidentally
// widen what the role is allowed to see.
//
// Deliberately absent: money of any kind, staff and tenant contact details, the
// audit trail, and the free text of service requests.

const count = <T,>(rows: T[], key: (r: T) => string | null) => {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) ?? "unspecified";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
};

const title = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default async function OverviewPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();

  const [
    { data: org },
    { data: properties },
    { data: units },
    { data: assets },
    { data: vendors },
    { data: tickets },
    { data: evaluations },
  ] = await Promise.all([
    supabase.from("orgs").select("name, portal_name, delivery_brand").maybeSingle(),
    supabase.from("properties").select("id, name"),
    supabase.from("units").select("id, property_id"),
    supabase.from("assets").select("id, category, status, criticality, property_id"),
    supabase.from("vendor_overview").select("id, name, service_category, approval_status"),
    supabase.from("ticket_overview").select("id, status, category, urgency, is_assigned_to_vendor, is_assigned_to_staff, acknowledged_at"),
    supabase.from("vendor_evaluations").select("vendor_id, composite_score"),
  ]);

  const props = properties ?? [];
  const unitRows = units ?? [];
  const assetRows = assets ?? [];
  const vendorRows = vendors ?? [];
  const ticketRows = tickets ?? [];

  const brand = org?.delivery_brand ?? null;
  const orgName = org?.portal_name || org?.name || "the organisation";

  const resolved = ticketRows.filter((t) => ["resolved", "closed"].includes(t.status)).length;
  const assigned = ticketRows.filter((t) => t.is_assigned_to_vendor || t.is_assigned_to_staff).length;
  const acknowledged = ticketRows.filter((t) => t.acknowledged_at).length;

  // Average composite per vendor, then across vendors — the AURA weighting is
  // already applied when each evaluation is scored.
  const byVendor = new Map<string, number[]>();
  for (const e of evaluations ?? []) {
    const arr = byVendor.get(e.vendor_id) ?? [];
    arr.push(Number(e.composite_score));
    byVendor.set(e.vendor_id, arr);
  }
  const vendorAverages = Array.from(byVendor.entries()).map(([id, scores]) => ({
    id,
    avg: scores.reduce((a: number, b: number) => a + b, 0) / scores.length,
  }));
  const overallScore =
    vendorAverages.length > 0
      ? vendorAverages.reduce((s, v) => s + v.avg, 0) / vendorAverages.length
      : null;

  const unitsByProperty = new Map<string, number>();
  for (const u of unitRows) {
    unitsByProperty.set(u.property_id, (unitsByProperty.get(u.property_id) ?? 0) + 1);
  }
  const assetsByProperty = new Map<string, number>();
  for (const a of assetRows) {
    if (a.property_id) {
      assetsByProperty.set(a.property_id, (assetsByProperty.get(a.property_id) ?? 0) + 1);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Programme Overview"
        description={`A read-only view of ${orgName}. Financial records, personal contact details and the audit trail are not included.`}
      />

      <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/8 px-4 py-3 text-sm">
        <ShieldCheck className="mt-0.5 size-4 flex-shrink-0 text-info" />
        <p className="text-muted-foreground">
          You are signed in as{" "}
          <span className="font-medium text-foreground">{roleLabel("viewer", brand)}</span>.
          This is the whole of your access — it is enforced by the database, not
          by hiding menu items, so nothing else is reachable by URL either.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Properties" value={String(props.length)} icon={<Building />} />
        <StatCard label="Units" value={String(unitRows.length)} icon={<Building2 />} />
        <StatCard label="Assets on register" value={String(assetRows.length)} icon={<Package />} />
        <StatCard label="Vendors" value={String(vendorRows.length)} icon={<Gauge />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Service requests</CardTitle>
            <CardDescription>
              Volume and routing. What each request says is withheld — the text
              is written by residents and is personal to them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure label="Logged" value={ticketRows.length} icon={<Inbox className="size-4" />} />
              <Figure label="Dispatched" value={assigned} />
              <Figure label="Resolved" value={resolved} />
            </div>
            {ticketRows.length > 0 && (
              <>
                <Breakdown title="By category" rows={count(ticketRows, (t) => t.category)} />
                <Breakdown title="By urgency" rows={count(ticketRows, (t) => t.urgency)} />
                <p className="text-xs text-muted-foreground">
                  {acknowledged} of {assigned} dispatched job
                  {assigned === 1 ? " has" : "s have"} been acknowledged by the
                  assignee.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Asset register</CardTitle>
            <CardDescription>
              Plant and equipment recorded against properties, with condition and
              criticality.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {assetRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing registered yet.</p>
            ) : (
              <>
                <Breakdown title="By category" rows={count(assetRows, (a) => a.category)} />
                <Breakdown title="By status" rows={count(assetRows, (a) => a.status)} />
                <Breakdown title="By criticality" rows={count(assetRows, (a) => a.criticality)} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Portfolio</CardTitle>
          <CardDescription>Properties, their units, and assets registered against them.</CardDescription>
        </CardHeader>
        <CardContent>
          {props.length === 0 ? (
            <p className="text-sm text-muted-foreground">No properties yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Property</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Assets</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {props.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {unitsByProperty.get(p.id) ?? 0}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {assetsByProperty.get(p.id) ?? 0}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Vendors and performance</CardTitle>
          <CardDescription>
            Scored on the AURA weighting — quality 30%, response 20%, completion
            20%, satisfaction 20%, compliance 10%.
            {overallScore != null && (
              <> Portfolio average: <span className="font-medium text-foreground">{overallScore.toFixed(1)}</span>.</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {vendorRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No vendors onboarded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vendorRows.map((v) => {
                    const score = vendorAverages.find((a) => a.id === v.id)?.avg;
                    return (
                      <TableRow key={v.id}>
                        <TableCell className="font-medium">{v.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {v.service_category ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              v.approval_status === "approved"
                                ? "success"
                                : v.approval_status === "rejected"
                                  ? "destructive"
                                  : "warning"
                            }
                          >
                            {title(v.approval_status ?? "unknown")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {score != null ? score.toFixed(1) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({ label, value, icon }: { label: string; value: number; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon} {label}
      </p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Breakdown({ title: heading, rows }: { title: string; rows: [string, number][] }) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map(([, n]) => n));
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{heading}</p>
      {rows.map(([k, n]) => (
        <div key={k} className="flex items-center gap-2 text-sm">
          <span className="w-28 flex-shrink-0 truncate">{title(k)}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-[var(--brand)]"
              style={{ width: `${Math.round((n / max) * 100)}%` }}
            />
          </span>
          <span className="w-8 flex-shrink-0 text-right tabular-nums text-muted-foreground">{n}</span>
        </div>
      ))}
    </div>
  );
}
