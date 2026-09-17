"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, Trash2, ImageIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { saveLogoUrl } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

const ACCEPTED = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];
const MAX_BYTES = 1024 * 1024; // 1 MB — plenty for a logo, keeps the shell fast.

export default function LogoUpload({
  orgId,
  currentLogoUrl,
}: {
  orgId: string;
  currentLogoUrl: string | null;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  // Optimistic preview so the admin sees the result immediately.
  const [preview, setPreview] = React.useState<string | null>(currentLogoUrl);

  async function handleFile(file: File) {
    if (!ACCEPTED.includes(file.type)) {
      toast.error("Unsupported file type", {
        description: "Use a PNG, JPEG, SVG or WebP image.",
      });
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("File too large", {
        description: `Logos must be under 1 MB — this one is ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
      });
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      // Storage RLS requires the first path segment to be the caller's org id.
      // Timestamp busts any CDN cache from a previous logo.
      const path = `${orgId}/logo-${Date.now()}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from("org-logos")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw new Error(upErr.message);

      const { data } = supabase.storage.from("org-logos").getPublicUrl(path);
      await runAction(saveLogoUrl(orgId, data.publicUrl));

      setPreview(data.publicUrl);
      toast.success("Logo updated");
      router.refresh();
    } catch (e) {
      toast.error("Upload failed", {
        description: describeError(e),
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function removeLogo() {
    setBusy(true);
    try {
      await runAction(saveLogoUrl(orgId, null));
      setPreview(null);
      toast.success("Logo removed", { description: "Your monogram is shown instead." });
      router.refresh();
    } catch (e) {
      toast.error("Could not remove logo", {
        description: describeError(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label>Logo</Label>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/50">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Current logo" className="h-full w-full object-contain" />
          ) : (
            <ImageIcon className="size-6 text-muted-foreground" />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* `sr-only` hides it visually but leaves it focusable, so it needs
              its own accessible name — the visible <Label> above titles the
              field, not this input. */}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(",")}
            className="sr-only"
            id="logo-file"
            aria-label="Choose a logo image to upload"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Upload />
            {busy ? "Working…" : preview ? "Replace logo" : "Upload logo"}
          </Button>
          {preview && (
            <Button type="button" variant="ghost" disabled={busy} onClick={removeLogo}>
              <Trash2 /> Remove
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        PNG, JPEG, SVG or WebP · up to 1 MB · square works best. Falls back to your
        monogram when no logo is set.
      </p>
    </div>
  );
}
