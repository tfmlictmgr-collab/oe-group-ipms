"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Paperclip, Undo2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { runAction, describeError } from "@/lib/run-action";
import { reviewRegistration } from "@/app/dashboard/my-company/actions";

type Doc = {
  id: string;
  doc_type: string;
  file_name: string | null;
  storage_path: string;
  verified_at: string | null;
};

/**
 * One pack, reviewed.
 *
 * ⚠️ The documents are fetched CLIENT-SIDE and signed on demand rather than
 * signed on the server for every pack in the list. A signed URL is a bearer
 * token for a private file; minting one for every document of every pending
 * contractor, on every page load, hands out far more access than a reviewer
 * opening one of them actually needs.
 */
export default function ReviewPanel({
  vendorId,
  stated,
  previousNotes,
}: {
  vendorId: string;
  stated: Record<string, string | null>;
  previousNotes: string | null;
}) {
  const router = useRouter();
  const [docs, setDocs] = React.useState<Doc[] | null>(null);
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("vendor_documents")
        .select("id, doc_type, file_name, storage_path, verified_at")
        .eq("vendor_id", vendorId)
        .is("superseded_at", null);
      if (!cancelled) setDocs((data as Doc[]) ?? []);
    })();
    return () => { cancelled = true; };
  }, [vendorId]);

  async function open(d: Doc) {
    const supabase = createClient();
    const { data, error } = await supabase.storage
      .from("vendor-documents")
      .createSignedUrl(d.storage_path, 60);
    if (error || !data) {
      toast.error("Could not open that document", { description: error?.message });
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      await runAction(reviewRegistration(vendorId, approve, notes));
      toast.success(approve ? "Registration approved" : "Sent back to the contractor", {
        description: approve
          ? "They can be given work and invoiced against on this organisation."
          : "They see your note and can correct the pack.",
      });
      setNotes("");
      router.refresh();
    } catch (e) {
      toast.error("Could not record that", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {previousNotes && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs">
          <span className="font-medium">Last sent back with: </span>
          {previousNotes}
        </p>
      )}

      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {Object.entries(stated).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{k}</span>
            <span className={v ? "text-right font-medium" : "text-right text-muted-foreground"}>
              {v ?? "—"}
            </span>
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Documents
        </p>
        {docs === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing attached.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {docs.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => open(d)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1.5 text-xs hover:bg-accent"
                >
                  <Paperclip className="size-3" />
                  {d.doc_type.replace(/_/g, " ")}
                  {d.verified_at && <Badge variant="success" className="text-[10px]">✓</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5">
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What needs changing? (required to send back)"
        />
        <p className="text-xs text-muted-foreground">
          The contractor sees this word for word.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="brand" disabled={busy} onClick={() => decide(true)}>
          <CheckCircle2 /> Approve registration
        </Button>
        <Button
          variant="outline"
          disabled={busy || notes.trim().length < 10}
          onClick={() => decide(false)}
        >
          <Undo2 /> Send back for changes
        </Button>
      </div>
    </div>
  );
}
