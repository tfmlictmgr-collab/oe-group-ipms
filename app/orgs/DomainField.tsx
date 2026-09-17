"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Globe, Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { runAction, describeError } from "@/lib/run-action";
import { setOrgDomain } from "./actions";

/**
 * The hostname an organisation answers on, editable in place.
 *
 * Lives on the operator launcher and nowhere else: binding a domain is a
 * platform act (`set_org_domain` is operator-only and audited), because a tenant
 * able to set its own could claim a hostname belonging to another tenant.
 */
export default function DomainField({
  orgId,
  domain,
}: {
  orgId: string;
  domain: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(domain ?? "");
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    try {
      await runAction(
        setOrgDomain(
          orgId,
          value,
          value.trim()
            ? `Binding ${value.trim()} to this organisation.`
            : "Releasing this organisation's hostname."
        )
      );
      toast.success(value.trim() ? `Now answering on ${value.trim()}` : "Hostname released", {
        description: value.trim()
          ? "Point a CNAME at the deployment and add the domain in Vercel for this to serve."
          : undefined,
      });
      setEditing(false);
      router.refresh();
    } catch (err) {
      toast.error("Could not set that domain", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); setEditing(true); }}
        className="relative flex items-center gap-1.5 truncate text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Globe className="size-3 flex-shrink-0" />
        <span className="truncate">{domain || "No domain bound"}</span>
      </button>
    );
  }

  return (
    <div
      className="relative flex items-center gap-1"
      onClick={(e) => e.preventDefault()}
    >
      <Input
        autoFocus
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          if (e.key === "Escape") { setEditing(false); setValue(domain ?? ""); }
        }}
        placeholder="portal.example.com"
        className="h-7 text-[11px]"
      />
      <Button type="button" size="icon-sm" variant="brand" disabled={busy} onClick={save} title="Bind">
        <Check />
      </Button>
      <Button
        type="button" size="icon-sm" variant="ghost"
        onClick={() => { setEditing(false); setValue(domain ?? ""); }}
        title="Cancel"
      >
        <X />
      </Button>
    </div>
  );
}
