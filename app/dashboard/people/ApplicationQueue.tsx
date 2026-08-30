"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Ban, MailCheck, MailWarning, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/patterns/empty-state";
import { decideVendorApplication, recommendVendorApplication } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

export type Application = {
  id: string;
  business_name: string;
  service_category: string | null;
  cac_number: string | null;
  tin: string | null;
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  website: string | null;
  notes: string | null;
  status: string;
  email_verified_at: string | null;
  created_at: string;
  recommended_by: string | null;
  recommendation_notes: string | null;
};

export default function ApplicationQueue({
  applications,
  canRecommend = false,
  canApprove = false,
  me,
}: {
  applications: Application[];
  /** vendors.recommend - the first-tier put-forward the FM/PM hold (0238). */
  canRecommend?: boolean;
  /** vendors.approve - the decision, held above them. */
  canApprove?: boolean;
  /** So a recommender is not offered a decision the database will refuse. */
  me?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<Record<string, string>>({});

  async function recommend(id: string, name: string) {
    const reason = (note[id] ?? "").trim();
    setBusy(id);
    try {
      await runAction(recommendVendorApplication(id, reason));
      toast.success(`${name} put forward`, {
        description: "It now needs a second pair of hands to approve or refuse it.",
      });
      setNote((n) => ({ ...n, [id]: "" }));
      router.refresh();
    } catch (e) {
      toast.error("Could not recommend", { description: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, approve: boolean, name: string) {
    setBusy(id);
    try {
      await runAction(decideVendorApplication(id, approve));
      toast.success(approve ? `${name} approved` : `${name} rejected`, {
        description: approve
          ? "A vendor record was created. They can now be assigned work."
          : "They will not be added as a vendor.",
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not record the decision", {
        description: describeError(e),
      });
    } finally {
      setBusy(null);
    }
  }

  if (applications.length === 0) {
    return (
      <EmptyState
        icon={<Building2 />}
        title="No vendor applications"
        description="Applications submitted through your public link appear here for review."
      />
    );
  }

  return (
    <ul className="space-y-3">
      {applications.map((a) => (
        <li key={a.id} className="rounded-md border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{a.business_name}</p>
                {a.email_verified_at ? (
                  <Badge variant="success">
                    <MailCheck className="size-3" /> Email verified
                  </Badge>
                ) : (
                  <Badge variant="warning">
                    <MailWarning className="size-3" /> Email unverified
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {a.contact_name} · {a.contact_email}
                {a.contact_phone ? ` · ${a.contact_phone}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                {[
                  a.service_category,
                  a.cac_number && `CAC ${a.cac_number}`,
                  a.tin && `TIN ${a.tin}`,
                  a.website,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No further details supplied"}
              </p>
              {a.recommendation_notes && (
                <p className="max-w-prose pt-1 text-xs text-muted-foreground">
                  <span className="font-medium">Recommended:</span>{" "}
                  {a.recommendation_notes}
                </p>
              )}
              {a.notes && (
                <p className="max-w-prose pt-1 text-xs text-muted-foreground">{a.notes}</p>
              )}
            </div>

            {/* Three states, and the third is the one that matters. A vendor
                is recommended by one desk and approved by another (0238), and
                the database refuses the recommender by name - so they are never
                offered a button that cannot work. */}
            <div className="flex flex-shrink-0 flex-col items-end gap-2">
              {a.status !== "under_review" ? (
                canRecommend ? (
                  <div className="flex flex-col items-end gap-1">
                    <input
                      value={note[a.id] ?? ""}
                      placeholder="What did you check?"
                      onChange={(e) => setNote((n) => ({ ...n, [a.id]: e.target.value }))}
                      className="w-56 rounded-md border border-input bg-background px-2 py-1 text-xs"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="brand" size="sm"
                        disabled={busy === a.id || (note[a.id] ?? "").trim().length < 10}
                        onClick={() => void recommend(a.id, a.business_name)}
                      >
                        <Check /> Recommend
                      </Button>
                      {canApprove && (
                        <Button
                          variant="outline" size="sm" disabled={busy === a.id}
                          onClick={() => decide(a.id, false, a.business_name)}
                        >
                          <Ban /> Refuse
                        </Button>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      At least 10 characters - a recommendation with no words is
                      a rubber stamp.
                    </p>
                  </div>
                ) : (
                  <Badge variant="muted">Awaiting a first review</Badge>
                )
              ) : !canApprove ? (
                <Badge variant="warning">Recommended - awaiting approval</Badge>
              ) : a.recommended_by && a.recommended_by === me ? (
                <Badge variant="muted">You recommended this - someone else decides</Badge>
              ) : (
                <div className="flex gap-2">
                  <Button
                    variant="outline" size="sm" disabled={busy === a.id}
                    onClick={() => decide(a.id, false, a.business_name)}
                  >
                    <Ban /> Refuse
                  </Button>
                  <Button
                    variant="brand" size="sm" disabled={busy === a.id}
                    onClick={() => decide(a.id, true, a.business_name)}
                  >
                    <Check /> Approve
                  </Button>
                </div>
              )}
            </div>
          </div>

          {!a.email_verified_at && (
            <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
              This applicant hasn&apos;t confirmed their email address. Verify them
              by another means before approving.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
