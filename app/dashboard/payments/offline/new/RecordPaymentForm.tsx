"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, Loader2, ShieldCheck, AlertTriangle, X, Copy } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formatMoney } from "@/lib/currency";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import {
  PROOF_ACCEPT, PROOF_BUCKET, PROOF_RULES, METHOD_LABEL, METHOD_HINT,
  proofPath, proofProblem, type OfflineMethod, type AllocationInput,
} from "@/lib/offline-payments";
import { recordOfflinePayment } from "../actions";
import { listBanks, resolveBankAccount } from "@/lib/bank-actions";

export type ChargeOption = {
  kind: "rent" | "service_charge";
  charge_id: string;
  label: string;
  period: string | null;
  due_date: string | null;
  amount: number | string;
  outstanding: number | string;
  currency: string;
  property_id: string;
  property_name: string;
  unit_id: string | null;
  unit_label: string | null;
  payer_user_id: string | null;
  is_own: boolean;
};

export type AccountOption = {
  id: string;
  label: string;
  bank_name: string | null;
  account_name: string | null;
  account_number_last4: string | null;
  /** The full number, published so a payer can transfer into it (0286). */
  published_account_number: string | null;
  currency: string;
};

const today = () => new Date().toISOString().slice(0, 10);
const n2 = (v: string) => Math.round((Number(v) || 0) * 100) / 100;

