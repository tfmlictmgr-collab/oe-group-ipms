import Link from "next/link";
import { redirect } from "next/navigation";
import { Banknote, Plus, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";
import { statusLabel } from "@/lib/payment";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import RoleGate, { roleAllowed } from "../RoleGate";

type Row = {
  id: string;
  invoice_reference: string | null;
  amount: number | string;
  status: string;
  created_at: string;
  vendors: { name: string } | null;
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
  const { data } = await supabase
    .from("payments")
    .select("id, invoice_reference, amount, status, created_at, vendors(name)")
    .order("created_at", { ascending: false });

  const payments = (data as unknown as Row[]) ?? [];
  const outstanding = payments
    .filter((p) => !["remitted", "rejected"].includes(p.status))
    .reduce((a, p) => a + Number(p.amount), 0);

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

          <ul className="space-y-2.5">
            {payments.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/dashboard/payments/${p.id}`}
                  className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.vendors?.name ?? "—"}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.invoice_reference ?? "no reference"}
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
