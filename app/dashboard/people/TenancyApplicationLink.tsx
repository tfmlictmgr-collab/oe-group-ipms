"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Check, Link2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setTenantApplicationsOpen } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

export default function TenancyApplicationLink({
  orgId,
  isOpen,
  isAdmin,
  origin,
}: {
  orgId: string;
  isOpen: boolean;
  isAdmin: boolean;
  origin: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const url = `${origin}/tenancy/${orgId}`;

  async function toggle() {
    setBusy(true);
    try {
      await runAction(setTenantApplicationsOpen(!isOpen));
      toast.success(isOpen ? "Applications closed" : "Applications open", {
        description: isOpen
          ? "The public link no longer accepts applications."
          : "Share the link with prospective tenants.",
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not update", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Link copied");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm">
          {isOpen ? (
            <>
              <Link2 className="size-4 text-success" />
              <span className="font-medium text-success">Accepting applications</span>
            </>
          ) : (
            <>
              <Lock className="size-4 text-muted-foreground" />
              <span className="font-medium text-muted-foreground">Closed</span>
            </>
          )}
        </p>
        {isAdmin && (
          <Button variant={isOpen ? "outline" : "brand"} size="sm" disabled={busy} onClick={toggle}>
            {busy ? "Working…" : isOpen ? "Close applications" : "Open applications"}
          </Button>
        )}
      </div>

      {isOpen ? (
        <div className="flex gap-2">
          <Input readOnly value={url} className="font-mono text-xs" />
          <Button type="button" variant="outline" onClick={copy} className="flex-shrink-0">
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          While closed, the public link rejects every application — so a link
          shared during one letting cannot be used months later.
        </p>
      )}

      {!isAdmin && (
        <p className="text-xs text-muted-foreground">
          Only an administrator can open or close tenancy applications.
        </p>
      )}
    </div>
  );
}
