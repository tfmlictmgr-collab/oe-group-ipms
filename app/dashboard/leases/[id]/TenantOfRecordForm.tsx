"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runAction, describeError } from "@/lib/run-action";
import { recordTenantOfRecord } from "../actions";

/**
 * Names the tenant of a tenancy no portal account holds — a company let, an
 * imported tenancy, or one recorded before decision 37 gave a lease anywhere
 * to keep a name. Offered only to a viewer holding `leases.write`; the action
 * re-checks through RLS regardless.
 */
export default function TenantOfRecordForm({
  leaseId,
  name,
  phone,
}: {
  leaseId: string;
  name: string | null;
  phone: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(!name);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ name: name ?? "", phone: phone ?? "" });

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 mt-1 h-7"
        data-print="screen-only"
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-3.5" /> Correct
      </Button>
    );
  }

  async function save() {
    setBusy(true);
    try {
      await runAction(recordTenantOfRecord(leaseId, form));
      toast.success("Tenant recorded", {
        description: "The tenancy schedule and the directory now name them.",
      });
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error("Could not record the tenant", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-3" data-print="screen-only">
      <div className="space-y-1">
        <Label htmlFor="tor-name" className="text-xs">Tenant&apos;s name</Label>
        <Input
          id="tor-name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="A person or a company, as on the tenancy"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="tor-phone" className="text-xs">
          Phone <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="tor-phone"
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          inputMode="tel"
          placeholder="e.g. 0803 000 0000"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        For a tenant with no portal account. If they should have one, invite them
        from People — their account then names them instead.
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="brand" disabled={busy} onClick={save}>
          Save
        </Button>
        {name && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
