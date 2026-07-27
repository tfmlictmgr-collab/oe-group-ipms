"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CreditCard, Link2, ExternalLink, RefreshCw, FileText, TriangleAlert,
  CheckCircle2, Clock, Receipt, FlaskConical,
} from "lucide-react";
import { formatNaira } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatCard } from "@/components/patterns/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { raisePaymentRequest, refreshPaymentStatus } from "./actions";

type Person = { full_name: string | null; email: string | null } | null;

export type IntentRow = {
  id: string;
  purpose: string;
  amount_expected: number | string;
  amount_paid: number | string | null;
  currency: string;
  status: string;
  gateway: string;
  gateway_reference: string;
  checkout_url: string | null;
  paid_at: string | null;
  amount_mismatch: boolean;
  ledger_entry_id: string | null;
  created_at: string;
  service_charge_id: string | null;
  users: Person;
};

export type BillableRow = {
  id: string;
  amount: number | string;
  status: string;
  billing_period: string | null;
  property_or_unit: string | null;
  due_date: string | null;
  users: Person;
};

const STATUS: Record<string, { label: string; variant: "success" | "warning" | "muted" | "destructive" }> = {
  paid: { label: "Paid", variant: "success" },
  part_paid: { label: "Part paid", variant: "warning" },
  pending: { label: "Awaiting payment", variant: "muted" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "muted" },
};

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", {
        timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
      })
    : "—";

