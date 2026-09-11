"use client";

import * as React from "react";
import { Plus, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import BankAccountForm, { type BankAccount, type LedgerAccountOption } from "./BankAccountForm";

/**
 * One client-funds card per currency the org actually holds an account in,
 * plus NGN always (the default, per decision 15), plus an affordance to add
 * one of the remaining supported currencies — this is the FX-collections
 * enablement point B3 and CLAUDE.md's open question 4 ("are any tenants/
 * vendors invoiced in USD/GBP/EUR") actually needed: nothing here assumes an
 * org wants Flutterwave, it just stops refusing to let one turn it on.
 */
export default function CurrencyAccountsManager({
  accounts,
  ledgerAccounts,
  hasChart,
}: {
  accounts: BankAccount[];
  ledgerAccounts: LedgerAccountOption[];
  hasChart: boolean;
}) {
  const configured = new Set(accounts.filter(Boolean).map((a) => a!.currency));
  // NGN always has a card — it is the default and every org starts here.
  const shown = Array.from(new Set(["NGN"].concat(Array.from(configured))));

  const [adding, setAdding] = React.useState<string[]>([]);
  const [pick, setPick] = React.useState("");

  // Once a currency's account is actually saved, it moves from "adding" (a
  // blank in-progress form) to "shown" (the real, server-fetched card) on the
  // next `router.refresh()`. Filtered here rather than removed via an effect,
  // so the two lists can never both render the same currency even for one
  // frame — `configured` already reflects the freshly-revalidated server data
  // by the time this component re-renders.
  const stillAdding = adding.filter((c) => !configured.has(c));

  const available = SUPPORTED_CURRENCIES.filter(
    (c) => !shown.includes(c) && !stillAdding.includes(c)
  );

  return (
    <div className="space-y-6">
      {shown.map((currency, i) => {
        const account = accounts.find((a) => a?.currency === currency) ?? null;
        return (
          <React.Fragment key={currency}>
            {i > 0 && <Separator />}
            <BankAccountForm
              account={account}
              currency={currency}
              hasChart={hasChart}
              liabilityAccounts={ledgerAccounts.filter(
                (a) => a.currency === currency
              )}
            />
          </React.Fragment>
        );
      })}

      {stillAdding.map((currency, i) => (
        <React.Fragment key={currency}>
          {(shown.length > 0 || i > 0) && <Separator />}
          <BankAccountForm
            account={null}
            currency={currency}
            hasChart={hasChart}
            liabilityAccounts={ledgerAccounts.filter((a) => a.currency === currency)}
          />
        </React.Fragment>
      ))}

      {available.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Globe2 className="size-4 text-muted-foreground" />
              <p className="text-sm font-medium">Add a foreign-currency account</p>
            </div>
            <p className="text-xs text-muted-foreground">
              For international collections via Flutterwave (B3) — a client or
              tenant paying in a currency other than Naira. This is a
              separate, independently-segregated balance; it is never mixed
              with the Naira figures above.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Currency to add"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                className="w-40"
              >
                <option value="">— choose —</option>
                {available.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
              <Button
                type="button" variant="outline" size="sm" disabled={!pick}
                onClick={() => {
                  if (pick) setAdding((a) => [...a, pick]);
                  setPick("");
                }}
              >
                <Plus /> Add
              </Button>
            </div>
          </div>
        </>
      )}

      {shown.length === 1 && shown[0] === "NGN" && !configured.has("NGN") && (
        <Card className="border-dashed">
          <CardContent className="p-4 text-xs text-muted-foreground">
            Naira is set up by default and needs no separate enablement — fill
            in the card above when the real account details are ready.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
