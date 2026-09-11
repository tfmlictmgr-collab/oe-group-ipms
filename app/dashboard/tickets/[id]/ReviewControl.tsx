"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reviewTicket } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

// Gates dispatch (0178): a request nobody operational has looked at cannot be
// sent to a vendor or an ops person, enforced by the database trigger — this
// is the affordance for the step that trigger requires, not the control
// itself. Shown in place of AssignControl until reviewed_at is set.
export default function ReviewControl({ ticketId }: { ticketId: string }) {
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      try {
        await runAction(reviewTicket(ticketId));
        toast.success("Marked as reviewed", {
          description: "This request can now be dispatched to a vendor or an ops person.",
        });
      } catch (e) {
        toast.error("Could not mark as reviewed", { description: describeError(e) });
      }
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border bg-muted/30 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Review before dispatch
      </p>
      <p className="text-sm text-muted-foreground">
        Nobody operational has looked at this request yet. Confirm the category, urgency and
        property look right — then it can be dispatched.
      </p>
      <Button onClick={submit} disabled={pending} variant="outline">
        <ClipboardCheck />
        {pending ? "Marking reviewed…" : "Mark as reviewed"}
      </Button>
    </div>
  );
}