export default function CollectionsClient({
  intents, billable, returnedRef, returnedIntentId, mode,
}: {
  intents: IntentRow[];
  billable: BillableRow[];
  returnedRef: string | null;
  returnedIntentId: string | null;
  mode: "live" | "test" | "simulated";
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const checkedRef = React.useRef(false);

  const collected = intents
    .filter((i) => i.ledger_entry_id)
    .reduce((s, i) => s + Number(i.amount_paid ?? 0), 0);
  const awaiting = intents
    .filter((i) => ["pending", "part_paid"].includes(i.status))
    .reduce((s, i) => s + (Number(i.amount_expected) - Number(i.amount_paid ?? 0)), 0);
  const flagged = intents.filter((i) => i.amount_mismatch).length;

  const check = React.useCallback(
    async (id: string, quiet = false) => {
      setBusy(id);
      try {
        const r = await refreshPaymentStatus(id);
        if (!r.ok) {
          toast.error(r.message, { description: r.hint });
        } else if (r.data.posted) {
          toast.success("Payment confirmed", {
            description: "It has been posted to the client-funds ledger.",
          });
          router.refresh();
        } else if (!quiet) {
          toast.info("Not yet received", {
            description: `The gateway reports this as ${r.data.status}. Nothing has been posted.`,
          });
        }
      } catch {
        // Only unexpected faults reach here; expected ones come back as ok:false.
        toast.error("Something went wrong", {
          description: "The check could not be completed. Please try again.",
        });
      } finally {
        setBusy(null);
      }
    },
    [router]
  );

  // Coming back from the gateway, confirm immediately rather than waiting on the
  // webhook. Posting is idempotent, so this racing the webhook is harmless.
  React.useEffect(() => {
    if (returnedIntentId && !checkedRef.current) {
      checkedRef.current = true;
      void check(returnedIntentId, true);
    }
  }, [returnedIntentId, check]);

  async function raise(serviceChargeId: string) {
    setBusy(serviceChargeId);
    try {
      const r = await raisePaymentRequest({ purpose: "service_charge", serviceChargeId });

      if (!r.ok) {
        // Kept on screen until dismissed: these say what to change, and a
        // message that disappears in four seconds cannot be acted on.
        toast.error(r.message, { description: r.hint, duration: Infinity, closeButton: true });
        return;
      }

      if (r.data.checkoutUrl) {
        await navigator.clipboard.writeText(absolute(r.data.checkoutUrl)).catch(() => {});
        toast.success("Payment request raised", {
          description: `${r.data.reference} — checkout link copied to the clipboard.`,
        });
      } else {
        toast.success("Payment request raised", { description: r.data.reference });
      }
      router.refresh();
    } catch {
      toast.error("Something went wrong", {
        description: "The request could not be raised. Please try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  const returned = returnedRef ? intents.find((i) => i.gateway_reference === returnedRef) : null;

  return (
    <div className="space-y-6">
      {returned && (
        <Card className={returned.ledger_entry_id ? "border-success/40" : "border-warning/40"}>
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            {returned.ledger_entry_id ? (
              <CheckCircle2 className="size-5 text-success" />
            ) : (
              <Clock className="size-5 text-warning" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {returned.ledger_entry_id
                  ? `${formatNaira(returned.amount_paid)} received and posted to the ledger.`
                  : "Returned from the gateway — confirming the payment."}
              </p>
              <p className="text-xs text-muted-foreground">Reference {returned.gateway_reference}</p>
            </div>
            {returned.ledger_entry_id && (
              <Button asChild size="sm" variant="outline">
                <a href={`/api/receipts/${returned.id}`} target="_blank" rel="noopener noreferrer">
                  <Receipt className="size-4" /> Receipt
                </a>
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Collected (last 60 requests)" value={formatNaira(collected)} icon={<CheckCircle2 />} />
        <StatCard label="Still awaiting payment" value={formatNaira(awaiting)} icon={<Clock />} />
        <StatCard label="Amount mismatches" value={String(flagged)} icon={<TriangleAlert />} />
      </div>

      {/* Which gateway mode is in force. Nothing else on screen distinguishes a
          test key from a live one, and the difference is whether real cards are
          charged. */}
      {mode === "simulated" && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 text-sm">
          <FlaskConical className="mt-0.5 size-4 flex-shrink-0 text-warning" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Simulated gateway.</span>{" "}
            No Paystack key is configured for this environment, so checkout runs
            in-app. The intent, webhook, verification and ledger posting are all
            real — only the card is not.
          </p>
        </div>
      )}
      {mode === "test" && (
        <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/8 px-4 py-3 text-sm">
          <FlaskConical className="mt-0.5 size-4 flex-shrink-0 text-info" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Paystack test mode.</span>{" "}
            Checkout is the real Paystack page, but no card is charged. Use test
            card <span className="font-mono">4084 0840 8408 4081</span>, any future
            expiry, CVV <span className="font-mono">408</span>, OTP{" "}
            <span className="font-mono">123456</span>.
          </p>
        </div>
      )}
      {mode === "live" && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/8 px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 flex-shrink-0 text-destructive" />
          <p className="text-muted-foreground">
            <span className="font-semibold text-destructive">Live keys — real money.</span>{" "}
            Any payment raised here charges a real card and settles to the
            client-funds account. If this is a demonstration environment, replace{" "}
            <span className="font-mono">PAYSTACK_SECRET_KEY</span> with the{" "}
            <span className="font-mono">sk_test_…</span> key before continuing.
          </p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Request a payment</CardTitle>
          <CardDescription>
            The amount is taken from the invoice, never from the checkout page,
            so it cannot be altered by the payer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {billable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing outstanding — every unpaid service charge already has a live
              payment request.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Billed to</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {billable.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <span className="font-medium">{c.users?.full_name ?? "Unassigned"}</span>
                        {c.property_or_unit && (
                          <span className="block text-xs text-muted-foreground">{c.property_or_unit}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{c.billing_period ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(c.due_date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNaira(c.amount)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" disabled={busy === c.id} onClick={() => raise(c.id)}>
                          <CreditCard className="size-4" />
                          {busy === c.id ? "Raising…" : "Request"}
                        </Button>
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
        <CardHeader>
          <CardTitle className="text-base">Payment requests</CardTitle>
          <CardDescription>
            Every request, and whether the money has reached the ledger.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {intents.length === 0 ? (
            <EmptyState
              icon={<CreditCard />}
              title="No payment requests yet"
              description="Raise one against an outstanding service charge above and the checkout link will be copied for you."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payer</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Raised</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {intents.map((i) => {
                    const st = STATUS[i.status] ?? { label: i.status, variant: "muted" as const };
                    const open = ["pending", "part_paid"].includes(i.status);
                    return (
                      <TableRow key={i.id}>
                        <TableCell>
                          <span className="font-medium">{i.users?.full_name ?? "—"}</span>
                          <span className="block text-xs capitalize text-muted-foreground">
                            {i.purpose.replace(/_/g, " ")}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{i.gateway_reference}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtDate(i.created_at)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNaira(i.amount_expected)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {i.amount_paid == null ? "—" : formatNaira(i.amount_paid)}
                          {i.amount_mismatch && (
                            <TriangleAlert className="ml-1 inline size-3.5 text-warning" />
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={st.variant}>{st.label}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {open && i.checkout_url && (
                              <>
                                <Button
                                  size="icon-sm" variant="ghost" title="Copy checkout link"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(absolute(i.checkout_url!));
                                    toast.success("Checkout link copied");
                                  }}
                                >
                                  <Link2 className="size-4" />
                                </Button>
                                <Button size="icon-sm" variant="ghost" asChild title="Open checkout">
                                  <a href={i.checkout_url} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="size-4" />
                                  </a>
                                </Button>
                              </>
                            )}
                            {open && (
                              <Button
                                size="icon-sm" variant="ghost" title="Check with the gateway"
                                disabled={busy === i.id} onClick={() => check(i.id)}
                              >
                                <RefreshCw className={busy === i.id ? "size-4 animate-spin" : "size-4"} />
                              </Button>
                            )}
                            {i.ledger_entry_id && (
                              <Button size="icon-sm" variant="ghost" asChild title="Download receipt">
                                <a href={`/api/receipts/${i.id}`} target="_blank" rel="noopener noreferrer">
                                  <FileText className="size-4" />
                                </a>
                              </Button>
                            )}
                          </div>
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

/** Simulated checkout links are relative; a copied link has to work anywhere. */
function absolute(url: string) {
  return url.startsWith("http") ? url : `${window.location.origin}${url}`;
}
