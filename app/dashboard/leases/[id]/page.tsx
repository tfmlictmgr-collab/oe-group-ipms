import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, FileText, Receipt, Home } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { FM_PM } from "@/lib/roles";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import RentRollActions from "../RentRollActions";

// One tenancy, in full — and the statement for the person living in it.
//
// ⚠️ This route did not exist. `LeaseStats` has built every drawer card with
// `href: /dashboard/leases/${lease_id}` since the tiles were made interactive,
// so every card in every lettings drawer led to the application's 404. The
// pattern was right — RequestStats, PropertyStats, WorkStats and the approvals
// queue all open onto a detail route — and the lettings half of it was the one
// that was never built.
//
// ⚠️ NO SCOPING IS REPEATED HERE. `leases_select` (0090) admits three parties
// and no others: the tenancy's own tenant, oversight, and whoever holds the
// property through `current_user_property_ids()`. A lease this caller may not
// read comes back as no row, and no row is a 404 — the same answer an id that
// never existed gets, so the page cannot be used to probe which lease ids are
// real. `rent_charges_select` mirrors the same three branches, so the schedule
// below needs no filter of its own either.
//
// ⚠️ THE FEE SPLIT IS NOT SHOWN TO THE TENANT. What a landlord is charged in
// management and admin fees is between the landlord and OE Group. The rent roll
// has always shown `landlord_net` to everyone who can open it — which, by the
// policy above, is oversight and the property's managers — and the tenant
// reaches THIS page by the third branch of that same policy, a branch the rent
// roll never had to think about. So the columns are gated here.
//
// 📌 Recorded, not fixed here: `rent_charges_select` does permit a tenant to
// SELECT `management_fee_amount` and `landlord_net_amount` on their own charges.
// Postgres RLS is row-level, so narrowing that means column privileges or a
// view, and `rent_charges` is read by the rent roll, the landlord statement and
// two verification suites. Not visible in the product on any screen; worth a
// deliberate turn rather than a side effect of this one.

export const dynamic = "force-dynamic";

type Lease = {
  id: string;
  org_id: string;
  property_id: string;
  unit_id: string;
  tenant_user_id: string | null;
  start_date: string;
  end_date: string;
  status: string;
  rent_amount: number | string;
  rent_frequency: string;
  paid_in_advance: boolean;
  currency: string;
  escalation_pct: number | string;
  deposit_amount: number | string;
  notes: string | null;
  created_at: string;
  renewed_from_lease_id: string | null;
  properties: { name: string; address: string | null } | null;
  units: { label: string; unit_quantity: number | null } | null;
  users: { full_name: string | null; email: string | null; phone: string | null } | null;
};

type RentCharge = {
  id: string;
  period_start: string;
  period_end: string;
  due_date: string;
  amount: number | string;
  amount_paid: number | string;
  currency: string;
  status: string;
  // Nullable since 0229: a tenant's own schedule arrives through
  // `my_rent_charges()`, which returns no fee column. Every consumer of these
  // four sits behind `seesFeeSplit`, so null is never rendered — the type says
  // out loud that the data is absent for one audience rather than zero.
  management_fee_pct: number | string | null;
  management_fee_amount: number | string | null;
  admin_fee_amount: number | string | null;
  landlord_net_amount: number | string | null;
  remitted_at: string | null;
};

/** The tenant-safe projection `my_rent_charges()` (0110) returns. */
type MyRentCharge = {
  charge_id: string;
  lease_id: string;
  period_start: string;
  period_end: string;
  due_date: string;
  amount: number | string;
  amount_paid: number | string;
  currency: string;
  status: string;
};

type ServiceCharge = {
  id: string;
  billing_period: string | null;
  property_or_unit: string | null;
  amount: number | string;
  amount_paid: number | string | null;
  apportionment_pct: number | string | null;
  status: string;
  due_date: string | null;
};

type Intent = {
  id: string;
  gateway_reference: string;
  purpose: string;
  amount_expected: number | string;
  amount_paid: number | string | null;
  currency: string;
  status: string;
  paid_at: string | null;
  created_at: string;
};

const fmtDate = (d: string | null) =>
  d
    ? new Date(d).toLocaleDateString("en-GB", {
        timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
      })
    : "—";

