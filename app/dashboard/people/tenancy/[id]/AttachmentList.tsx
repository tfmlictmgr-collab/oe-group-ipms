"use client";

import * as React from "react";
import { toast } from "sonner";
import { FileText, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { runAction, describeError } from "@/lib/run-action";
import { getAttachmentUrl } from "./actions";

type Attachment = { id: string; kind: string; storage_path: string; file_name: string; uploaded_at: string };
type Requirement = { kind: string; label: string; required: boolean };

/**
 * Every document, opened through a signed URL minted on click rather than at
 * page load — a link that sits in the page for minutes is a link that could
 * leak; one valid for 5 minutes from the moment someone actually asked for it
 * is not.
 */
export default function AttachmentList({
  attachments,
  requirements,
}: {
  attachments: Attachment[];
  requirements: Requirement[];
}) {
  const [opening, setOpening] = React.useState<string | null>(null);
  const labelFor = (kind: string) => requirements.find((r) => r.kind === kind)?.label ?? kind;

  async function open(a: Attachment) {
    setOpening(a.id);
    try {
      const { url } = await runAction(getAttachmentUrl(a.storage_path));
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error("Could not open that document", { description: describeError(err) });
    } finally {
      setOpening(null);
    }
  }

  if (attachments.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>;
  }

  return (
    <ul className="space-y-1.5">
      {attachments.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => open(a)}
            disabled={opening === a.id}
            className="flex w-full items-center gap-2.5 rounded-lg border border-border p-2.5 text-left text-sm transition-colors hover:bg-accent/50 disabled:opacity-60"
          >
            <FileText className="size-4 flex-shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{labelFor(a.kind)}</span>
            <Badge variant="outline" className="flex-shrink-0 text-[10px]">
              {a.file_name.split(".").pop()?.toUpperCase() ?? "FILE"}
            </Badge>
            <ExternalLink className="size-3.5 flex-shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}
