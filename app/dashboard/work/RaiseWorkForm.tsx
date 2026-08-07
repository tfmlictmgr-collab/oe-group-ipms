"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, ClipboardPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { raiseWorkOrder } from "./actions";

export type Option = { id: string; label: string; propertyId?: string };

const CATEGORIES = ["maintenance", "vendor", "complaint", "general"] as const;
const URGENCIES = [
  ["low", "Low — cosmetic, no rush"],
  ["normal", "Normal"],
  ["high", "High — worsening or significant loss of use"],
  ["critical", "Critical — unsafe, or a whole building affected"],
] as const;

export default function RaiseWorkForm({
  properties,
  assets,
  vendors,
}: {
  properties: Option[];
  assets: Option[];
  vendors: Option[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [propertyId, setPropertyId] = React.useState(properties[0]?.id ?? "");
  const [summary, setSummary] = React.useState("");
  const [detail, setDetail] = React.useState("");
  const [category, setCategory] = React.useState<string>("maintenance");
  const [urgency, setUrgency] = React.useState<string>("normal");
  const [assetId, setAssetId] = React.useState("");
  const [vendorId, setVendorId] = React.useState("");

  // Only assets ON the chosen property — the function refuses others, and a
  // picker offering them would be a control built to be rejected.
  const assetsHere = assets.filter((a) => a.propertyId === propertyId);

  React.useEffect(() => {
    if (assetId && !assetsHere.some((a) => a.id === assetId)) setAssetId("");
  }, [propertyId, assetId, assetsHere]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await runAction(
        raiseWorkOrder({
          propertyId, summary,
          detail: detail || null,
          category, urgency,
          assetId: assetId || null,
          vendorId: vendorId || null,
        })
      );
      toast.success(vendorId ? "Work raised and dispatched" : "Work raised", {
        description: vendorId
          ? "The contractor has been notified."
          : "It is open for dispatch.",
      });
      router.push(`/dashboard/tickets/${r.id}`);
    } catch (err) {
      toast.error(messageOf(err, "That work order could not be raised."), {
        description: hintOf(err), duration: Infinity, closeButton: true,
      });
      setBusy(false);
    }
  }

  if (properties.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        You do not manage any properties yet, so there is nowhere to raise work against.
        Ask an administrator to attach you to one, or add a property from the Properties
        page.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="w-prop">Property</Label>
        <select
          id="w-prop" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}
          className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
        >
          {properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="w-sum">What needs doing</Label>
        <Input
          id="w-sum" value={summary} onChange={(e) => setSummary(e.target.value)}
          placeholder="e.g. Quarterly generator service" required minLength={5}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="w-detail">
          Detail <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="w-detail" value={detail} onChange={(e) => setDetail(e.target.value)}
          placeholder="Anything the contractor needs to know before arriving"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="w-cat">Category</Label>
          <select
            id="w-cat" value={category} onChange={(e) => setCategory(e.target.value)}
            className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c} className="capitalize">{c}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="w-urg">Priority</Label>
          <select
            id="w-urg" value={urgency} onChange={(e) => setUrgency(e.target.value)}
            className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
          >
            {URGENCIES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </div>
      </div>

      {assetsHere.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor="w-asset">
            Against an asset <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <select
            id="w-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}
            className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
          >
            <option value="">— not asset-specific —</option>
            {assetsHere.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="w-vendor">
          Dispatch now <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <select
          id="w-vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}
          className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
        >
          <option value="">— leave open, dispatch later —</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">
          For planned work you usually know who is doing it. Choosing a contractor here
          assigns and notifies them in the same step.
        </p>
      </div>

      <Button type="submit" variant="brand" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <ClipboardPlus />}
        {busy ? "Raising…" : vendorId ? "Raise and dispatch" : "Raise work order"}
      </Button>
    </form>
  );
}
