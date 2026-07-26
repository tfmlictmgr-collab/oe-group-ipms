"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Landmark, ShieldCheck, Plus, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatNaira } from "@/lib/currency";
import {
  ensureChartOfAccounts,
  saveBankAccount,
  recordOpeningBalance,
} from "./bank-actions";

export type LedgerAccountOption = { id: string; code: string; name: string };

export type BankAccount = {
  id: string;
  label: string;
  bank_name: string | null;
  account_name: string | null;
  account_number_last4: string | null;
  purpose: string;
  opening_balance: number | string;
  opening_date: string | null;
  opening_entry_id: string | null;
  ledger_account_id: string | null;
} | null;

export default function BankAccountForm({
  account,
  liabilityAccounts,
  hasChart,
}: {
  account: BankAccount;
  liabilityAccounts: LedgerAccountOption[];
  hasChart: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const [form, setForm] = React.useState({
    label: account?.label ?? "Client funds account",
    bankName: account?.bank_name ?? "",
    accountName: account?.account_name ?? "",
    accountNumberLast4: account?.account_number_last4 ?? "",
  });

  const [asOf, setAsOf] = React.useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = React.useState<{ accountId: string; amount: string }[]>([
    { accountId: "", amount: "" },
  ]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const allocTotal = rows.reduce((s, r) => s + (Number(r.amount.replace(/[,\s₦]/g, "")) || 0), 0);
  const openingRecorded = Boolean(account?.opening_entry_id);

  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      router.refresh();
    } catch (e) {
      toast.error("Couldn't save", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setBusy(false);
    }
  }

  if (!hasChart) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Set up the standard chart of accounts first — client funds, landlord and
          vendor payables, deposits, service-charge funds and fee income. You can
          add per-landlord and per-vendor accounts later as they appear.
        </p>
        <Button
          variant="brand"
          disabled={busy}
          onClick={() => run(ensureChartOfAccounts, "Chart of accounts created")}
        >
          <Plus /> Set up chart of accounts
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── The account itself ────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Landmark className="size-4 text-brand" />
          <p className="text-sm font-medium">Client-funds account</p>
          {account ? (
            account.bank_name && account.account_number_last4 ? (
              <Badge variant="success">Configured</Badge>
            ) : (
              <Badge variant="warning">Placeholder — details pending</Badge>
            )
          ) : (
            <Badge variant="muted">Not set up</Badge>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          The separate account holding money that belongs to tenants, landlords
          and owners — kept apart from the organisation&apos;s own operating money.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ba-label">Label</Label>
            <Input id="ba-label" value={form.label} onChange={set("label")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ba-bank">
              Bank <span className="font-normal text-muted-foreground">(optional for now)</span>
            </Label>
            <Input id="ba-bank" value={form.bankName} onChange={set("bankName")} placeholder="e.g. GTBank" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ba-name">
              Account name <span className="font-normal text-muted-foreground">(optional for now)</span>
            </Label>
            <Input
              id="ba-name"
              value={form.accountName}
              onChange={set("accountName")}
              placeholder="e.g. TFML Client Funds"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ba-last4">Last 4 digits</Label>
            <Input
              id="ba-last4"
              value={form.accountNumberLast4}
              onChange={set("accountNumberLast4")}
              inputMode="numeric"
              maxLength={4}
              placeholder="1234"
            />
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3 flex-shrink-0" />
              Last four only. The app never initiates transfers from stored
              details, so the full number would be risk with no benefit.
            </p>
          </div>
        </div>

        <Button
          variant="brand"
          disabled={busy}
          onClick={() =>
            run(
              () => saveBankAccount({ id: account?.id, purpose: "client_funds", ...form }),
              account ? "Bank account updated" : "Bank account added"
            )
          }
        >
          {account ? "Save changes" : "Add account"}
        </Button>
      </div>

      {/* ── Opening balance ───────────────────────────────────────────── */}
      {account && (
        <>
          <Separator />
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Opening balance</p>
              {openingRecorded ? (
                <Badge variant="success">
                  Recorded {account.opening_date} · {formatNaira(account.opening_balance)}
                </Badge>
              ) : (
                <Badge variant="warning">Not recorded</Badge>
              )}
            </div>

            {openingRecorded ? (
              <p className="text-sm text-muted-foreground">
                The ledger starts from {account.opening_date}. Because the ledger
                is append-only, changing this means posting an adjusting entry
                rather than editing history.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  What the account held on the day you start, and{" "}
                  <span className="font-medium text-foreground">whose money it is</span>.
                  Without this the ledger starts at zero and every reconciliation
                  reports the same permanent difference.
                </p>
                <p className="text-xs text-muted-foreground">
                  Brand-new empty account? Leave this — there&apos;s nothing to record.
                </p>

                <div className="space-y-1.5 sm:max-w-[14rem]">
                  <Label htmlFor="ba-asof">As at</Label>
                  <Input id="ba-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
                </div>

                <div className="space-y-2">
                  <Label>Who the money belongs to</Label>
                  {rows.map((r, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Select
                        aria-label="Allocation account"
                        value={r.accountId}
                        onChange={(e) =>
                          setRows((rs) => rs.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))
                        }
                        className="min-w-0 flex-1"
                      >
                        <option value="">— choose —</option>
                        {liabilityAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </Select>
                      <Input
                        aria-label="Amount"
                        value={r.amount}
                        onChange={(e) =>
                          setRows((rs) => rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                        }
                        placeholder="0"
                        inputMode="decimal"
                        className="w-40"
                      />
                      {rows.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove row"
                          onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRows((rs) => [...rs, { accountId: "", amount: "" }])}
                  >
                    <Plus /> Add allocation
                  </Button>
                </div>

                <div className="flex items-center justify-between rounded-md bg-muted/60 px-4 py-3">
                  <span className="text-sm text-muted-foreground">
                    Total — must equal the bank balance on that date
                  </span>
                  <span className="text-lg font-semibold tabular-nums">
                    {formatNaira(allocTotal)}
                  </span>
                </div>

                {allocTotal > 0 && (
                  <p className="flex items-start gap-2 rounded-md bg-warning/10 p-3 text-xs">
                    <AlertTriangle className="mt-0.5 size-3.5 flex-shrink-0 text-warning" />
                    This posts a permanent ledger entry. Check the figures against
                    a statement first — corrections have to be adjusting entries.
                  </p>
                )}

                <Button
                  variant="brand"
                  disabled={busy || allocTotal <= 0}
                  onClick={() =>
                    run(
                      () =>
                        recordOpeningBalance(
                          account.id,
                          asOf,
                          rows.map((r) => ({
                            accountId: r.accountId,
                            amount: Number(r.amount.replace(/[,\s₦]/g, "")) || 0,
                          }))
                        ),
                      "Opening balance recorded"
                    )
                  }
                >
                  Record opening balance
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
