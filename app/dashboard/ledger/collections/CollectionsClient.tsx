"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CreditCard, Link2, ExternalLink, RefreshCw, FileText, TriangleAlert,
  CheckCircle2, Clock, Receipt, FlaskConical,
} from "lucide-react";
import { formatMoney } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer } from "@/components/patterns/record-drawer";
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
  intents, billable, returnedRef, returnedIntentId, mode, fxMode, fxCurrencies,
}: {
  intents: IntentRow[];
  billable: BillableRow[];
  returnedRef: string | null;
  returnedIntentId: string | null;
  mode: "live" | "test" | "simulated";
  /** Flutterwave's mode — one for every non-NGN currency, B3's single FX adapter. */
  fxMode: "live" | "test" | "simulated";
  /** Currencies this org actually has a client-funds account for (0103). */
  fxCurrencies: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  // Who is being asked to pay. `service_charge`, `rent` and `deposit` are
  // billed to a tenant against their own unit; `other` is the ad-hoc/FX card,
  // raised against a vendor, a landlord or a client. That is the actual
  // difference between the two audiences, and it is already carried by the
  // column — it had simply never been used to separate them.
  const [audience, setAudience] = React.useState<"all" | "tenant" | "other">("all");
  const TENANT_PURPOSES = ["service_charge", "rent", "deposit"];
  const tenantIntents = intents.filter((i) => TENANT_PURPOSES.includes(i.purpose));
  const otherIntents = intents.filter((i) => !TENANT_PURPOSES.includes(i.purpose));
  const shownIntents =
    audience === "tenant" ? tenantIntents : audience === "other" ? otherIntents : intents;
  const checkedRef = React.useRef(false);
  const [fxForm, setFxForm] = React.useState({ amount: "", currency: fxCurrencies[0] ?? "", email: "" });
  const drawer = useDrawer();

  // ⚠️ Grouped by currency, not summed across all of them. `intents` can now
  // legitimately mix NGN and FX rows (0103) — summing a ₦ figure and a $ figure
  // together and printing it with a single "₦" prefix would misstate both. Same
  // reasoning as the ledger's `client_funds_position` view: a total is only
  // meaningful within one currency.
  type Stat = { collected: number; awaiting: number; flagged: number };
  const byCurrency = new Map<string, Stat>();
  for (const i of intents) {
    const cur = i.currency || "NGN";
    const s = byCurrency.get(cur) ?? { collected: 0, awaiting: 0, flagged: 0 };
    if (i.ledger_entry_id) s.collected += Number(i.amount_paid ?? 0);
    if (["pending", "part_paid"].includes(i.status)) {
      s.awaiting += Number(i.amount_expected) - Number(i.amount_paid ?? 0);
    }
    if (i.amount_mismatch) s.flagged += 1;
    byCurrency.set(cur, s);
  }
  // NGN always shown, even at zero — it's the default currency and its absence
  // would read as "nothing collected" rather than "nothing collected yet".
  if (!byCurrency.has("NGN")) byCurrency.set("NGN", { collected: 0, awaiting: 0, flagged: 0 });
  const statRows = Array.from(byCurrency.entries()).sort(([a], [b]) =>
    a === "NGN" ? -1 : b === "NGN" ? 1 : a.localeCompare(b)
  );

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

  async function raiseFx() {
    const amount = Number(fxForm.amount.replace(/[,\s]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a positive amount.");
      return;
    }
    setBusy("fx");
    try {
      // purpose: "other" — an ad-hoc international collection has no invoice
      // behind it, so it lands in suspense pending a human deciding what it
      // actually is (0032/0103), exactly like any other unattached receipt.
      const r = await raisePaymentRequest({
        purpose: "other", amount, currency: fxForm.currency, email: fxForm.email,
      });

      if (!r.ok) {
        toast.error(r.message, { description: r.hint, duration: Infinity, closeButton: true });
        return;
      }

      if (r.data.checkoutUrl) {
        await navigator.clipboard.writeText(absolute(r.data.checkoutUrl)).catch(() => {});
        toast.success("International payment request raised", {
          description: `${r.data.reference} — checkout link copied to the clipboard.`,
        });
      } else {
        toast.success("International payment request raised", { description: r.data.reference });
      }
      setFxForm((f) => ({ ...f, amount: "", email: "" }));
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
                  ? `${formatMoney(returned.amount_paid, returned.currency)} received and posted to the ledger.`
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

      {statRows.map(([currency, s]) => {
        // The intents composing each figure for THIS currency. Already on the
        // page — the drawer stops the reader having to scan the table below
        // and filter by currency in their head.
        const forCur = intents.filter((i) => (i.currency || "NGN") === currency);
        const collectedRows = forCur.filter((i) => i.ledger_entry_id);
        const awaitingRows = forCur.filter((i) => ["pending", "part_paid"].includes(i.status));
        const flaggedRows = forCur.filter((i) => i.amount_mismatch);
        const asRecord = (i: IntentRow, amount: number, tone?: "warning" | "destructive") => ({
          id: i.id,
          title: i.gateway_reference,
          meta: `${i.purpose.replace(/_/g, " ")} · ${formatMoney(amount, i.currency || "NGN")}`,
          tag: i.status,
          tone,
        });

        return (
          <div key={currency} className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label={currency === "NGN" ? "Collected (last 60 requests)" : `Collected — ${currency}`}
              value={formatMoney(s.collected, currency)} icon={<CheckCircle2 />}
              onClick={() => drawer.open({
                eyebrow: `Collections · ${currency}`, title: "Collected",
                scope: "Received and posted to the ledger",
                facts: [["Total collected", formatMoney(s.collected, currency)]],
                records: collectedRows.map((i) => asRecord(i, Number(i.amount_paid ?? 0))),
                emptyLabel: "Nothing collected in this currency yet.",
              })}
            />
            <StatCard
              label="Still awaiting payment"
              value={formatMoney(s.awaiting, currency)} icon={<Clock />}
              onClick={() => drawer.open({
                eyebrow: `Collections · ${currency}`, title: "Still awaiting payment",
                scope: "Raised and not yet settled",
                facts: [["Total awaiting", formatMoney(s.awaiting, currency)]],
                records: awaitingRows.map((i) =>
                  asRecord(i, Number(i.amount_expected) - Number(i.amount_paid ?? 0), "warning")
                ),
                emptyLabel: "Nothing awaiting payment.",
              })}
            />
            <StatCard
              label="Amount mismatches" value={String(s.flagged)} icon={<TriangleAlert />}
              onClick={() => drawer.open({
                eyebrow: `Collections · ${currency}`, title: "Amount mismatches",
                scope: "Paid a different amount than was requested — each needs a person",
                records: flaggedRows.map((i) =>
                  asRecord(i, Number(i.amount_paid ?? 0), "destructive")
                ),
                emptyLabel: "No mismatches — every payment matched its request.",
              })}
            />
          </div>
        );
      })}

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

      {/* Flutterwave's own mode — shown only once an admin has actually enabled
          a foreign currency (Settings → Banking). An org that never touches FX
          sees nothing extra here; the badge would otherwise be noise about a
          capability nobody asked for. */}
      {fxCurrencies.length > 0 && fxMode === "simulated" && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 text-sm">
          <FlaskConical className="mt-0.5 size-4 flex-shrink-0 text-warning" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Simulated FX gateway.</span>{" "}
            No Flutterwave key is configured yet, so international checkout runs
            in-app — the intent, webhook, verification and ledger posting are
            all real, only the card is not.
          </p>
        </div>
      )}
      {fxCurrencies.length > 0 && fxMode === "test" && (
        <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/8 px-4 py-3 text-sm">
          <FlaskConical className="mt-0.5 size-4 flex-shrink-0 text-info" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Flutterwave test mode.</span>{" "}
            International checkout is the real Flutterwave page, but no card is
            charged.
          </p>
        </div>
      )}
      {fxCurrencies.length > 0 && fxMode === "live" && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/8 px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 flex-shrink-0 text-destructive" />
          <p className="text-muted-foreground">
            <span className="font-semibold text-destructive">Live Flutterwave keys — real money.</span>{" "}
            Any international payment raised here charges a real card.
          </p>
        </div>
      )}

      {fxCurrencies.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Request an international payment</CardTitle>
            <CardDescription>
              For a tenant, vendor or client paying in a currency other than
              Naira — kept in its own, separately-segregated {fxForm.currency || "—"}{" "}
              client-funds account, never mixed with the Naira figures above.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fx-amount">Amount</Label>
              <Input
                id="fx-amount" inputMode="decimal" placeholder="0.00" className="w-36"
                value={fxForm.amount}
                onChange={(e) => setFxForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fx-currency">Currency</Label>
              <Select
                id="fx-currency" className="w-28"
                value={fxForm.currency}
                onChange={(e) => setFxForm((f) => ({ ...f, currency: e.target.value }))}
              >
                {fxCurrencies.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="fx-email">Payer&apos;s email</Label>
              <Input
                id="fx-email" type="email" placeholder="payer@example.com"
                value={fxForm.email}
                onChange={(e) => setFxForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <Button
              disabled={busy === "fx" || !fxForm.amount || !fxForm.currency || !fxForm.email}
              onClick={raiseFx}
            >
              <CreditCard className="size-4" />
              {busy === "fx" ? "Raising…" : "Request"}
            </Button>
          </CardContent>
        </Card>
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
                      <TableCell className="text-right tabular-nums">{formatMoney(c.amount, "NGN")}</TableCell>
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
          {/*
            ⚠️ Asked directly: "What is the client funds collection page for?
            Whose funds are being collected? If tenant/owner, can they be
            separated with tabs?"

            They could not, and the page never said whose money it was. It mixed
            three different payers under one heading: service charge, rent and
            deposits are billed to a TENANT, while the "other" purpose and the
            international-payment card are raised against a vendor, a landlord
            or a client paying in another currency. The page's own copy admitted
            this ("For a tenant, vendor or client paying in a currency other than
            Naira") while the table above it showed them all together.

            Split by who is being asked, not by purpose alone, and the split is
            client-side over rows the server already scoped — no new query, and
            nothing here widens what anyone can see.
          */}
          <div className="mt-2 flex flex-wrap gap-1 text-xs">
            {(
              [
                ["all", "All", intents.length],
                ["tenant", "Tenants", tenantIntents.length],
                ["other", "Owners, vendors & other", otherIntents.length],
              ] as const
            ).map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                onClick={() => setAudience(key)}
                aria-pressed={audience === key}
                className={
                  audience === key
                    ? "rounded-full border border-transparent bg-[var(--brand)] px-2.5 py-1 font-medium text-[var(--brand-fg)]"
                    : "rounded-full border border-border px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                }
              >
                {label} <span className="tabular-nums opacity-80">{n}</span>
              </button>
            ))}
            <a
              href={`/api/records/export?type=collections&audience=${audience}`}
              download
              className="ml-auto rounded-md border border-border px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Download this list (CSV)
            </a>
          </div>
        </CardHeader>
        <CardContent>
          {shownIntents.length === 0 ? (
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
                  {shownIntents.map((i) => {
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
                          {formatMoney(i.amount_expected, i.currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {i.amount_paid == null ? "—" : formatMoney(i.amount_paid, i.currency)}
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

      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </div>
  );
}

/** Simulated checkout links are relative; a copied link has to work anywhere. */
function absolute(url: string) {
  return url.startsWith("http") ? url : `${window.location.origin}${url}`;
}
