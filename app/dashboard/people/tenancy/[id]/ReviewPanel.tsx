"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runAction, describeError } from "@/lib/run-action";
import {
  assignUnit,
  recommendApplication,
  requestMoreInfo,
  approveApplication,
  rejectApplication,
} from "./actions";

type Unit = { id: string; label: string };

/**
 * The action surface for a reviewer. What is offered depends on the caller's
 * OWN capabilities (`applications.recommend` / `applications.approve`) and the
 * application's current status — but every button here is a suggestion, not the
 * boundary. The database re-checks all of it, including the rule that matters
 * most: whoever recommended an application cannot also decide it.
 */
export default function ReviewPanel({
  applicationId,
  status,
  applicantEmail,
  applicantName,
  orgId,
  unitId,
  canRecommend,
  canApprove,
  isRecommender,
  documentsComplete,
  vacantUnits,
}: {
  applicationId: string;
  status: string;
  applicantEmail: string;
  applicantName: string;
  orgId: string;
  unitId: string | null;
  canRecommend: boolean;
  canApprove: boolean;
  isRecommender: boolean;
  documentsComplete: boolean;
  vacantUnits: Unit[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [selectedUnit, setSelectedUnit] = React.useState(unitId ?? "");

  const open = status === "submitted" || status === "under_review";
  const reasonReady = reason.trim().length >= 10;

  async function run(label: string, action: () => Promise<unknown>, successMsg: string) {
    if (!reasonReady) {
      toast.error("Say why", { description: "A reason of at least 10 characters is required." });
      return;
    }
    setBusy(label);
    try {
      await action();
      toast.success(successMsg);
      setReason("");
      router.refresh();
    } catch (err) {
      toast.error(`Could not ${label.toLowerCase()}`, { description: describeError(err) });
    } finally {
      setBusy(null);
    }
  }

  async function onAssignUnit() {
    if (!selectedUnit) return;
    setBusy("unit");
    try {
      await runAction(assignUnit(applicationId, selectedUnit));
      toast.success("Unit assigned");
      router.refresh();
    } catch (err) {
      toast.error("Could not assign that unit", { description: describeError(err) });
    } finally {
      setBusy(null);
    }
  }

  if (status === "approved" || status === "rejected") {
    return null; // The review history card above already tells the story.
  }

  if (status === "info_requested") {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Waiting on the applicant</CardTitle>
          <CardDescription>
            A request for more information was sent. This reopens automatically
            once they resubmit.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!open) return null;

  return (
    <div className="space-y-4">
      {(unitId ?? vacantUnits.length > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Unit</CardTitle>
            <CardDescription>
              Required before an approval can complete. Only vacant units on this
              property are offered.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Select
              value={selectedUnit}
              onChange={(e) => setSelectedUnit(e.target.value)}
              className="max-w-xs"
              disabled={busy === "unit"}
            >
              <option value="">Choose a unit…</option>
              {unitId && !vacantUnits.some((u) => u.id === unitId) && (
                <option value={unitId}>Currently assigned</option>
              )}
              {vacantUnits.map((u) => (
                <option key={u.id} value={u.id}>{u.label}</option>
              ))}
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!selectedUnit || selectedUnit === unitId || busy === "unit"}
              onClick={onAssignUnit}
            >
              {selectedUnit === unitId && unitId ? "Assigned" : "Assign"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Your decision</CardTitle>
          <CardDescription>
            A reason is required for every action below — it becomes part of the
            record.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason</Label>
            <Textarea
              id="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What did you check, and what did you find?"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {canRecommend && (status === "submitted" || status === "under_review") && (
              <>
                <Button
                  type="button" size="sm" variant="outline" disabled={busy !== null}
                  onClick={() =>
                    run("Recommend approval", () => runAction(recommendApplication(applicationId, true, reason)), "Recommended for approval")
                  }
                >
                  Recommend approval
                </Button>
                <Button
                  type="button" size="sm" variant="outline" disabled={busy !== null}
                  onClick={() =>
                    run("Recommend rejection", () => runAction(recommendApplication(applicationId, false, reason)), "Recommended for rejection")
                  }
                >
                  Recommend rejection
                </Button>
              </>
            )}

            {(canRecommend || canApprove) && (
              <Button
                type="button" size="sm" variant="outline" disabled={busy !== null}
                onClick={() =>
                  run(
                    "Request information",
                    () => runAction(requestMoreInfo(applicationId, applicantEmail, applicantName, orgId, reason)),
                    "Request sent to the applicant"
                  )
                }
              >
                Ask applicant for more
              </Button>
            )}

            {canApprove && status === "under_review" && (
              isRecommender ? (
                <p className="w-full text-xs text-muted-foreground">
                  You recommended this application, so you cannot also approve or
                  reject it — a second, independent reviewer must.
                </p>
              ) : (
                <>
                  <Button
                    type="button" size="sm" variant="brand" disabled={busy !== null || !documentsComplete}
                    title={!documentsComplete ? "Documents are still outstanding" : undefined}
                    onClick={() =>
                      run(
                        "Approve",
                        () => runAction(approveApplication(applicationId, applicantEmail, applicantName, orgId, reason)),
                        "Approved"
                      )
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    type="button" size="sm" variant="destructive" disabled={busy !== null}
                    onClick={() =>
                      run("Reject", () => runAction(rejectApplication(applicationId, reason)), "Rejected")
                    }
                  >
                    Reject
                  </Button>
                </>
              )
            )}
          </div>

          {canApprove && status === "under_review" && !isRecommender && !documentsComplete && (
            <p className="text-xs text-muted-foreground">
              Approval is disabled until every required document is uploaded.
            </p>
          )}
          {!canRecommend && !canApprove && (
            <p className="text-sm text-muted-foreground">
              You do not hold review or approval rights for tenancy applications.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
