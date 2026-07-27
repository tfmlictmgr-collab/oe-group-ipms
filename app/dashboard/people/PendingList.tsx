"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X, Check, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { roleLabel } from "@/lib/roles";
import { revokeInvitation, setVendorApproval } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

export function PendingInvites({
  invites,
  brand,
}: {
  invites: { id: string; email: string; role: string; expires_at: string }[];
  brand: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function revoke(id: string) {
    setBusy(id);
    try {
      await runAction(revokeInvitation(id));
      toast.success("Invitation revoked");
      router.refresh();
    } catch (e) {
      toast.error("Could not revoke", {
        description: describeError(e),
      });
    } finally {
      setBusy(null);
    }
  }

  if (invites.length === 0) {
    return <p className="text-sm text-muted-foreground">No invitations awaiting acceptance.</p>;
  }

  return (
    <ul className="space-y-2">
      {invites.map((i) => {
        const days = Math.ceil((new Date(i.expires_at).getTime() - Date.now()) / 86_400_000);
        return (
          <li
            key={i.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{i.email}</p>
              <p className="text-xs text-muted-foreground">
                {roleLabel(i.role, brand)} · expires in {days} day{days === 1 ? "" : "s"}
              </p>
            </div>
            <Button
              variant="ghost" size="sm" disabled={busy === i.id}
              onClick={() => revoke(i.id)}
            >
              <X /> Revoke
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function VendorApprovals({
  vendors,
}: {
  vendors: { id: string; name: string; service_category: string | null; contact_email: string | null }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    try {
      await runAction(setVendorApproval(id, approve));
      toast.success(approve ? "Vendor approved" : "Vendor rejected", {
        description: approve
          ? "They can now be assigned work and paid."
          : "They remain on record but cannot be assigned work.",
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not update vendor", {
        description: describeError(e),
      });
    } finally {
      setBusy(null);
    }
  }

  if (vendors.length === 0) {
    return <p className="text-sm text-muted-foreground">No vendors awaiting approval.</p>;
  }

  return (
    <ul className="space-y-2">
      {vendors.map((v) => (
        <li
          key={v.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{v.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[v.service_category, v.contact_email].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
          <div className="flex flex-shrink-0 gap-2">
            <Badge variant="warning">Pending</Badge>
            <Button variant="outline" size="sm" disabled={busy === v.id} onClick={() => decide(v.id, false)}>
              <Ban /> Reject
            </Button>
            <Button variant="brand" size="sm" disabled={busy === v.id} onClick={() => decide(v.id, true)}>
              <Check /> Approve
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
