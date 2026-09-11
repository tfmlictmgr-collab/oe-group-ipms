import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft, Mail, Phone, CalendarDays, Bell, ExternalLink, FileText,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { portfolioLabel, ROLE_HINTS } from "@/lib/roles";
import { formatMoney } from "@/lib/currency";
import { shortRef } from "@/lib/acknowledgement";
import { STATUS_LABEL as CLAIM_STATUS_LABEL, type ClaimStatus } from "@/lib/offline-payments";
import {
  directoryGroupOf,
  isLiveTenancy,
  isStaffRole,
  seesTenantMoney,
} from "@/lib/people-directory";
import { PageHeader } from "@/components/patterns/page-header";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

// One person, whole — the destination of every row in People → Directory.
//
// ⚠️ Nothing here is read with the service role, and nothing is widened. Each
// section is an ordinary query in the viewer's own session, so a facilities
// manager opening a tenant sees that tenant's tenancies on THEIR buildings and
// the requests THEY can open — never more than the tenancy schedule, the
// request list or the property page would already show them. Where a policy
// could return "nothing" for a reason other than "there is nothing", the
// section is not rendered at all, rather than rendered empty (decision 25:
// a zero that means "you may not see this" is indistinguishable from one that
// means "nothing was billed").

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GROUP_BACK: Record<string, string> = {
  staff: "Staff",
  tenants: "Tenants",
  landlords: "Landlords",
  vendors: "Vendors",
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
  });
}

