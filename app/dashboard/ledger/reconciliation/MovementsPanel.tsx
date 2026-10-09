"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { runAction } from "@/lib/run-action";
import {
  recordGatewaySettlement, recordGatewayTopup, recordBankCharge, fundOverdrawnAccount,
} from "../movement-actions";

type Kind = "settlement" | "topup" | "charge" | "fund";
const KINDS: { key: Kind; label: string; help: string }[] = [
  { key: "settlement", label: "Gateway settlement", help: "Paystack or Flutterwave paid the day's online payments into this bank account, less its fees. Copy the figures from the gateway's settlement report." },
  { key: "topup", label: "Top-up of a gateway balance", help: "Money moved from this bank account into the Paystack balance, so payouts can be sent through Paystack." },
  { key: "charge", label: "Bank charge", help: "A charge the bank statement shows: account maintenance, transfer fees, stamp duty. Also the gateway fee on online payments taken before 9 October 2026, which were booked straight to the bank." },
  { key: "fund", label: "Fund an overdrawn account", help: "The organisation paid its own money into this account to restore a fund or payable that spent more than it held." },
];

export type OverdrawnAccount = { id: string; label: string; overdrawn: number };

const today = () => new Date().toISOString().slice(0, 10);

export default function MovementsPanel({
  bankAccountId, bankLabel, currency, gatewayBalances, overdrawn,
}: {
  bankAccountId: string;
  bankLabel: string;
  currency: string;
  gatewayBalances: { gateway: string; balance: number }[];
  overdrawn: OverdrawnAccount[];
}) {
  const router = useRouter();
  const [kind, setKind] = React.useState<Kind>("settlement");
  const [busy, setBusy] = React.useState(false);
  const [gateway, setGateway] = React.useState<"paystack" | "flutterwave">(currency === "NGN" ? "paystack" : "flutterwave");
  const [date, setDate] = React.useState(today());
  const [gross, setGross] = React.useState("");
  const [fees, setFees] = React.useState("0");
  const [amount, setAmount] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [account, setAccount] = React.useState(overdrawn[0]?.id ?? "");

  const g = Number(gross || 0), f = Number(fees || 0), a = Number(amount || 0);
  const waiting = gatewayBalances.find((b) => b.gateway === gateway)?.balance ?? 0;
  const help = KINDS.find((k) => k.key === kind)!.help;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (kind === "settlement") await runAction(recordGatewaySettlement({ bankAccountId, gateway, settledOn: date, gross: g, fees: f, reference }));
      if (kind === "topup") await runAction(recordGatewayTopup({ bankAccountId, gateway, on: date, amount: a, reference }));
      if (kind === "charge") await runAction(recordBankCharge({ bankAccountId, on: date, amount: a, reason, reference }));
      if (kind === "fund") await runAction(fundOverdrawnAccount({ accountId: account, bankAccountId, on: date, amount: a, reference, reason }));
      toast.success("Recorded in the ledger");
      setGross(""); setFees("0"); setAmount(""); setReference(""); setReason("");
      router.refresh();
    } catch (err) {
      toast.error("Not recorded", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Record money moving between accounts</CardTitle>
        <CardDescription>
          For {bankLabel} ({currency}). Each is one balanced ledger entry that cannot be edited; a mistake is corrected by a reversal.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button key={k.key} type="button" onClick={() => setKind(k.key)}
              className={k.key === kind
                ? "rounded-full border border-transparent bg-[var(--brand)] px-3 py-1 text-xs font-medium text-[var(--brand-fg)]"
                : "rounded-full border border-input px-3 py-1 text-xs text-muted-foreground hover:bg-accent"}>
              {k.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{help}</p>

        {gatewayBalances.length > 0 && (kind === "settlement" || kind === "topup") && (
          <p className="text-xs text-muted-foreground">
            Waiting at the gateway per the ledger:{" "}
            {gatewayBalances.map((b) => `${b.gateway === "paystack" ? "Paystack" : "Flutterwave"} ${formatMoney(b.balance, currency)}`).join(" · ")}.
            Compare it with the balance on the gateway&apos;s own dashboard.
          </p>
        )}

        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          {(kind === "settlement" || kind === "topup") && (
            <div className="space-y-1.5">
              <Label htmlFor="mv-gw">Gateway</Label>
              <Select id="mv-gw" value={gateway} onChange={(e) => setGateway(e.target.value as "paystack" | "flutterwave")}>
                <option value="paystack">Paystack</option>
                <option value="flutterwave">Flutterwave</option>
              </Select>
            </div>
          )}
          {kind === "fund" && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="mv-acct">Overdrawn account</Label>
              {overdrawn.length === 0 ? (
                <p className="text-sm text-muted-foreground">No account in {currency} is overdrawn.</p>
              ) : (
                <Select id="mv-acct" value={account} onChange={(e) => setAccount(e.target.value)}>
                  {overdrawn.map((o) => (
                    <option key={o.id} value={o.id}>{o.label} — overdrawn by {formatMoney(o.overdrawn, currency)}</option>
                  ))}
                </Select>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="mv-date">{kind === "settlement" ? "Settled on" : "Date"}</Label>
            <Input id="mv-date" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
          </div>
          {kind === "settlement" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mv-gross">Transactions settled (gross)</Label>
                <Input id="mv-gross" inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mv-fees">Gateway fees</Label>
                <Input id="mv-fees" inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} placeholder="0.00" />
              </div>
              <p className="self-end text-sm">
                Reaches the bank: <b className="tabular-nums">{formatMoney(Math.max(g - f, 0), currency)}</b>
                {g > waiting && <span className="block text-xs text-destructive">More than the ledger shows waiting ({formatMoney(waiting, currency)}).</span>}
              </p>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="mv-amt">Amount</Label>
              <Input id="mv-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="mv-ref">{kind === "settlement" ? "Settlement reference" : "Bank reference"}{kind === "charge" ? " (optional)" : ""}</Label>
            <Input id="mv-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          {(kind === "charge" || kind === "fund") && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="mv-why">{kind === "charge" ? "What the charge was" : "Where the money came from"}</Label>
              <Input id="mv-why" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={kind === "charge" ? "e.g. Paystack fee on 8 Oct collections" : "e.g. Transfer from the branch operating account"} />
            </div>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" variant="brand" disabled={busy || (kind === "fund" && overdrawn.length === 0)}>
              {busy ? "Recording…" : "Record"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
