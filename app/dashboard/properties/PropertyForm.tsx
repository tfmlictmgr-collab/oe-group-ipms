"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runAction, describeError } from "@/lib/run-action";
import HierarchyPicker, { type OrgNode } from "@/components/patterns/hierarchy-picker";
import { saveProperty } from "./actions";

export type { OrgNode };

export default function PropertyForm({
  property,
  nodes = [],
}: {
  property?: {
    id: string;
    name: string;
    reference: string | null;
    address: string | null;
    property_type: string | null;
    site_node_id: string | null;
  };
  nodes?: OrgNode[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({
    name: property?.name ?? "",
    reference: property?.reference ?? "",
    address: property?.address ?? "",
    propertyType: property?.property_type ?? "",
  });
  const [siteNodeId, setSiteNodeId] = React.useState(property?.site_node_id ?? "");

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await runAction(saveProperty({ id: property?.id, ...form, siteNodeId: siteNodeId || null }));
      toast.success(property ? "Property updated" : "Property added");
      router.push(`/dashboard/properties/${r.id}`);
      router.refresh();
    } catch (err) {
      toast.error("Could not save", {
        description: describeError(err),
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="p-name">Name</Label>
          <Input id="p-name" required value={form.name} onChange={set("name")}
                 placeholder="e.g. Lekki Gardens Estate" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-ref">
            Reference <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input id="p-ref" value={form.reference} onChange={set("reference")}
                 placeholder="Your own code, e.g. LGE-01" />
          <p className="text-xs text-muted-foreground">
            Must be unique — a reference that means two properties is worse than none.
          </p>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-addr">Address</Label>
          <Input id="p-addr" value={form.address} onChange={set("address")}
                 placeholder="Street, area, city" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-type">
            Type <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input id="p-type" value={form.propertyType} onChange={set("propertyType")}
                 placeholder="e.g. Residential estate, Office tower" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>
          Region &amp; site <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <p className="text-xs text-muted-foreground">
          A property is filed under a site. Leaving it unfiled changes
          nothing about what the property can do — it just won&apos;t appear
          in a regional report until someone files it.
        </p>
        <HierarchyPicker nodes={nodes} value={siteNodeId} onChange={setSiteNodeId} stopAtLevel="site" />
      </div>

      <div className="flex gap-2">
        <Button type="submit" variant="brand" disabled={busy || form.name.trim().length < 2}>
          {busy ? "Saving…" : property ? "Save changes" : "Add property"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}
