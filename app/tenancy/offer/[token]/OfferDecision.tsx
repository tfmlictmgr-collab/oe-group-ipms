"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runAction, describeError } from "@/lib/run-action";
import { acceptOffer, declineOffer } from "./actions";

/**
 * Accept or decline, for a person with no account.
 *
 * Accepting is deliberately a two-step confirmation. It creates a portal
 * account, commits the applicant to a sum of money and takes a unit off the
 * market — that is not a single tap on a phone, on a page somebody opened from
 * a link while doing something else.
 *
 * Declining is one step and asks for no reason. A reviewer is accountable for a
 * decision about somebody else; a person turning down a flat is not.
 */
export default function OfferDecision({
  token,
  brandName,
}: {
  token: string;
  brandName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<"accept" | "decline" | null>(null);
  const [mode, setMode] = React.useState<"idle" | "confirming" | "declining">("idle");
  const [reason, setReason] = React.useState("");

  async function accept() {
    setBusy("accept");
    try {
      const r = await runAction(acceptOffer(token));
      toast.success("Offer accepted", {
        description: r.emailed
          ? "We have emailed you a link to set up your tenant account."
          : `Accepted. ${brandName} has been notified and will be in touch about your account.`,
        duration: Infinity,
        closeButton: true,
      });
      router.refresh();
    } catch (err) {
      toast.error("Could not accept this offer", {
        description: describeError(err),
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(null);
      setMode("idle");
    }
  }

  async function decline() {
    setBusy("decline");
    try {
      await runAction(declineOffer(token, reason));
      toast.success("Offer declined", {
        description: "Thank you for letting us know. Nothing is owed.",
      });
      router.refresh();
    } catch (err) {
      toast.error("Could not decline this offer", { description: describeError(err) });
    } finally {
      setBusy(null);
      setMode("idle");
    }
  }

  if (mode === "declining") {
    return (
      <div className="space-y-3 rounded-xl border border-border p-4">
        <div className="space-y-1.5">
          <Label htmlFor="decline-reason">
            Anything you would like to tell us? <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="decline-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Found somewhere else, the rent is above my budget, the date does not work…"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={decline}>
            {busy === "decline" ? "Sending…" : "Decline this offer"}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setMode("idle")}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "confirming") {
    return (
      <div className="space-y-3 rounded-xl border border-[var(--brand)]/40 bg-[var(--brand)]/5 p-4">
        <p className="text-sm text-pretty">
          Accepting commits you to the terms above and takes this unit off the
          market. {brandName} will then set up your tenant account and issue the
          tenancy agreement for signature.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="brand" size="sm" disabled={busy !== null} onClick={accept}>
            <Check className="size-4" />
            {busy === "accept" ? "Recording…" : "Yes, I accept these terms"}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setMode("idle")}>
            Not yet
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="brand" onClick={() => setMode("confirming")}>
        <Check className="size-4" /> Accept this offer
      </Button>
      <Button type="button" variant="outline" onClick={() => setMode("declining")}>
        <X className="size-4" /> Decline
      </Button>
    </div>
  );
}
