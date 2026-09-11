"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Loader2, HandHelping, Camera, X as XIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
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
import { recordAttachment } from "./media-actions";

const EVIDENCE_BUCKET = "work-order-media";
const EVIDENCE_ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const EVIDENCE_MAX_PHOTOS = 2;
const EVIDENCE_MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MB combined

const prettySize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

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
  orgId,
  status,
  acknowledged,
}: {
  ticketId: string;
  orgId: string;
  status: string;
  acknowledged: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState<"decline" | "complete" | null>(null);
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [photos, setPhotos] = React.useState<File[]>([]);
  const photoRef = React.useRef<HTMLInputElement>(null);

  const done = ["resolved", "closed"].includes(status);
  const photoBytes = photos.reduce((sum, f) => sum + f.size, 0);

  function addPhotos(list: FileList | null) {
    if (!list?.length) return;
    const incoming = Array.from(list);
    for (const f of incoming) {
      if (!EVIDENCE_ACCEPTED.includes(f.type)) {
        toast.error("Unsupported file type", { description: "Attach a photo (JPEG, PNG, WebP, HEIC)." });
        return;
      }
    }
    const combined = [...photos, ...incoming];
    if (combined.length > EVIDENCE_MAX_PHOTOS) {
      toast.error(`Up to ${EVIDENCE_MAX_PHOTOS} photos`, {
        description: "Remove one before adding another.",
      });
      return;
    }
    const totalBytes = combined.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > EVIDENCE_MAX_TOTAL_BYTES) {
      toast.error("Photos too large together", {
        description: `Both photos together must be under 5 MB — this is ${prettySize(totalBytes)}.`,
      });
      return;
    }
    setPhotos(combined);
  }

  function removePhoto(i: number) {
    setPhotos((p) => p.filter((_, idx) => idx !== i));
  }

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

  async function completeWithEvidence() {
    setBusy("complete");
    try {
      // Uploaded WHILE the ticket is still open — ticket_attachments' own
      // insert policy refuses evidence on a resolved/closed ticket (0106), so
      // this must happen before, not after, completeWorkOrder flips the
      // status. Sequential, not parallel: a slow mobile upload failing mid-
      // batch should stop cleanly rather than leave completion racing ahead
      // of its own evidence.
      const supabase = createClient();
      for (const photo of photos) {
        const ext = photo.name.split(".").pop()?.toLowerCase() || "jpg";
        const path = `${orgId}/${ticketId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from(EVIDENCE_BUCKET)
          .upload(path, photo, { contentType: photo.type });
        if (upErr) throw new Error(`Could not upload ${photo.name}: ${upErr.message}`);

        const recorded = await recordAttachment({
          ticketId,
          storagePath: path,
          fileName: photo.name,
          contentType: photo.type,
          sizeBytes: photo.size,
        });
        if (!recorded.ok) throw new Error(recorded.message);
      }

      await runAction(completeWorkOrder(ticketId, note || null));
      toast.success("Marked complete");
      setConfirming(null);
      setPhotos([]);
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

          <div className="mt-4 space-y-2">
            <Label>
              Photo evidence{" "}
              <span className="font-normal text-muted-foreground">(optional, up to 2, 5 MB together)</span>
            </Label>
            <input
              ref={photoRef}
              type="file"
              accept={EVIDENCE_ACCEPTED.join(",")}
              multiple
              className="sr-only"
              aria-label="Attach photo evidence of the completed job"
              onChange={(e) => {
                addPhotos(e.target.files);
                e.target.value = "";
              }}
            />
            {photos.length > 0 && (
              <ul className="space-y-1.5">
                {photos.map((f, i) => (
                  <li
                    key={`${f.name}-${i}`}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="flex-shrink-0 text-xs text-muted-foreground">{prettySize(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => removePhoto(i)}
                      aria-label={`Remove ${f.name}`}
                      className="flex-shrink-0 text-muted-foreground hover:text-destructive"
                    >
                      <XIcon className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {photos.length < EVIDENCE_MAX_PHOTOS && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => photoRef.current?.click()}
              >
                <Camera /> Attach a photo
              </Button>
            )}
            {photoBytes > 0 && (
              <p className="text-xs text-muted-foreground">
                {prettySize(photoBytes)} of 5 MB used.
              </p>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                completeWithEvidence();
              }}
              disabled={busy !== null}
            >
              {busy === "complete" ? "Saving…" : "Mark complete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
