"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runAction, describeError } from "@/lib/run-action";
import { setMfaEnforcement } from "./actions";

/**
 * Two-factor enforcement for one organisation, and how many of its people are
 * already enrolled (0308). Operator launcher only — like the approval chain,
 * an organisation cannot loosen it for itself.
 *
 * Presets rather than a date picker: the whole card is a link to the org's
 * front door, so every click inside has to `preventDefault`, and a native date
 * picker is the one control that does not survive that. A week's notice is
 * the recommended rollout; "now" is for a new organisation with nobody to warn.
 */
const PRESETS: { label: string; days: number | null }[] = [
  { label: "In 7 days", days: 7 },
  { label: "In 14 days", days: 14 },
  { label: "Now", days: 0 },
  { label: "Off", days: null },
];

export default function MfaEnforcementField({
  orgId,
  orgName,
  enforcedFrom,
  activeMembers,
  enrolledMembers,
}: {
  orgId: string;
  orgName: string;
  enforcedFrom: string | null;
  activeMembers: number;
  enrolledMembers: number;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-NG", {
      timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
  const status = enforcedFrom
    ? new Date(enforcedFrom) <= new Date()
      ? "required"
      : `required from ${fmt(enforcedFrom)}`
    : "optional";

  async function choose(days: number | null) {
    setBusy(true);
    try {
      const from = days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
      await runAction(setMfaEnforcement(orgId, from, reason));
      toast.success(
        days === null
          ? `${orgName}: two-factor is optional`
          : `${orgName}: two-factor required ${days === 0 ? "now" : `from ${fmt(from!)}`}`,
        { description: "Recorded with your reason on the operator log." }
      );
      setReason("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error("Could not change two-factor enforcement", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); setOpen(true); }}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ShieldCheck className="size-3.5 shrink-0" />
        <span className="truncate">
          2FA {status} · {enrolledMembers}/{activeMembers} enrolled
        </span>
      </button>
    );
  }

  return (
    <div
      className="space-y-2 rounded-lg border border-border bg-muted/30 p-2.5"
      onClick={(e) => e.preventDefault()}
    >
      <p className="eyebrow text-muted-foreground">Two-factor sign-in</p>
      <p className="text-[11px] text-muted-foreground">
        Currently {status}. {enrolledMembers} of {activeMembers} active members enrolled. Before the
        date, members without it see a countdown; from it, they must set it up to continue.
      </p>
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why (e.g. MFA rollout approved 2 Oct)"
        className="h-8 text-xs"
      />
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            type="button"
            size="sm"
            variant={p.days === null ? "outline" : "brand"}
            disabled={busy || reason.trim().length < 10}
            onClick={() => choose(p.days)}
          >
            {p.label}
          </Button>
        ))}
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Done
        </Button>
      </div>
    </div>
  );
}