function humanize(s: string | null | undefined): string {
  return (s ?? "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

type Tenancy = {
  lease_id: string;
  property_id: string | null;
  property_name: string | null;
  unit_label: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  rent_amount: number | string | null;
  rent_frequency: string | null;
  currency: string | null;
  rent_billed: number | string | null;
  rent_collected: number | string | null;
  rent_outstanding: number | string | null;
  service_charge_billed: number | string | null;
  service_charge_collected: number | string | null;
  service_charge_outstanding: number | string | null;
};

type TicketRow = {
  id: string;
  summary: string | null;
  message_text: string | null;
  status: string;
  created_at: string;
  properties: { name: string } | null;
};

export default async function PersonProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) redirect("/login");
  const { profile: viewer, org } = session;
  const brand = org.delivery_brand ?? null;

  const { id } = await params;
  // A sibling folder with no page of its own (`members/`) would otherwise land
  // here and reach Postgres as an invalid uuid — a 500 where a 404 is the truth.
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data: person } = await supabase
    .from("users")
    .select(
      "id, full_name, email, phone, role, created_at, deactivated_at, approval_tier, " +
      "former_email, email_released_at, notify_email, notify_whatsapp, notify_sms, " +
      "notify_telegram, telegram_chat_id"
    )
    .eq("id", id)
    .maybeSingle<{
      id: string; full_name: string | null; email: string | null; phone: string | null;
      role: string; created_at: string; deactivated_at: string | null;
      approval_tier: number | null; former_email: string | null;
      email_released_at: string | null; notify_email: boolean; notify_whatsapp: boolean;
      notify_sms: boolean; notify_telegram: boolean; telegram_chat_id: string | null;
    }>();

  // `users_select` decides. Somebody in another organisation, or a row this
  // viewer may not read, is simply not here — the same 404 an unknown id gets,
  // so the page cannot be used to test whether an account exists.
  if (!person) notFound();

  const group = directoryGroupOf(person.role);
  const isStaff = isStaffRole(person.role);
  const isTenant = person.role === "tenant";
  const isLandlord = person.role === "property_owner";
  const isVendor = person.role === "vendor";
  const money = seesTenantMoney(viewer.role);
  // `payment_intents_select`'s oversight branch — org-wide, unlike the PM/RM
  // place branch — so only these can read an empty list as "none at all".
  const orgWideMoney = ["admin", "finance_approver", "executive", "payment_approver"].includes(viewer.role);

  const [
    placesRes, tenanciesRes, ownedRes, ownerScheduleRes, vendorLinksRes,
    raisedRes, assignedRes, paymentsRes, claimsRes,
  ] = await Promise.all([
    isStaff
      ? supabase
          .from("stakeholder_assignments")
          .select("id, relation, property_id, node_id, scope_label, scope_level, property_count")
          .eq("user_id", id)
      : Promise.resolve({ data: null }),
    isTenant
      ? supabase
          .from("tenancy_schedule")
          .select(
            "lease_id, property_id, property_name, unit_label, status, start_date, end_date, " +
            "rent_amount, rent_frequency, currency, rent_billed, rent_collected, rent_outstanding, " +
            "service_charge_billed, service_charge_collected, service_charge_outstanding"
          )
          .eq("tenant_user_id", id)
          .order("start_date", { ascending: false })
      : Promise.resolve({ data: null }),
    isLandlord
      ? supabase
          .from("property_stakeholders")
          .select("property_id, created_at, properties(id, name, address, reference)")
          .eq("user_id", id)
          .eq("relation", "owner")
      : Promise.resolve({ data: null }),
    isLandlord
      ? supabase
          .from("tenancy_schedule")
          .select("property_id, status")
          .eq("owner_user_id", id)
      : Promise.resolve({ data: null }),
    isVendor
      ? supabase
          .from("vendor_users")
          .select("vendor_id, is_owner, capabilities, created_at, vendors(id, name, service_category, approval_status)")
          .eq("user_id", id)
      : Promise.resolve({ data: null }),
    supabase
      .from("tickets")
      .select("id, summary, message_text, status, created_at, properties(name)", { count: "exact" })
      .eq("sender_id", id)
      .order("created_at", { ascending: false })
      .limit(8),
    isStaff
      ? supabase
          .from("tickets")
          .select("id, summary, message_text, status, created_at, properties(name)", { count: "exact" })
          .eq("assigned_to_user_id", id)
          .order("created_at", { ascending: false })
          .limit(8)
      : Promise.resolve({ data: null, count: null }),
    isTenant && money
      ? supabase
          .from("payment_intents")
          .select("id, gateway_reference, purpose, currency, amount_expected, amount_paid, status, paid_at, created_at")
          .eq("payer_user_id", id)
          .neq("status", "abandoned")
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null }),
    isTenant
      ? supabase
          .from("offline_payment_claims")
          .select("id, reference, method, claimed_amount, currency, paid_on, status")
          .eq("payer_user_id", id)
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null }),
  ]);

  const name = person.full_name || person.email || "Unnamed";
  const roleName = portfolioLabel(
    person.role,
    brand,
    ((placesRes.data ?? []) as { node_id: string | null; scope_label: string | null }[])
      .filter((p) => person.role === "regional_manager" && p.node_id && p.scope_label)
      .map((p) => p.scope_label!)
  );
  const hint = ROLE_HINTS[person.role];

  const places = ((placesRes.data ?? []) as {
    id: string; relation: string; property_id: string | null; node_id: string | null;
    scope_label: string | null; scope_level: string | null; property_count: number | null;
  }[]);
  const namedPlaces = places.filter((p) => p.scope_label);

  const tenancies = (tenanciesRes.data ?? []) as unknown as Tenancy[];
  const liveTenancies = tenancies.filter((t) => isLiveTenancy(t.status));

  const owned = ((ownedRes.data ?? []) as unknown as {
    property_id: string; created_at: string;
    properties: { id: string; name: string; address: string | null; reference: string | null } | null;
  }[]).filter((o) => o.properties);
  const liveByProperty = new Map<string, number>();
  for (const t of (ownerScheduleRes.data ?? []) as { property_id: string; status: string }[]) {
    if (isLiveTenancy(t.status)) liveByProperty.set(t.property_id, (liveByProperty.get(t.property_id) ?? 0) + 1);
  }

  const vendorLinks = ((vendorLinksRes.data ?? []) as unknown as {
    vendor_id: string; is_owner: boolean; capabilities: string[] | null; created_at: string;
    vendors: { id: string; name: string; service_category: string | null; approval_status: string | null } | null;
  }[]);

  const raised = (raisedRes.data ?? []) as unknown as TicketRow[];
  const assigned = (assignedRes.data ?? []) as unknown as TicketRow[];
  const payments = (paymentsRes.data ?? []) as {
    id: string; gateway_reference: string | null; purpose: string; currency: string;
    amount_expected: number | string; amount_paid: number | string | null; status: string;
    paid_at: string | null; created_at: string;
  }[];
  const claims = (claimsRes.data ?? []) as {
    id: string; reference: string; method: string; claimed_amount: number | string;
    currency: string; paid_on: string; status: ClaimStatus;
  }[];

  const channels = [
    person.notify_email && "Email",
    person.notify_whatsapp && "WhatsApp",
    person.notify_sms && "SMS",
    person.notify_telegram && person.telegram_chat_id && "Telegram",
  ].filter(Boolean) as string[];

  const backHref = `/dashboard/people/directory?group=${group}`;

  return (
    <div className="printable space-y-6">
      <PrintMasthead
        org={org.name}
        title={`Profile — ${name}`}
        subtitle={roleName}
        by={viewer.full_name || viewer.email || undefined}
      />

      <div data-print="screen-only">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={backHref}>
            <ArrowLeft className="size-4" /> {GROUP_BACK[group]}
          </Link>
        </Button>
      </div>

      <PageHeader
        title={
          <>
            {name}
            {person.id === viewer.id && (
              <span className="ml-2 text-base font-normal text-muted-foreground">(you)</span>
            )}
          </>
        }
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge variant="outline">{roleName}</Badge>
            {person.deactivated_at ? (
              <Badge variant="muted">Deactivated {fmtDate(person.deactivated_at)}</Badge>
            ) : (
              <Badge variant="success">Active</Badge>
            )}
            {person.role === "payment_approver" && (
              <Badge variant={person.approval_tier ? "outline" : "warning"}>
                {person.approval_tier ? `Approval tier ${person.approval_tier}` : "No approval tier"}
              </Badge>
            )}
          </span>
        }
        actions={<PrintButton label="Print profile" />}
      />

      {/* ── Who they are and how to reach them ───────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Contact &amp; account</CardTitle>
          {hint && <CardDescription>{hint}</CardDescription>}
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <Field icon={<Mail className="size-4" />} label="Email">
              {person.email_released_at ? (
                <span>
                  <span className="line-through">{person.former_email}</span>
                  <span className="ml-2 text-muted-foreground">— address released {fmtDate(person.email_released_at)}</span>
                </span>
              ) : person.email ? (
                <a className="underline-offset-2 hover:underline" href={`mailto:${person.email}`}>{person.email}</a>
              ) : "—"}
            </Field>
            <Field icon={<Phone className="size-4" />} label="Phone">
              {person.phone ? (
                <a className="underline-offset-2 hover:underline" href={`tel:${person.phone.replace(/\s/g, "")}`}>{person.phone}</a>
              ) : (
                <span className="text-muted-foreground">Not recorded</span>
              )}
            </Field>
            <Field icon={<CalendarDays className="size-4" />} label="On the platform since">
              {fmtDate(person.created_at)}
            </Field>
            <Field icon={<Bell className="size-4" />} label="Notified by">
              {channels.length ? channels.join(", ") : (
                <span className="text-muted-foreground">In-app only</span>
              )}
            </Field>
          </dl>
        </CardContent>
      </Card>

      {/* ── Staff: the places they hold ───────────────────────────────────── */}
      {isStaff && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Places they hold</CardTitle>
            <CardDescription>
              The properties and parts of the property tree this person is attached
              to — what their access is bounded by.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {namedPlaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {places.length > namedPlaces.length
                  ? "Attached only to places outside your own remit."
                  : ["admin", "executive", "finance_approver", "payment_approver", "payment_audit_approver"].includes(person.role)
                    ? "Not attached to places — this role's reach is the whole organisation."
                    : "Not attached to any property or region yet."}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {namedPlaces.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                    <span className="min-w-0">
                      {p.property_id ? (
                        <Link className="font-medium underline-offset-2 hover:underline" href={`/dashboard/properties/${p.property_id}`}>
                          {p.scope_label}
                        </Link>
                      ) : (
                        <span className="font-medium">{p.scope_label}</span>
                      )}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {humanize(p.scope_level)}
                        {p.node_id && p.property_count != null && ` · ${p.property_count} propert${Number(p.property_count) === 1 ? "y" : "ies"}`}
                      </span>
                    </span>
                    <Badge variant="muted">{humanize(p.relation)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Tenant: where they live, and what they owe ────────────────────── */}
      {isTenant && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Tenancies</CardTitle>
            <CardDescription>
              {`${liveTenancies.length} current${
                tenancies.length > liveTenancies.length
                  ? ` · ${tenancies.length - liveTenancies.length} past or draft`
                  : ""
              }. Open one for its full statement — every demand, receipt and service charge.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tenancies.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No tenancy on a property you can see.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[12rem]">Home</TableHead>
                      <TableHead>Term</TableHead>
                      <TableHead className="text-right">Rent</TableHead>
                      {money && <TableHead className="text-right">Rent outstanding</TableHead>}
                      {money && <TableHead className="text-right">Service charge outstanding</TableHead>}
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tenancies.map((t) => (
                      <TableRow key={t.lease_id}>
                        <TableCell>
                          <Link className="font-medium underline-offset-2 hover:underline" href={`/dashboard/leases/${t.lease_id}`}>
                            {[t.property_name, t.unit_label].filter(Boolean).join(" · ") || "Tenancy"}
                          </Link>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {fmtDate(t.start_date)} – {fmtDate(t.end_date)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {formatMoney(t.rent_amount, t.currency)}
                          {t.rent_frequency && (
                            <span className="ml-1 text-xs text-muted-foreground">/{humanize(t.rent_frequency).toLowerCase()}</span>
                          )}
                        </TableCell>
                        {money && (
                          <TableCell className="whitespace-nowrap text-right tabular-nums">
                            {formatMoney(t.rent_outstanding, t.currency)}
                          </TableCell>
                        )}
                        {money && (
                          <TableCell className="whitespace-nowrap text-right tabular-nums">
                            {/* Never added to the rent (decision 25): collected FOR the
                                owner vs INTO the building's fund. */}
                            {formatMoney(t.service_charge_outstanding, "NGN")}
                          </TableCell>
                        )}
                        <TableCell><StatusBadge status={t.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ⚠️ Decision 25, applied: for a place-scoped desk (PM/RM) an empty
          payments list on a tenant whose tenancies they cannot see means "not
          yours to see", not "never paid" — so the card is only offered where
          it can be read as a fact: oversight, or a desk holding at least one of
          this tenant's tenancies. */}
      {isTenant && money && (orgWideMoney || tenancies.length > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Payments</CardTitle>
            <CardDescription>
              Online collections raised against them, most recent first — on the
              properties your role reaches.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {orgWideMoney
                  ? "No online payments raised against them."
                  : "None raised against them on the properties you hold."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead>For</TableHead>
                      <TableHead className="text-right">Invoiced</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Paid</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-xs">{p.gateway_reference ?? shortRef(p.id)}</TableCell>
                        <TableCell>{humanize(p.purpose)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{formatMoney(p.amount_expected, p.currency)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {p.amount_paid != null ? formatMoney(p.amount_paid, p.currency) : "—"}
                        </TableCell>
                        <TableCell><StatusBadge status={p.status} /></TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(p.paid_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Off-platform claims carry their own read rule (`may_read_offline_claim`)
          and it admits the FM/PM place branch too — so this section follows the
          claim policy, not the money gate above. Rendered only when there is
          something to show, because an empty result here cannot tell "never
          reported one" from "reported one on a building you do not hold". */}
      {isTenant && claims.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Payments reported off-platform</CardTitle>
            <CardDescription>
              Bank transfers and in-branch deposits, each with its proof and its
              place in the three-desk confirmation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border rounded-md border border-border">
              {claims.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/dashboard/payments/offline/${c.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="font-mono text-xs">{c.reference}</span>
                      <span className="ml-2 text-muted-foreground">
                        {humanize(c.method)} · paid {fmtDate(c.paid_on)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{formatMoney(c.claimed_amount, c.currency)}</span>
                      <StatusBadge status={c.status} label={CLAIM_STATUS_LABEL[c.status] ?? humanize(c.status)} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* ── Landlord: the buildings they own ──────────────────────────────── */}
      {isLandlord && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Properties owned</CardTitle>
            <CardDescription>
              Each opens on the property; its statement is the account a landlord
              is handed — rent and service charge side by side.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {owned.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Not attached as the owner of any property you can see.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {owned.map((o) => {
                  const p = o.properties!;
                  const live = liveByProperty.get(p.id) ?? 0;
                  return (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                      <span className="min-w-0">
                        <Link className="font-medium underline-offset-2 hover:underline" href={`/dashboard/properties/${p.id}`}>
                          {p.name}
                        </Link>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[p.reference, p.address].filter(Boolean).join(" · ") || "No address recorded"}
                          {` · ${live} current tenanc${live === 1 ? "y" : "ies"}`}
                        </span>
                      </span>
                      <Button asChild variant="outline" size="sm" data-print="screen-only">
                        <Link href={`/dashboard/properties/${p.id}/statement`}>
                          <FileText className="size-4" /> Statement
                        </Link>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Vendor login: the company they act for ────────────────────────── */}
      {isVendor && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Company</CardTitle>
            <CardDescription>
              What this login may do for its company is set by the company itself,
              from four fixed capabilities.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {vendorLinks.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not linked to a vendor company.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {vendorLinks.map((l) => (
                  <li key={l.vendor_id} className="space-y-1.5 px-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {l.vendors ? (
                        <Link className="font-medium underline-offset-2 hover:underline" href={`/dashboard/vendors/${l.vendors.id}`}>
                          {l.vendors.name}
                          <ExternalLink className="ml-1 inline size-3" />
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">A company you cannot see</span>
                      )}
                      <span className="flex gap-1.5">
                        {l.is_owner && <Badge variant="info">Company owner</Badge>}
                        {l.vendors?.service_category && <Badge variant="muted">{humanize(l.vendors.service_category)}</Badge>}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      May: {(l.capabilities ?? []).length
                        ? (l.capabilities ?? []).map((c) => humanize(c.replace(/^manage_/, "manage "))).join(", ")
                        : "read only"}
                      {" · "}linked {fmtDate(l.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Requests ─────────────────────────────────────────────────────── */}
      <div className={isStaff ? "grid gap-6 lg:grid-cols-2" : ""}>
        <TicketCard
          title="Requests they raised"
          rows={raised}
          total={raisedRes.count ?? raised.length}
          empty="None."
        />
        {isStaff && (
          <TicketCard
            title="Requests assigned to them"
            rows={assigned}
            total={assignedRes.count ?? assigned.length}
            empty="None."
          />
        )}
      </div>

      <p className="text-xs text-muted-foreground" data-print="screen-only">
        Everything on this page is what your own role already reaches — requests,
        tenancies and buildings outside it are not listed.
        {viewer.role === "admin" && person.id !== viewer.id &&
          " Deactivating, restoring or resetting this account is on the Members tab."}
      </p>
    </div>
  );
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="break-words">{children}</dd>
      </div>
    </div>
  );
}

function TicketCard({
  title, rows, total, empty,
}: {
  title: string; rows: TicketRow[]; total: number; empty: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {/* "you can see", always: `tickets_select` is place-scoped for a
              manager, so "0 in total" would be a claim about requests they
              were never shown. */}
          {total > rows.length ? `Latest ${rows.length} of ${total} you can see` : `${total} you can see`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {rows.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/dashboard/tickets/${t.id}`}
                  className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm hover:bg-muted/60"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{t.summary || t.message_text || "Request"}</span>
                    <span className="block text-xs text-muted-foreground">
                      <span className="font-mono">{shortRef(t.id)}</span>
                      {t.properties?.name && ` · ${t.properties.name}`} · {fmtDate(t.created_at)}
                    </span>
                  </span>
                  <StatusBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
