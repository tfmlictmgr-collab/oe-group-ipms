"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, Loader2, HandHelping, ChevronRight, MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/patterns/status-badge";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { acknowledgeJob } from "../tickets/[id]/actions";
import { declineWorkOrder, completeWorkOrder } from "../tickets/[id]/vendor-actions";

export type VendorJob = {
  id: string;
  reference: string;
  title: string;
  category: string | null;
  urgency: string | null;
  status: string;
  where: string | null;
  raised: string;
  acknowledged: boolean;
};

/**
 * One job, with the three things a contractor can do to it.
 *
 * ⚠️ These controls existed and were unreachable. `VendorJobActions` has lived
 * on `/dashboard/tickets/[id]` since 0118 — accept, decline, mark complete, all
 * wired to gated server actions — but a vendor has no Requests entry in the
 * navigation, and "Current jobs" on this page rendered the job as PLAIN TEXT in
 * a table: no link, no buttons. So the contractor's own home screen listed work
 * it gave them no way to act on, and the only route to the controls was a URL
 * they had to already know.
 *
 * The actions here are the same server actions, imported rather than
 * reimplemented: `decline_work_order` and `complete_work_order` (0118) check
 * that the job is actually theirs, so this component is a surface on one write
 * path, never a second one.
 *
 * Cards rather than table rows, deliberately: a contractor reads this on a
 * phone between jobs, and a five-column table with a button in it is a desktop
 * shape.
 */
export default function JobCard({ job }: { job: VendorJob }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState<"decline" | "complete" | null>(null);
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");

  async function run(
    what: string,
    fn: Promise<{ ok: boolean } & Record<string, unknown>>,
    success: string
  ) {
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

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Link
              href={`/dashboard/tickets/${job.id}`}
              className="group flex items-start gap-1.5 font-medium leading-snug hover:underline"
            >
              <span className="min-w-0">{job.title}</span>
              <ChevronRight className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
            <p className="text-xs text-muted-foreground">
              {job.reference} · {job.category ?? "unclassified"} · raised {job.raised}
            </p>
            {job.where && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="size-3.5" /> {job.where}
              </p>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <StatusBadge status={job.urgency} />
            <StatusBadge status={job.status} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Accepting is only meaningful once, so the button leaves rather
              than sitting there disabled. */}
          {!job.acknowledged && (
            <Button
              size="sm"
              variant="brand"
              disabled={busy !== null}
              onClick={() => run("accept", acknowledgeJob(job.id), "Job accepted")}
            >
              {busy === "accept" ? <Loader2 className="animate-spin" /> : <HandHelping />}
              Accept
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setConfirming("complete")}
          >
            <CheckCircle2 /> Mark complete
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirming("decline")}
            className="text-destructive hover:text-destructive"
          >
            <XCircle /> Decline
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={`/dashboard/tickets/${job.id}`}>Open · photos & messages</Link>
          </Button>
        </div>

        {job.acknowledged && (
          <p className="text-xs text-muted-foreground">
            You accepted this job. Mark it complete when the work is done — then you
            can invoice for it below.
          </p>
        )}
      </CardContent>

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
            <Label htmlFor={`decline-${job.id}`}>Reason</Label>
            <Input
              id={`decline-${job.id}`}
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
                run("decline", declineWorkOrder(job.id, reason), "Job declined — the team has been told");
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
            <Label htmlFor={`note-${job.id}`}>What did you do? (optional)</Label>
            <Input
              id={`note-${job.id}`}
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
                run("complete", completeWorkOrder(job.id, note || null), "Marked complete");
              }}
            >
              {busy === "complete" ? "Saving…" : "Mark complete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
