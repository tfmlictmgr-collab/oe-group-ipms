"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { acknowledgeJob } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

export default function AcknowledgeControl({ ticketId }: { ticketId: string }) {
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      try {
        await runAction(acknowledgeJob(ticketId));
        toast.success("Job acknowledged");
      } catch (e) {
        toast.error("Could not acknowledge", {
          description: describeError(e),
        });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">This job has been assigned to you</p>
        <p className="text-sm text-muted-foreground">
          Acknowledge to confirm you have received it.
        </p>
      </div>
      <Button onClick={submit} disabled={pending} variant="brand" className="flex-shrink-0">
        <CheckCircle2 />
        {pending ? "Acknowledging…" : "Acknowledge job"}
      </Button>
    </div>
  );
}
