"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runAction, describeError } from "@/lib/run-action";
import { acceptIntroduction, declineIntroduction } from "@/app/dashboard/my-company/actions";

/**
 * One offer, decided. `pending_vendor_introductions()` (0165) already
 * withholds which organisation it came from — see that function's own
 * comment — so nothing here can show a source, and nothing should try to.
 */
export default function ReviewPanel({ id }: { id: string }) {
  const router = useRouter();
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function accept() {
    setBusy(true);
    try {
      await runAction(acceptIntroduction(id));
      toast.success("Registration taken on", {
        description: "It has arrived as submitted — verify and approve it under Registrations.",
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not accept that offer", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await runAction(declineIntroduction(id, notes));
      toast.success("Offer declined", { description: "The contractor sees your reason." });
      router.refresh();
    } catch (e) {
      toast.error("Could not decline that offer", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Why? (required to decline)"
        disabled={busy}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="brand" disabled={busy} onClick={accept}>
          <CheckCircle2 /> Accept — take on this registration
        </Button>
        <Button
          variant="outline" disabled={busy || notes.trim().length < 10}
          onClick={decline}
        >
          <XCircle /> Decline
        </Button>
      </div>
    </div>
  );
}
