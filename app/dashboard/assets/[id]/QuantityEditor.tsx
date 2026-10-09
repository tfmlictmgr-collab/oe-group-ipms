"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runAction, describeError } from "@/lib/run-action";
import { setAssetQuantity } from "../actions";

/**
 * The count of identical items a register row stands for (0326), editable in
 * place. There is no full asset edit screen, and every asset filed before the
 * column existed reads 1, so without this the count could only be set on new
 * rows. The write runs in the caller's session: `assets_update` decides.
 */
export default function QuantityEditor({ assetId, quantity }: { assetId: string; quantity: number }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(String(quantity));
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await runAction(setAssetQuantity(assetId, value));
      toast.success("Quantity updated");
      setEditing(false);
      router.refresh();
    } catch (err) {
      toast.error("Could not update the quantity", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="tabular-nums">{quantity.toLocaleString()}</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Change the quantity"
          title="Change the quantity"
        >
          <Pencil className="size-3.5" />
        </button>
      </span>
    );
  }

  return (
    <form onSubmit={save} className="flex items-center gap-2">
      <Input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-8 w-24"
        aria-label="Quantity"
        autoFocus
      />
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => { setEditing(false); setValue(String(quantity)); }}
      >
        Cancel
      </Button>
    </form>
  );
}
