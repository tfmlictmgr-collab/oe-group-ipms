"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Landmark, ShieldCheck, TriangleAlert, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { runAction, describeError } from "@/lib/run-action";
import { saveVendorPayoutRecipient, listBanks } from "./payout-actions";

export type ExistingRecipient = {
  display_name: string;
  bank_name: string | null;
  account_number_last4: string | null;
  verified_at: string | null;
} | null;

export default function PayoutRecipientForm({
  vendorId,
  vendorName,
  existing,
  canEdit,
}: {
  vendorId: string;
  vendorName: string;
  existing: ExistingRecipient;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [banks, setBanks] = React.useState<{ code: string; name: string }[]>([]);
  const [bankCode, setBankCode] = React.useState("");
  const [accountNumber, setAccountNumber] = React.useState("");
  const [accountName, setAccountName] = React.useState(vendorName);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(!existing);

  React.useEffect(() => {
    if (!canEdit || !open) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await runAction(listBanks());
        if (!cancelled) setBanks(list);
      } catch {
        // The picker degrades to empty; the action re-validates anyway.
      }
    })();
    return () => { cancelled = true; };
  }, [canEdit, open]);

  async function save() {
    setBusy(true);
    try {
      const r = await runAction(
        saveVendorPayoutRecipient({ vendorId, accountNumber, bankCode, accountName })
      );
      if (r.nameMatches) {
        toast.success("Bank details verified", {
          description: `${r.resolvedName} ····${r.last4}`,
        });
      } else {
        // Not blocked — a trading name legitimately differs from a registered
        // one — but it must be seen before money moves.
        toast.warning("Verified, but the name differs", {
          description: `The bank holds this account as "${r.resolvedName}". Check it is the right account before any payment is sent.`,
          duration: Infinity,
          closeButton: true,
        });
      }
      setAccountNumber("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error("Could not save those details", {
        description: describeError(e),
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Landmark className="size-4 text-brand" />
        <p className="text-sm font-medium">Where this vendor is paid</p>
        {existing ? (
          <Badge variant="success">Verified</Badge>
        ) : (
          <Badge variant="warning">Not set — cannot be paid</Badge>
        )}
      </div>

      {existing && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="font-medium">{existing.display_name}</p>
          <p className="text-xs text-muted-foreground">
            {existing.bank_name ?? "Bank on file"} ····{existing.account_number_last4}
          </p>
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3 flex-shrink-0" />
            The account number itself is held by the payment gateway, not by this
            system. Only the last four digits are stored here.
          </p>
        </div>
      )}

      {!canEdit ? (
        <p className="text-xs text-muted-foreground">
          Only an administrator can change bank details.
        </p>
      ) : !open ? (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Replace bank details
        </Button>
      ) : (
        <div className="space-y-4 rounded-md border border-border p-4">
          {existing && (
            <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 flex-shrink-0 text-warning" />
              Saving new details supersedes the current account. Past remittances
              keep pointing at the account they were actually sent to.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pr-bank">Bank</Label>
              <Select id="pr-bank" value={bankCode} onChange={(e) => setBankCode(e.target.value)}>
                <option value="">— choose a bank —</option>
                {banks.map((b) => (
                  <option key={b.code} value={b.code}>{b.name}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pr-acct">Account number</Label>
              <Input
                id="pr-acct" inputMode="numeric" maxLength={10}
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ""))}
                placeholder="10 digits"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pr-name">Account name as you expect it</Label>
              <Input
                id="pr-name" value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Checked against what the bank actually holds. A mismatch is shown
                to you rather than silently accepted.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="brand" size="sm"
              disabled={busy || accountNumber.length !== 10 || !bankCode}
              onClick={save}
            >
              <CheckCircle2 className="size-4" />
              {busy ? "Checking with the bank…" : "Verify and save"}
            </Button>
            {existing && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
