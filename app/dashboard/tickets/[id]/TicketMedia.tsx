"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, Upload, Trash2, FileVideo, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { recordAttachment, removeAttachment, getMediaUrl } from "./media-actions";

const BUCKET = "work-order-media";

// Mirrors the bucket's own `allowed_mime_types` (0106). Checked here so a
// wrong file is refused instantly with a readable reason, and there so a
// client that skips the check is refused anyway.
const ACCEPTED = [
  "image/jpeg", "image/png", "image/webp", "image/heic",
  "video/mp4", "video/quicktime", "video/webm",
];
const MAX_BYTES = 25 * 1024 * 1024;

export type TicketAttachment = {
  id: string;
  storage_path: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: string;
  uploaded_at: string;
  /** Pre-signed at render, so a private image can be displayed. */
  url: string | null;
  uploader_name: string | null;
};

const prettySize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function TicketMedia({
  ticketId,
  orgId,
  currentUserId,
  attachments,
  canUpload,
}: {
  ticketId: string;
  orgId: string;
  currentUserId: string;
  attachments: TicketAttachment[];
  canUpload: boolean;
}) {
  const router = useRouter();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState<string[]>([]);
  const [removing, setRemoving] = React.useState<string | null>(null);

  async function uploadOne(file: File) {
    if (!ACCEPTED.includes(file.type)) {
      toast.error("Unsupported file type", {
        description: "Attach a photo (JPEG, PNG, WebP, HEIC) or a video (MP4, MOV, WebM).",
      });
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("File too large", {
        description: `Evidence must be under 25 MB — this one is ${prettySize(file.size)}. A shorter clip or a photo will upload far faster on a mobile connection.`,
      });
      return;
    }

    setUploading((u) => [...u, file.name]);
    try {
      const supabase = createClient();
      const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
      // Storage RLS requires the first segment to be the caller's org; the
      // ticket segment keeps one job's evidence together, and the random
      // prefix means two photos named IMG_0001.jpg never collide.
      const path = `${orgId}/${ticketId}/${crypto.randomUUID()}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type });
      if (upErr) throw new Error(upErr.message);

      await runAction(
        recordAttachment({
          ticketId,
          storagePath: path,
          fileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        })
      );
      toast.success("Attached", { description: file.name });
      router.refresh();
    } catch (e) {
      toast.error(messageOf(e, "That file could not be attached."), {
        description: hintOf(e),
      });
    } finally {
      setUploading((u) => u.filter((n) => n !== file.name));
    }
  }

  async function handleFiles(list: FileList | null) {
    if (!list?.length) return;
    // Sequential, not Promise.all: several videos at once on a congested
    // mobile link is how uploads time out rather than finish.
    for (const file of Array.from(list)) await uploadOne(file);
  }

  // By attachment id, not its storage path (audit 0805-H1/C2) — the server
  // action resolves the path itself, through the row's own RLS, rather than
  // being asked to sign whatever path the browser hands it.
  async function open(attachmentId: string) {
    try {
      const { url } = await runAction(getMediaUrl(attachmentId));
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(messageOf(e, "Could not open that file."));
    }
  }

  async function remove(a: TicketAttachment) {
    setRemoving(a.id);
    try {
      await runAction(removeAttachment(a.id, ticketId));
      toast.success("Removed", { description: a.file_name });
      router.refresh();
    } catch (e) {
      toast.error(messageOf(e, "Could not remove that attachment."), {
        description: hintOf(e),
      });
    } finally {
      setRemoving(null);
    }
  }

  const busy = uploading.length > 0;

  return (
    <div className="space-y-4">
      {attachments.length === 0 && !busy && (
        <p className="text-sm text-muted-foreground">
          {canUpload
            ? "No photos or video yet. Attach what the problem looks like, or what the finished work looks like."
            : "No photos or video were attached to this request."}
        </p>
      )}

      {(attachments.length > 0 || busy) && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {attachments.map((a) => {
            const isVideo = a.content_type.startsWith("video/");
            const mine = a.uploaded_by === currentUserId;
            return (
              <li key={a.id} className="group relative">
                <button
                  type="button"
                  onClick={() => open(a.id)}
                  className="block w-full overflow-hidden rounded-lg border border-border bg-muted/40 focus-visible:outline-none"
                  aria-label={`Open ${a.file_name}`}
                >
                  <span className="flex aspect-square items-center justify-center">
                    {isVideo || !a.url ? (
                      <FileVideo className="size-8 text-muted-foreground" aria-hidden />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.url}
                        alt={a.file_name}
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      />
                    )}
                  </span>
                </button>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={a.file_name}>
                  {a.file_name}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {prettySize(a.size_bytes)}
                  {a.uploader_name ? ` · ${a.uploader_name}` : ""}
                </p>
                {mine && canUpload && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-1 top-1 bg-background/80 backdrop-blur-sm hover:bg-background"
                    disabled={removing === a.id}
                    onClick={() => remove(a)}
                    aria-label={`Remove ${a.file_name}`}
                  >
                    {removing === a.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Trash2 className="text-destructive" />
                    )}
                  </Button>
                )}
              </li>
            );
          })}

          {uploading.map((name) => (
            <li key={`up-${name}`} className="space-y-1">
              <span className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-border bg-muted/30">
                <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
              </span>
              <p className="truncate text-xs text-muted-foreground">{name}</p>
              <p className="text-[10px] text-muted-foreground">Uploading…</p>
            </li>
          ))}
        </ul>
      )}

      {canUpload && (
        <div className="space-y-2">
          {/* Visually hidden but still in the tab order, so it needs a name of
              its own — a screen reader reaching it would otherwise announce
              only "file upload button". */}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPTED.join(",")}
            className="sr-only"
            aria-label="Choose photos or video to attach to this request"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {/* `capture` opens the camera directly on a phone — the technician
              standing in front of the work should not have to go via the
              gallery app to photograph it. Ignored on desktop, where it
              behaves as an ordinary file picker. */}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            aria-label="Take a photo with the camera"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <Upload /> {busy ? "Uploading…" : "Attach photo or video"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cameraRef.current?.click()}
              className="sm:hidden"
            >
              <Camera /> Take a photo
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Photos or video, up to 25 MB each. Everyone who can see this request
            can see what you attach.
          </p>
        </div>
      )}
    </div>
  );
}