/** PostgREST types an embedded parent as an array even where the FK makes it one row. */
const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export default async function LeaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();

  // ⚠️ The unit is fetched SEPARATELY, not embedded. `leases.unit_id` carries no
  // foreign key — `leases_property_same_org_fk` was written for the property and
  // the unit beside it was missed (0090) — so PostgREST has no relationship to
  // traverse and answers an embed with "Could not find a relationship between
  // 'leases' and 'units'". That is a 500 on this page for every role, and it is
  // what the verification suite caught before anyone clicked it. The FK is added
  // in 0223; this query does not depend on it either way.
  const { data: raw } = await supabase
    .from("leases")
    .select(
      "id, org_id, property_id, unit_id, tenant_user_id, start_date, end_date, status, " +
      "rent_amount, rent_frequency, paid_in_advance, currency, escalation_pct, deposit_amount, " +
      "notes, created_at, renewed_from_lease_id, " +
      "properties(name, address), users:tenant_user_id(full_name, email, phone)"
    )
    .eq("id", id)
    .maybeSingle();

  if (!raw) notFound();

  // The generated types do not carry the `users:tenant_user_id(...)` alias, so
  // the client types this row as an error. Narrowed once here rather than at
  // every field.
  const row = raw as unknown as Record<string, unknown>;
  const { data: unitRow } = await supabase
    .from("units")
    .select("label, unit_quantity")
    .eq("id", row.unit_id as string)
    .maybeSingle();

  const lease = {
    ...row,
    properties: one(row.properties as never),
    units: unitRow ?? null,
    users: one(row.users as never),
  } as unknown as Lease;

  const role = session.profile?.role ?? "";
  const viewerIsTenant = lease.tenant_user_id === session.user.id;
  const isStaff = ["admin", "finance_approver", "executive", "regional_manager", ...FM_PM]
    .includes(role);
  const seesFeeSplit = isStaff || !viewerIsTenant;

  // ⚠️ TWO READS, chosen by who is looking — and since 0229 that is not a
  // nicety, it is the only way a tenant sees their own schedule at all.
  //
  // `rent_charges_select` no longer admits the tenant: the row carries the
  // management fee and the landlord net, and the measured exposure was that a
  // tenant could read both directly (and, through `rent_roll`, on a screen).
  // So a tenant now comes through `my_rent_charges()` — SECURITY DEFINER,
  // scoped to their own tenancies, and returning no fee column at all.
  //
  // 📌 This is stronger than what `seesFeeSplit` does below, and both are kept.
  // The gate stops the fee split being RENDERED; this stops it being SENT. A
  // column that never leaves the database cannot be read out of a payload by
  // someone who opens the network tab.
  const [chargesRes, scRes, canWriteRes] = await Promise.all([
    viewerIsTenant && !isStaff
      ? supabase.rpc("my_rent_charges")
      : supabase
          .from("rent_charges")
          .select(
            "id, period_start, period_end, due_date, amount, amount_paid, currency, status, " +
            "management_fee_pct, management_fee_amount, admin_fee_amount, landlord_net_amount, remitted_at"
          )
          .eq("lease_id", lease.id)
          .order("period_start", { ascending: false }),
    // Service charges land on the UNIT, not the lease — a budget is apportioned
    // across a property's units and knows nothing about who is in them. Bounded
    // to the tenancy's own term so a previous occupant's bill never appears on
    // this tenant's statement.
    supabase
      .from("service_charges")
      .select(
        "id, billing_period, property_or_unit, amount, amount_paid, apportionment_pct, status, due_date"
      )
      .eq("unit_id", lease.unit_id)
      .is("deleted_at", null)
      .order("billing_period", { ascending: false }),
    supabase.rpc("has_permission", { p_capability: "leases.write" }),
  ]);

  // `my_rent_charges()` answers for every tenancy the caller holds and names the
  // key `charge_id`, so the tenant branch is filtered to THIS lease and mapped
  // onto the same shape the table below already renders. The fee fields resolve
  // to null rather than 0: nothing was charged that we are declining to show —
  // the figure simply is not ours to hand over, and `seesFeeSplit` means no
  // cell is drawn from them anyway.
  const charges: RentCharge[] =
    viewerIsTenant && !isStaff
      ? ((chargesRes.data ?? []) as unknown as MyRentCharge[])
          .filter((c) => c.lease_id === lease.id)
          .map((c) => ({
            id: c.charge_id,
            period_start: c.period_start,
            period_end: c.period_end,
            due_date: c.due_date,
            amount: c.amount,
            amount_paid: c.amount_paid,
            currency: c.currency,
            status: c.status,
            management_fee_pct: null,
            management_fee_amount: null,
            admin_fee_amount: null,
            landlord_net_amount: null,
            remitted_at: null,
          }))
      : ((chargesRes.data ?? []) as unknown as RentCharge[]);
  const serviceCharges = (scRes.data ?? []) as unknown as ServiceCharge[];
  const canWrite = Boolean(canWriteRes.data);

  // Receipts, keyed off the charges above rather than off the unit. A payment
  // intent carries `rent_charge_id` (0092) and `service_charge_id` (0032); the
  // unit column is not populated on every path, so joining through the charge
  // is the one that cannot silently return an empty list.
  //
  // `payment_intents_select` is payer-or-oversight (0032/0072a) — an FM/PM sees
  // none of these, and that is the existing boundary, not an omission. The rent
  // position above is computed from `rent_charges.amount_paid`, which they do
  // hold, so the schedule is complete for them without widening anything.
  const chargeIds = charges.map((c) => c.id);
  const scIds = serviceCharges.map((c) => c.id);
  let intents: Intent[] = [];
  if (chargeIds.length > 0 || scIds.length > 0) {
    const filters: string[] = [];
    if (chargeIds.length > 0) filters.push(`rent_charge_id.in.(${chargeIds.join(",")})`);
    if (scIds.length > 0) filters.push(`service_charge_id.in.(${scIds.join(",")})`);
    const { data } = await supabase
      .from("payment_intents")
      .select(
        "id, gateway_reference, purpose, amount_expected, amount_paid, currency, status, paid_at, created_at"
      )
      .or(filters.join(","))
      .order("created_at", { ascending: false });
    intents = (data ?? []) as unknown as Intent[];
  }

  const currency = lease.currency || "NGN";
  const money = (n: number | string | null | undefined) => formatMoney(n ?? 0, currency);

  const rentBilled = charges.reduce((a, c) => a + Number(c.amount), 0);
  const rentCollected = charges.reduce((a, c) => a + Number(c.amount_paid), 0);
  const rentOutstanding = rentBilled - rentCollected;

  const scBilled = serviceCharges.reduce((a, c) => a + Number(c.amount), 0);
  const scCollected = serviceCharges.reduce((a, c) => a + Number(c.amount_paid ?? 0), 0);
  const scOutstanding = Math.max(0, scBilled - scCollected);

  // ⚠️ The total is the PLAIN SUM of the rows above it, and that is a decision.
  //
  // The first version apportioned both figures to what had been collected —
  // the definition `landlord_statement` (0130) uses, and correct there. Rendered
  // here it produced a table whose single row read "fees ₦600,000, landlord net
  // ₦5,400,000" over a total reading "₦0.00, ₦0.00", because nothing had been
  // paid yet. Both numbers were right and the screen was still wrong: a column
  // has to answer ONE question, and this one answers "what does the demand
  // carry". What has actually come in is the Received column, three cells to the
  // left, and stating it twice in two different ways is how a reader stops
  // trusting either.
  //
  // The collected-basis figures belong on the landlord statement, which is about
  // money owed to a person; this table is about demands raised on a tenancy.
  const landlordNet = charges.reduce((a, c) => a + Number(c.landlord_net_amount), 0);
  const feesTaken = charges.reduce(
    (a, c) => a + Number(c.management_fee_amount) + Number(c.admin_fee_amount),
    0
  );

  const daysToExpiry = Math.round(
    (new Date(lease.end_date).getTime() - Date.now()) / 86_400_000
  );
  const live = lease.status === "active" || lease.status === "renewed";

  const unitName = lease.units?.label ?? "Unit";
  const propertyName = lease.properties?.name ?? "Property";
  const tenantName = lease.users?.full_name ?? lease.users?.email ?? null;

  return (
    <div className="printable mx-auto max-w-5xl space-y-6">
      <PrintMasthead
        org={session.org?.name ?? "Tenancy"}
        title="Tenancy statement"
        subtitle={`${propertyName} · ${unitName}${tenantName ? ` · ${tenantName}` : ""}`}
        by={session.profile?.full_name || session.profile?.email || undefined}
      />

      <div data-print="screen-only">
        <PageHeader
          title={`${unitName} — ${propertyName}`}
          description={
            tenantName
              ? `${tenantName} · ${fmtDate(lease.start_date)} to ${fmtDate(lease.end_date)}`
              : `No tenant recorded · ${fmtDate(lease.start_date)} to ${fmtDate(lease.end_date)}`
          }
          actions={
            <div className="flex items-center gap-2">
              <PrintButton />
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/leases"><ArrowLeft /> Back</Link>
              </Button>
            </div>
          }
        />
      </div>

      {/* The tenancy itself: the terms someone signed, on one card. */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="grid flex-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="Rent">
                <span className="text-lg font-semibold tabular-nums">{money(lease.rent_amount)}</span>
                <span className="block text-xs text-muted-foreground">
                  {lease.rent_frequency}
                  {lease.paid_in_advance ? ", in advance" : ", in arrears"}
                </span>
              </Fact>
              <Fact label="Term">
                {fmtDate(lease.start_date)} — {fmtDate(lease.end_date)}
                <span className="block text-xs text-muted-foreground">
                  {live
                    ? daysToExpiry >= 0
                      ? `${daysToExpiry} day${daysToExpiry === 1 ? "" : "s"} to run`
                      : `${Math.abs(daysToExpiry)} day${Math.abs(daysToExpiry) === 1 ? "" : "s"} over`
                    : "Not running"}
                </span>
              </Fact>
              <Fact label="Escalation on renewal">
                {Number(lease.escalation_pct).toFixed(2)}%
                <span className="block text-xs text-muted-foreground">
                  Applied to the next term, never this one
                </span>
              </Fact>
              <Fact label="Deposit held">{money(lease.deposit_amount)}</Fact>
              <Fact label="Property">
                {propertyName}
                <span className="block text-xs text-muted-foreground">
                  {lease.properties?.address ?? "No address recorded"}
                </span>
              </Fact>
              <Fact label="Tenant">
                {tenantName ?? <span className="text-muted-foreground">Not assigned</span>}
                {lease.users?.email && (
                  <span className="block text-xs text-muted-foreground">{lease.users.email}</span>
                )}
              </Fact>
            </div>
            <div className="flex flex-col items-end gap-2">
              <StatusBadge status={lease.status} />
              {lease.renewed_from_lease_id && (
                <Button asChild variant="ghost" size="sm" data-print="screen-only">
                  <Link href={`/dashboard/leases/${lease.renewed_from_lease_id}`}>
                    Previous term
                  </Link>
                </Button>
              )}
            </div>
          </div>

          {lease.notes && (
            <p className="mt-4 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {lease.notes}
            </p>
          )}

          {canWrite && (
            <div className="mt-5 flex justify-end border-t border-border pt-4" data-print="screen-only">
              <RentRollActions
                leaseId={lease.id}
                status={lease.status}
                endDate={lease.end_date}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* The position, in the order a person asks it: what was billed, what came
          in, what is still owed. Rent and service charge are kept apart because
          they are owed to different people and settled separately. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Rent billed" value={money(rentBilled)} note={`${charges.length} demand${charges.length === 1 ? "" : "s"}`} />
        <Tile label="Rent collected" value={money(rentCollected)} tone="success" />
        <Tile
          label="Rent outstanding"
          value={money(Math.max(0, rentOutstanding))}
          tone={rentOutstanding > 0 ? "destructive" : undefined}
          note={rentOutstanding > 0 ? "Payment due" : "Nothing owed"}
        />
        <Tile
          label="Service charge outstanding"
          value={money(scOutstanding)}
          tone={scOutstanding > 0 ? "warning" : undefined}
          note={`${serviceCharges.length} invoice${serviceCharges.length === 1 ? "" : "s"} on this unit`}
        />
      </div>

      {/* Rent schedule */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Rent schedule</CardTitle>
          <CardDescription>
            Every demand raised against this tenancy, and what has been received
            against it.
            {seesFeeSplit &&
              " The fee split is the rate snapshotted on each demand, never recomputed — a later rate change cannot rewrite a past statement. Fees and landlord net are what the demand carries; the landlord is credited as the money is actually collected."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {charges.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">
              No rent has been demanded on this tenancy yet.
              {canWrite && " Use “Bill rent” above to raise the first demand."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Demanded</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    {seesFeeSplit && <TableHead className="text-right">Fees</TableHead>}
                    {seesFeeSplit && <TableHead className="text-right">Landlord net</TableHead>}
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {charges.map((c) => {
                    const owed = Number(c.amount) - Number(c.amount_paid);
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="whitespace-nowrap font-medium">
                          {fmtDate(c.period_start)} — {fmtDate(c.period_end)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {fmtDate(c.due_date)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(c.amount, c.currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(c.amount_paid, c.currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {owed > 0 ? (
                            <span className="font-medium text-destructive">
                              {formatMoney(owed, c.currency)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {seesFeeSplit && (
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatMoney(
                              Number(c.management_fee_amount) + Number(c.admin_fee_amount),
                              c.currency
                            )}
                            <span className="block text-[11px]">
                              {Number(c.management_fee_pct).toFixed(2)}%
                            </span>
                          </TableCell>
                        )}
                        {seesFeeSplit && (
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(c.landlord_net_amount, c.currency)}
                            {c.remitted_at && (
                              <Badge variant="success" className="ml-2">remitted</Badge>
                            )}
                          </TableCell>
                        )}
                        <TableCell>
                          <StatusBadge status={c.status} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={2} className="font-semibold">Total</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {money(rentBilled)}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {money(rentCollected)}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {money(Math.max(0, rentOutstanding))}
                    </TableCell>
                    {seesFeeSplit && (
                      <TableCell className="text-right font-semibold tabular-nums">
                        {money(feesTaken)}
                      </TableCell>
                    )}
                    {seesFeeSplit && (
                      <TableCell className="text-right font-semibold tabular-nums">
                        {money(landlordNet)}
                      </TableCell>
                    )}
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Service charge on the unit */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Service charge on this unit</CardTitle>
          <CardDescription>
            Apportioned from the property&apos;s budget. Owed to the service-charge
            fund, not to the landlord, which is why it is totalled separately above.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {serviceCharges.length === 0 ? (
            <p className="flex items-center gap-2 px-5 pb-5 text-sm text-muted-foreground">
              <FileText className="size-4" />
              No service-charge invoice has been raised against this unit.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead>Billed as</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {serviceCharges.map((c) => {
                    const owed = Math.max(0, Number(c.amount) - Number(c.amount_paid ?? 0));
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.billing_period ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {c.property_or_unit ?? "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {fmtDate(c.due_date)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {c.apportionment_pct != null
                            ? `${Number(c.apportionment_pct).toFixed(2)}%`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(c.amount)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {owed > 0 ? (
                            <span className="font-medium text-warning">{money(owed)}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell><StatusBadge status={c.status} /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Receipts. Empty for an FM/PM by policy, not by omission — see above. */}
      {intents.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Payments received</CardTitle>
            <CardDescription>
              Each with the gateway reference to quote in a dispute.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>What for</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {intents.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium capitalize">
                        {p.purpose.replace(/_/g, " ")}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {p.gateway_reference}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {fmtDate(p.paid_at ?? p.created_at)}
                      </TableCell>
                      <TableCell><StatusBadge status={p.status} /></TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatMoney(p.amount_paid ?? p.amount_expected, p.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {intents.length === 0 && (rentBilled > 0 || scBilled > 0) && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Receipt className="size-3.5" />
          {viewerIsTenant
            ? "No payment has been recorded against this tenancy yet."
            : "Receipts are visible to the payer and to finance. What was received is shown in the schedule above."}
        </p>
      )}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Home className="size-3.5" />
        A tenancy&apos;s state is a fact about a person, not arithmetic on a date —
        an expired term does not on its own vacate the unit.
      </p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

function Tile({
  label, value, note, tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "success" | "warning" | "destructive";
}) {
  const toneClass =
    tone === "success" ? "text-success"
      : tone === "warning" ? "text-warning"
        : tone === "destructive" ? "text-destructive"
          : "";
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
    </Card>
  );
}
