"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Loader2, HandHelping } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { acknowledgeJob } from "./actions";
import { declineWorkOrder, completeWorkOrder } from "./vendor-actions";

/**
 * The contractor's own controls on a job that is theirs.
 *
 * Until now the ticket page offered a vendor nothing at all: the dispatch and
 * status card is admin/FM only, so a vendor could see the job and had no way
 * to accept it, refuse it, or say it was finished — even though RLS has always
 * permitted them to update their own.
 */
export default function VendorJobActions({
  ticketId,
  status,
  acknowledged,
}: {
  ticketId: string;
  status: string;
  acknowledged: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState<"decline" | "complete" | null>(null);
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");

  const done = ["resolved", "closed"].includes(status);

  async function run(what: string, fn: Promise<{ ok: boolean } & Record<string, unknown>>, success: string) {
    setBusy(what);
    try {
      await runAction(fn as never);
      toast.success(success);
      setConfirming(null);
      router.refresh();
    } catch (e) {
      toast.error(messageOf(e, "That could not be done."), {
        description: hintOf(e), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <p className="flex items-start gap-2 rounded-md bg-success/10 px-3 py-2 text-sm text-success">
        <CheckCircle2 className="mt-0.5 size-4 flex-shrink-0" />
        You marked this job complete. The team will verify it, and you can invoice for it from
        My Work.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {!acknowledged && (
          <Button
            variant="brand"
            disabled={busy !== null}
            onClick={() => run("accept", acknowledgeJob(ticketId), "Job accepted")}
          >
            {busy === "accept" ? <Loader2 className="animate-spin" /> : <HandHelping />}
            Accept this job
          </Button>
        )}

        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => setConfirming("complete")}
        >
          <CheckCircle2 /> Mark complete
        </Button>

        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={() => setConfirming("decline")}
          className="text-destructive hover:text-destructive"
        >
          <XCircle /> Decline
        </Button>
      </div>

      {acknowledged && (
        <p className="text-xs text-muted-foreground">
          You accepted this job. Mark it complete when the work is done.
        </p>
      )}

      {/* Decline — needs a reason, because the team has to re-assign it. */}
      <AlertDialog open={confirming === "decline"} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline this job?</AlertDialogTitle>
            <AlertDialogDescription>
              It goes back to the team to re-assign. Tell them why so they can place it
              properly — this is shown on the request.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-4 space-y-2">
            <Label htmlFor="decline-reason">Reason</Label>
            <Input
              id="decline-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. No capacity this week — can take it from Monday"
              minLength={10}
            />
            <p className="text-xs text-muted-foreground">At least 10 characters.</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                run("decline", declineWorkOrder(ticketId, reason), "Job declined — the team has been told");
              }}
            >
              {busy === "decline" ? "Declining…" : "Decline job"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Complete — a note is optional; the act is the point. */}
      <AlertDialog open={confirming === "complete"} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this job complete?</AlertDialogTitle>
            <AlertDialogDescription>
              The team will be told and will verify the work. Once verified you can submit
              your invoice for it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-4 space-y-2">
            <Label htmlFor="complete-note">What did you do? (optional)</Label>
            <Input
              id="complete-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Replaced the pump seal and tested for an hour"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                run("complete", completeWorkOrder(ticketId, note || null), "Marked complete");
              }}
            >
              {busy === "complete" ? "Saving…" : "Mark complete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
