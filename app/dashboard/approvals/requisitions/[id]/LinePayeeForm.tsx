"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { saveRequisitionLinePayee } from "@/app/dashboard/requisitions/actions";
import { listBanks } from "@/app/dashboard/vendors/[id]/payout-actions";

/** Bank details for a line with no registered vendor — verified the same way a vendor's own account is (0172). */
export default function LinePayeeForm({ lineId, defaultName }: { lineId: string; defaultName: string }) {
  const router = useRouter();
  const [banks, setBanks] = React.useState<{ code: string; name: string }[]>([]);
  const [bankCode, setBankCode] = React.useState("");
  const [accountNumber, setAccountNumber] = React.useState("");
  const [accountName, setAccountName] = React.useState(defaultName);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await runAction(listBanks());
        if (!cancelled) setBanks(list);
      } catch {
        // Degrades to an empty picker; the action re-validates regardless.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function save() {
    setBusy(true);
    try {
      const r = await runAction(
        saveRequisitionLinePayee({ lineId, accountNumber, bankCode, accountName })
      );
      toast.success(`Verified: ${r.resolvedName}`, {
        description: r.nameMatches ? undefined : "The bank's name on this account differs from what you typed — check it is the right account.",
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not verify that account", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Landmark className="size-3.5" /> No payee yet — add verified bank details
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Select value={bankCode} onChange={(e) => setBankCode(e.target.value)}>
          <option value="">Bank…</option>
          {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
        </Select>
        <Input
          value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)}
          placeholder="10-digit account number" maxLength={10}
        />
        <Input
          value={accountName} onChange={(e) => setAccountName(e.target.value)}
          placeholder="Account holder's name"
        />
      </div>
      <Button
        type="button" size="sm" variant="outline" disabled={busy || !bankCode || accountNumber.length !== 10}
        onClick={save}
      >
        {busy ? "Verifying…" : "Verify and save"}
      </Button>
    </div>
  );
}
