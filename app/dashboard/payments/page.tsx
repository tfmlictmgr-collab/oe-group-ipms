import Link from "next/link";
import { redirect } from "next/navigation";
import { Banknote, Plus, ChevronRight, Unlink, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";
import { statusLabel } from "@/lib/payment";
import { shortRef } from "@/lib/acknowledgement";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import RoleGate, { roleAllowed } from "../RoleGate";
import BatchApprove, { type PaymentRow } from "./BatchApprove";

export const dynamic = "force-dynamic";

type TraceRow = {
  payment_id: string;
  invoice_reference: string | null;
  amount: number | string;
  status: string;
  created_at: string;
  vendor_name: string | null;
  ticket_id: string | null;
  work_order_summary: string | null;
  unmatched_and_paid: boolean;
};

export default async function PaymentsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  // `executive` reads this screen because they are part of the gate on it:
  // `enforce_payment_transition()` lets an MD / Managing Partner co-approve a
  // payment, and above the threshold it REQUIRES one. Refusing them the page
  // was asking for an authorisation without showing what was being authorised.
  // Remittance stays refused in the database regardless of who opens this page.
  if (!roleAllowed(session.profile?.role, [
    "admin", "facility_manager", "finance_approver", "executive",
  ])) {
    return <RoleGate title="Vendor Payments" />;
  }

  const supabase = await createClient();

  // Read through the trace view rather than `payments` directly, so every row
  // arrives beside the work order it names — or beside the fact that it names
  // none. `security_invoker`, so RLS still decides which rows come back.
  const [{ data }, { data: limitRows }] = await Promise.all([
    supabase
      .from("payment_work_order_trace")
      .select(
        "payment_id, invoice_reference, amount, status, created_at, vendor_name, ticket_id, work_order_summary, unmatched_and_paid"
      )
      .order("created_at", { ascending: false }),
    supabase.rpc("my_approval_limit"),
  ]);

  const payments = (data as TraceRow[]) ?? [];
  const limitRow = (limitRows ?? [])[0] as
    | { threshold: number | string; unlimited: boolean; may_approve: boolean }
    | undefined;

  const outstanding = payments
    .filter((p) => !["remitted", "rejected"].includes(p.status))
    .reduce((a, p) => a + Number(p.amount), 0);

  // The approval queue: only what there is a decision to make about. Offering a
  // checkbox against a payment three steps back would invite ticking it and
  // being refused, once per row.
  const queue: PaymentRow[] = limitRow?.may_approve
    ? payments
        .filter((p) => p.status === "recommended")
        .map((p) => ({
          id: p.payment_id,
          invoice_reference: p.invoice_reference,
          amount: p.amount,
          status: p.status,
          vendor_name: p.vendor_name,
          ticket_reference: p.ticket_id ? shortRef(p.ticket_id) : null,
        }))
    : [];

  // ⚠️ Invoices waiting on THIS reader, at the first gate.
  //
  // The batch queue above is finance's. An FM/PM or regional manager is the
  // person who confirms the work actually happened — and had no queue at all:
  // a raised invoice landed in the same undifferentiated list as everything
  // else, so "what is waiting on me?" could only be answered by reading every
  // row. RLS already narrows `payments` to vendors they are scoped to, so this
  // is exactly their own workload.
  const awaitingVerification = payments.filter((p) => p.status === "pending_verification");

  // Money out, or about to go out, with nothing on file saying what it bought.
  const unmatched = payments.filter((p) => p.unmatched_and_paid);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vendor Payments"
        description="Gated remittance: verify → performance → approve → remit."
        actions={
          <Button asChild variant="brand">
            <Link href="/dashboard/payments/new">
              <Plus /> Submit Invoice
            </Link>
          </Button>
        }
      />

      {payments.length === 0 ? (
        <EmptyState
          icon={<Banknote />}
          title="No payment requests yet"
          description="Submitted vendor invoices appear here and move through the approval gate."
          action={
            <Button asChild variant="brand" size="sm">
              <Link href="/dashboard/payments/new">
                <Plus /> Submit Invoice
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              In the approval pipeline
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatNaira(outstanding)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Across {payments.filter((p) => !["remitted", "rejected"].includes(p.status)).length} open
              request(s) — none pays out until the gate passes.
            </p>
          </div>

          {awaitingVerification.length > 0 && (
            <Card className="border-[var(--brand)]/40">
              <CardContent className="space-y-2 p-4 sm:p-5">
                <p className="flex items-center gap-2 font-medium">
                  <ShieldCheck className="size-4 text-[var(--brand)]" />
                  {awaitingVerification.length} invoice
                  {awaitingVerification.length === 1 ? "" : "s"} awaiting service
                  verification
                </p>
                <p className="text-xs text-muted-foreground">
                  Nothing moves until someone confirms the work was delivered.
                  This is the first gate, and it is yours.
                </p>
                <ul className="space-y-1 pt-1">
                  {awaitingVerification.slice(0, 8).map((p) => (
                    <li key={p.payment_id} className="text-xs">
                      <Link
                        href={`/dashboard/payments/${p.payment_id}`}
                        className="underline underline-offset-2"
                      >
                        {p.vendor_name ?? "—"} · {p.invoice_reference ?? "no reference"}
                      </Link>
                      <span className="text-muted-foreground">
                        {" "}
                        · {formatNaira(p.amount)}
                        {p.ticket_id ? ` · job ${shortRef(p.ticket_id)}` : " · no work order"}
                      </span>
                    </li>
                  ))}
                </ul>
                {awaitingVerification.length > 8 && (
                  <p className="text-xs text-muted-foreground">
                    …and {awaitingVerification.length - 8} more.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <BatchApprove
            rows={queue}
            limit={
              limitRow
                ? { threshold: Number(limitRow.threshold), unlimited: limitRow.unlimited }
                : null
            }
          />

          {/* The reconciliation exception, stated rather than left to be
              noticed. B4 verifies delivery against something; a payment that
              names no work order has nothing for that check to have been
              about. Shown to everyone who can reach this page — an FM who
              verified the service is exactly who can say which job it was. */}
          {unmatched.length > 0 && (
            <Card className="border-warning/40">
              <CardContent className="space-y-2 p-4 sm:p-5">
                <p className="flex items-center gap-2 font-medium">
                  <Unlink className="size-4 text-warning" />
                  {unmatched.length} approved payment
                  {unmatched.length === 1 ? "" : "s"} with no work order
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatNaira(unmatched.reduce((a, p) => a + Number(p.amount), 0))}{" "}
                  approved or already remitted against no recorded job. These are
                  not blocked — invoices predating the link, or entered without
                  one — but nothing on file says what the money bought.
                </p>
                <ul className="space-y-1 pt-1">
                  {unmatched.slice(0, 8).map((p) => (
                    <li key={p.payment_id} className="text-xs">
                      <Link
                        href={`/dashboard/payments/${p.payment_id}`}
                        className="underline underline-offset-2"
                      >
                        {p.vendor_name ?? "—"} · {p.invoice_reference ?? "no reference"}
                      </Link>
                      <span className="text-muted-foreground">
                        {" "}
                        · {formatNaira(p.amount)} · {statusLabel(p.status)}
                      </span>
                    </li>
                  ))}
                </ul>
                {unmatched.length > 8 && (
                  <p className="text-xs text-muted-foreground">
                    …and {unmatched.length - 8} more.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <ul className="space-y-2.5">
            {payments.map((p) => (
              <li key={p.payment_id}>
                <Link
                  href={`/dashboard/payments/${p.payment_id}`}
                  className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.vendor_name ?? "—"}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.invoice_reference ?? "no reference"}
                      {p.ticket_id
                        ? ` · job ${shortRef(p.ticket_id)}`
                        : " · no work order"}
                    </p>
                    <div className="mt-2 sm:hidden">
                      <StatusBadge status={p.status} label={statusLabel(p.status)} />
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-3">
                    <span className="hidden sm:inline-flex">
                      <StatusBadge status={p.status} label={statusLabel(p.status)} />
                    </span>
                    <span className="text-right font-semibold tabular-nums">
                      {formatNaira(p.amount)}
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