export default function RecordPaymentForm({
  charges, accounts, orgId, preselectRent, preselectSc,
}: {
  charges: ChargeOption[];
  accounts: AccountOption[];
  orgId: string;
  preselectRent: string | null;
  preselectSc: string | null;
}) {
  const router = useRouter();
  const supabase = createClient();

  const [method, setMethod] = React.useState<OfflineMethod>("bank_transfer");
  const [paidOn, setPaidOn] = React.useState(today());
  const [bankId, setBankId] = React.useState(accounts[0]?.id ?? "");
  const [payerRef, setPayerRef] = React.useState("");
  const [note, setNote] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Where the money came FROM (0286).
  const [banks, setBanks] = React.useState<{ code: string; name: string }[]>([]);
  const [payerBankCode, setPayerBankCode] = React.useState("");
  const [payerAccountNumber, setPayerAccountNumber] = React.useState("");
  const [payerAccountName, setPayerAccountName] = React.useState("");
  const [payerLast4, setPayerLast4] = React.useState("");
  const [resolving, setResolving] = React.useState(false);
  const [resolveProblem, setResolveProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await listBanks();
      if (!cancelled && r.ok) setBanks(r.data);
    })();
    return () => { cancelled = true; };
  }, []);

  // ⚠️ Debounced, and only once BOTH halves are present. Resolution is a paid
  // third-party call; firing it per keystroke would bill for nine useless
  // lookups on the way to a ten-digit number.
  React.useEffect(() => {
    if (payerBankCode === "" || payerAccountNumber.length !== 10) {
      setResolveProblem(null);
      return;
    }
    let cancelled = false;
    setResolving(true);
    setResolveProblem(null);
    const t = setTimeout(() => {
      void (async () => {
        const r = await resolveBankAccount({
          accountNumber: payerAccountNumber, bankCode: payerBankCode,
        });
        if (cancelled) return;
        setResolving(false);
        if (r.ok) {
          setPayerAccountName(r.data.accountName);
          setPayerLast4(r.data.last4);
        } else {
          // NOT a blocker. A person whose bank cannot be reached must still be
          // able to report a payment they really made — the receipt is the
          // evidence, and this field is a convenience for whoever matches it.
          setPayerAccountName("");
          setPayerLast4(payerAccountNumber.slice(-4));
          setResolveProblem(r.message);
        }
      })();
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [payerBankCode, payerAccountNumber]);

  const destination = accounts.find((a) => a.id === bankId) ?? null;

  // Which charges are being paid, and how much against each. Seeded from the
  // link the person followed — arriving from "I paid this one another way"
  // should not mean hunting for it again in a list.
  const [alloc, setAlloc] = React.useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    const pre = charges.find(
      (c) => (preselectRent && c.charge_id === preselectRent) ||
             (preselectSc && c.charge_id === preselectSc)
    );
    if (pre) seed[pre.charge_id] = String(Number(pre.outstanding));
    return seed;
  });

  const currency = accounts.find((a) => a.id === bankId)?.currency ?? "NGN";
  const eligible = charges.filter((c) => (c.currency ?? "NGN") === currency);

  const lines = Object.entries(alloc)
    .map(([id, v]) => ({ charge: charges.find((c) => c.charge_id === id)!, amount: n2(v) }))
    .filter((l) => l.charge && l.amount > 0);

  const total = lines.reduce((t, l) => t + l.amount, 0);

  // The amount is the sum of the breakdown, shown rather than typed twice.
  // ⚠️ The database checks them against each other anyway (0281's deferred
  // constraint); deriving it here just means the two can never disagree on the
  // way in, so nobody meets that refusal for a reason they cannot see.
  const overAllocated = lines.filter(
    (l) => l.amount > Number(l.charge.outstanding) + 0.001
  );

  const fileProblem = file ? proofProblem(file) : null;
  const ready =
    !!bankId && !!file && !fileProblem && lines.length > 0 &&
    total > 0 && overAllocated.length === 0 && !!paidOn;

  function setLine(id: string, v: string) {
    setAlloc((prev) => {
      const next = { ...prev };
      if (!v || Number(v) === 0) delete next[id];
      else next[id] = v;
      return next;
    });
  }

  async function submit() {
    if (!ready || !file) return;
    setBusy(true);
    let uploaded: string | null = null;
    try {
      // ⚠️ The proof is uploaded BEFORE the claim, because the claim requires a
      // path and 0281 checks the object actually exists. `upsert: false` — the
      // bucket has no UPDATE policy on purpose (evidence is written once), and
      // an upsert would be refused with a message that reads like an outage.
      const path = proofPath(orgId, crypto.randomUUID(), file.name);
      const { error: upErr } = await supabase.storage
        .from(PROOF_BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw new Error(`Your proof could not be uploaded: ${upErr.message}`);
      uploaded = path;

      const allocations: AllocationInput[] = lines.map((l) => ({
        purpose: l.charge.kind,
        rent_charge_id: l.charge.kind === "rent" ? l.charge.charge_id : null,
        service_charge_id: l.charge.kind === "service_charge" ? l.charge.charge_id : null,
        property_id: l.charge.property_id,
        unit_id: l.charge.unit_id,
        amount: l.amount,
      }));

      const r = await runAction(
        recordOfflinePayment({
          method, amount: total, paidOn, bankAccountId: bankId,
          proofPath: path, proofFilename: file.name,
          allocations, currency,
          payerReference: payerRef.trim() || null,
          payerNote: note.trim() || null,
          payerBankName: banks.find((b) => b.code === payerBankCode)?.name ?? null,
          payerAccountName: payerAccountName || null,
          payerAccountLast4: payerLast4 || null,
        })
      );
      toast.success(`Recorded as ${r.reference}.`, {
        description: "We will check it against our account and tell you the outcome.",
      });
      router.push(`/dashboard/payments/offline/${r.claimId}`);
    } catch (e) {
      // The claim failed, so the orphan object is ours to clean up — the bucket
      // lets its own uploader delete an object no claim points at (0281).
      if (uploaded) {
        await supabase.storage.from(PROOF_BUCKET).remove([uploaded]).catch(() => {});
      }
      toast.error(messageOf(e, "That payment could not be recorded."), {
        description: hintOf(e), duration: Infinity, closeButton: true,
      });
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        {/* ── How, when, where ─────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">How you paid</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(METHOD_LABEL) as OfflineMethod[]).map((m) => (
                <button
                  key={m} type="button" onClick={() => setMethod(m)}
                  className={`rounded-lg border p-3 text-left transition ${
                    method === m ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                  }`}
                >
                  <p className="text-sm font-medium">{METHOD_LABEL[m]}</p>
                  <p className="text-xs text-muted-foreground">{METHOD_HINT[m]}</p>
                </button>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="paidOn">Date you paid</Label>
                <Input
                  id="paidOn" type="date" value={paidOn} max={today()}
                  onChange={(e) => setPaidOn(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  The date on your receipt, not today — it is how we find it on our statement.
                </p>
              </div>
              <div>
                <Label htmlFor="payerRef">Your bank/teller reference</Label>
                <Input
                  id="payerRef" value={payerRef} placeholder="Optional, but it speeds this up"
                  onChange={(e) => setPayerRef(e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="bank">
                {accounts.length > 1 ? "Which of our accounts" : "Our account"}
              </Label>
              {accounts.length > 1 ? (
                <select
                  id="bank" value={bankId} onChange={(e) => setBankId(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {[a.label, a.bank_name].filter(Boolean).join(" · ")}
                      {a.currency !== "NGN" ? ` (${a.currency})` : ""}
                    </option>
                  ))}
                </select>
              ) : null}

              {/* ⚠️ THE ACCOUNT TO PAY INTO, stated in full.
                  The board asked for the official account to be displayed, and
                  until 0286 the product could not: `bank_accounts` held only the
                  last four, which is right for an account money is sent TO and
                  useless for the one account whose number is meant to be
                  published. Somebody about to make a transfer needs the number,
                  not a masked one.

                  The NAME is the anti-fraud control (decision 36): an account
                  number can be swapped in a forwarded message; a name can be
                  checked against the bank's own confirmation screen. */}
              {destination && (
                <div className="mt-2 rounded-lg border bg-muted/40 p-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Transfer to
                  </p>
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Bank</dt>
                      <dd className="font-medium">{destination.bank_name ?? "—"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Account name</dt>
                      <dd className="text-right font-medium">{destination.account_name ?? "—"}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">Account number</dt>
                      <dd className="flex items-center gap-2">
                        <span className="font-mono font-semibold tabular-nums">
                          {destination.published_account_number
                            ?? (destination.account_number_last4
                                  ? `••••${destination.account_number_last4}`
                                  : "—")}
                        </span>
                        {destination.published_account_number && (
                          <Button
                            type="button" variant="ghost" size="sm"
                            onClick={() => {
                              void navigator.clipboard?.writeText(destination.published_account_number!);
                              toast.success("Account number copied.");
                            }}
                          >
                            <Copy className="size-3.5" />
                          </Button>
                        )}
                      </dd>
                    </div>
                  </dl>
                  {!destination.published_account_number && (
                    // Said out loud rather than silently showing a masked
                    // number nobody can pay into.
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                      The full account number has not been published yet — ask the
                      office for it, or check your demand.
                    </p>
                  )}
                  <p className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                    <span>
                      Pay only into an account in this name. We never change our
                      account details by message — if anyone tells you otherwise,
                      stop and call the office.
                    </span>
                  </p>
                </div>
              )}
            </div>

            {/* ── Where the money came from ───────────────────────────────
                What finance matches against: a bank statement line names the
                SENDER. Optional, because somebody who paid cash over a counter
                has no sending account — and because a name that cannot be
                resolved must not block a person from reporting a real payment. */}
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">The account you paid from</p>
              <p className="text-xs text-muted-foreground">
                Optional, and it helps us find your payment faster — a bank
                statement shows the sender, not the reference.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="payerBank" className="text-xs">Your bank</Label>
                  <select
                    id="payerBank" value={payerBankCode}
                    onChange={(e) => { setPayerBankCode(e.target.value); setPayerAccountName(""); }}
                    className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                  >
                    <option value="">Choose your bank…</option>
                    {banks.map((b) => (
                      <option key={b.code} value={b.code}>{b.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="payerAcct" className="text-xs">Your account number</Label>
                  <Input
                    id="payerAcct" inputMode="numeric" value={payerAccountNumber}
                    placeholder="10 digits"
                    onChange={(e) => {
                      setPayerAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 10));
                      setPayerAccountName("");
                    }}
                  />
                </div>
              </div>
              {resolving && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Checking with the bank…
                </p>
              )}
              {payerAccountName && !resolving && (
                <p className="flex items-start gap-2 rounded-md bg-emerald-500/10 p-2 text-xs">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                  <span>
                    The bank holds this account as{" "}
                    <strong>{payerAccountName}</strong>.
                  </span>
                </p>
              )}
              {resolveProblem && !resolving && (
                <p className="text-xs text-muted-foreground">{resolveProblem}</p>
              )}
              {/* ⚠️ Only the last four are ever kept. Stated to the person,
                  because being asked for a full account number without being
                  told what happens to it is exactly what a scam looks like. */}
              <p className="text-xs text-muted-foreground">
                We use this only to recognise your payment on our statement. We
                keep the bank, the name and the last four digits — never the
                full number.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── What it pays for ─────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">What the payment is for</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0 p-0">
            <p className="px-6 pb-3 text-xs text-muted-foreground">
              Put the amount you paid against each demand. Split it across more
              than one if a single transfer covered several.
            </p>
            <div className="divide-y border-t">
              {eligible.map((c) => {
                const outstanding = Number(c.outstanding);
                const v = alloc[c.charge_id] ?? "";
                const over = n2(v) > outstanding + 0.001;
                return (
                  <div key={c.charge_id} className="flex flex-wrap items-center gap-3 px-6 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {c.label}
                        {!c.is_own && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            (not your own)
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {c.kind === "rent" ? "Rent" : "Service charge"}
                        {c.period ? ` · ${c.period}` : ""} · {formatMoney(outstanding, c.currency)} outstanding
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number" min="0" step="0.01" value={v}
                        placeholder="0.00"
                        onChange={(e) => setLine(c.charge_id, e.target.value)}
                        className={`w-32 text-right tabular-nums ${over ? "border-destructive" : ""}`}
                      />
                      {v && (
                        <Button
                          type="button" variant="ghost" size="icon"
                          onClick={() => setLine(c.charge_id, "")}
                          aria-label="Clear"
                        >
                          <X className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {overAllocated.length > 0 && (
              <p className="flex items-start gap-2 border-t bg-destructive/5 px-6 py-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                One of your amounts is more than that demand owes. Reduce it — if
                you genuinely paid more, tell us in the note below and we will
                hold the difference on your account.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── Evidence ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Your proof of payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* ⚠️ The rules are stated BEFORE the picker. 0213's finding: the
                vendor pack put three different limits in three layers and none
                of them on the screen, so people met a silent failure. */}
            <ul className="space-y-1 text-xs text-muted-foreground">
              {PROOF_RULES.map((r) => <li key={r}>• {r}</li>)}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild variant="outline" size="sm">
                <label className="cursor-pointer">
                  <Upload className="size-4" />
                  {file ? "Choose a different file" : "Choose a file"}
                  <input
                    type="file" accept={PROOF_ACCEPT} className="sr-only"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </Button>
              {file && <span className="text-sm">{file.name}</span>}
            </div>
            {fileProblem && (
              <p className="text-xs text-destructive">{fileProblem}</p>
            )}
            <div>
              <Label htmlFor="note">Anything else we should know (optional)</Label>
              <textarea
                id="note" rows={3} value={note}
                onChange={(e) => setNote(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                placeholder="e.g. this is the first half of my annual rent, the balance follows next month."
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Summary and submit ─────────────────────────────────────────── */}
      <div className="space-y-4">
        <Card className="lg:sticky lg:top-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">You are reporting</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-2xl font-semibold tabular-nums">
              {formatMoney(total, currency)}
            </p>
            <Separator />
            {lines.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Choose what the payment is for, above.
              </p>
            ) : (
              <ul className="space-y-1 text-xs">
                {lines.map((l) => (
                  <li key={l.charge.charge_id} className="flex justify-between gap-2">
                    <span className="truncate text-muted-foreground">{l.charge.label}</span>
                    <span className="tabular-nums">{formatMoney(l.amount, currency)}</span>
                  </li>
                ))}
              </ul>
            )}
            <Separator />
            <p className="text-xs text-muted-foreground">
              This is a report, not a payment. It is checked against our bank
              account by three separate people before anything is applied to your
              account — you will be told the outcome either way.
            </p>
            <Button className="w-full" disabled={!ready || busy} onClick={submit}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Send for checking
            </Button>
            {!ready && !busy && (
              <p className="text-xs text-muted-foreground">
                {!file
                  ? "Attach your proof of payment to continue."
                  : lines.length === 0
                    ? "Say what the payment is for to continue."
                    : overAllocated.length > 0
                      ? "Reduce the amount that is over what a demand owes."
                      : "Fill in the remaining fields to continue."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
