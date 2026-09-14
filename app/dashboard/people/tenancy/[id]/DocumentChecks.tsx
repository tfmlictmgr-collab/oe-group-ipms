"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles, Info, AlertTriangle, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { runAction, describeError } from "@/lib/run-action";
import { runDocumentChecks, contestFinding } from "./actions";

export type Finding = {
  id: string;
  attachment_id: string;
  kind: string;
  severity: "info" | "attention";
  summary: string;
  detail: string | null;
  model: string;
  evidence_mode: string;
  contested_at: string | null;
  contest_reason: string | null;
  contested_name: string | null;
};

const KIND_LABEL: Record<string, string> = {
  extraction: "What it says",
  format: "Format",
  consistency: "Against the form",
  completeness: "Completeness",
  duplicate: "Seen before",
};

/**
 * Automated document findings.
 *
 * Everything here is phrased and laid out as an observation about a document,
 * because that is all it is permitted to be (locked decision 10). There is no
 * total, no score, and no summary verdict across the documents — a count of
 * "3 issues" would function as a rating however it was labelled.
 */
export default function DocumentChecks({
  applicationId,
  findings,
  documentLabels,
  enabled,
  canRun,
  decided,
}: {
  applicationId: string;
  findings: Finding[];
  documentLabels: Record<string, string>;
  enabled: boolean;
  canRun: boolean;
  decided: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [contesting, setContesting] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  async function run() {
    setBusy(true);
    try {
      const r = await runAction(runDocumentChecks(applicationId));
      toast.success(
        r.findings === 0
          ? "Checks ran — nothing to report"
          : `${r.findings} observation${r.findings === 1 ? "" : "s"} recorded`,
        {
          description:
            r.skipped > 0
              ? `${r.skipped} document(s) could not be read. These are notes for you to weigh — they decide nothing.`
              : "These are notes for you to weigh — they decide nothing.",
        }
      );
      router.refresh();
    } catch (err) {
      toast.error("Could not run the checks", {
        description: describeError(err), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  async function submitContest(findingId: string) {
    if (reason.trim().length < 10) {
      toast.error("Say why", { description: "A reason of at least 10 characters is required." });
      return;
    }
    setBusy(true);
    try {
      await runAction(contestFinding(findingId, applicationId, reason));
      toast.success("Recorded as disputed", {
        description: "The finding stays on the record, now marked wrong and by whom.",
      });
      setContesting(null);
      setReason("");
      router.refresh();
    } catch (err) {
      toast.error("Could not record that", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <p className="text-sm text-muted-foreground">
        Automated document checks are switched off for this organisation. Every
        application is read by a person either way.
      </p>
    );
  }

  const byAttachment = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byAttachment.has(f.attachment_id)) byAttachment.set(f.attachment_id, []);
    byAttachment.get(f.attachment_id)!.push(f);
  }

  return (
    <div className="space-y-4">
      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No checks have been run on these documents yet.
        </p>
      ) : (
        <div className="space-y-4">
          {Array.from(byAttachment.entries()).map(([attachmentId, list]) => (
            <div key={attachmentId} className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {documentLabels[attachmentId] ?? "Document"}
              </p>
              <ul className="space-y-2">
                {list.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-lg border border-border p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-start gap-2">
                      {f.severity === "attention" ? (
                        <AlertTriangle className="mt-0.5 size-4 flex-shrink-0 text-amber-600" />
                      ) : (
                        <Info className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className={f.contested_at ? "line-through opacity-60" : undefined}>
                          {f.summary}
                        </span>
                        {f.detail && (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {f.detail}
                          </span>
                        )}
                      </span>
                      <Badge variant="outline" className="flex-shrink-0 text-[10px]">
                        {KIND_LABEL[f.kind] ?? f.kind}
                      </Badge>
                    </div>

                    {f.contested_at ? (
                      <p className="mt-2 flex items-start gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                        <Flag className="mt-0.5 size-3 flex-shrink-0" />
                        <span>
                          Disputed by {f.contested_name ?? "a reviewer"} — {f.contest_reason}
                        </span>
                      </p>
                    ) : !decided && contesting === f.id ? (
                      <div className="mt-2 space-y-2">
                        <Textarea
                          rows={2}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="What is wrong with this observation?"
                        />
                        <div className="flex gap-2">
                          <Button
                            type="button" size="sm" variant="outline" disabled={busy}
                            onClick={() => submitContest(f.id)}
                          >
                            Record as wrong
                          </Button>
                          <Button
                            type="button" size="sm" variant="ghost"
                            onClick={() => { setContesting(null); setReason(""); }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : !decided ? (
                      <button
                        type="button"
                        onClick={() => { setContesting(f.id); setReason(""); }}
                        className="mt-1.5 text-xs text-muted-foreground underline hover:text-foreground"
                      >
                        This is wrong
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {canRun && !decided && (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={run}>
          <Sparkles />
          {busy ? "Reading the documents…" : findings.length > 0 ? "Run the checks again" : "Run document checks"}
        </Button>
      )}

      <p className="text-xs text-muted-foreground">
        These checks read the uploaded documents and report what they observe.
        They do not score, rank or recommend, and they never see the
        special-category answers. Your own recorded reason is what decides this
        application.
      </p>
    </div>
  );
}
