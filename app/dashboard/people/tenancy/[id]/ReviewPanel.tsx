"use client";

import * as React from "react";
import Link from "next/link";
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
  propertyId,
  propertyName,
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
  /** For the link out when there is nothing to assign. */
  propertyId: string | null;
  propertyName: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [selectedUnit, setSelectedUnit] = React.useState(unitId ?? "");

  // ⚠️ An approval REQUIRES a unit (`record_application_approval`, 0082) and a
  // property on the `open` window accepts applications with nothing vacant
  // (decision 11's waiting list). Both are right; nobody had reconciled them,
  // so an approver on a waiting-list application met "assign a unit to this
  // application before approving it" with no unit card on the page — it was
  // hidden precisely because there was nothing to put in it.
  //
  // The precondition is now stated where the decision is made, and the button
  // that cannot succeed is disabled rather than offered.
  const needsUnit = !unitId;
  const nothingToAssign = vacantUnits.length === 0;
  const blockedOnUnit = needsUnit && nothingToAssign;

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
      {/* Rendered whenever a unit is still needed — including, and especially,
          when there is nothing to offer. Hiding it was the dead end. */}
      {(unitId || canApprove || vacantUnits.length > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Unit</CardTitle>
            <CardDescription>
              Required before an approval can complete. Only vacant units on this
              property are offered.
            </CardDescription>
          </CardHeader>
          {blockedOnUnit ? (
            <CardContent className="space-y-2">
              <p className="text-sm text-warning">
                {propertyName ?? "This property"} has no unit available to
                assign, so this application cannot be approved yet.
              </p>
              <p className="text-xs text-muted-foreground">
                A property stays open to applications as a waiting list even
                when nothing is free, so an application can legitimately arrive
                before there is anywhere to put it. Add a unit, or end a
                tenancy to free one, and this list will fill. You can still ask
                the applicant for more, or reject.
              </p>
              {propertyId && (
                <Button asChild type="button" size="sm" variant="outline">
                  <Link href={`/dashboard/properties/${propertyId}`}>
                    Open {propertyName ?? "the property"}
                  </Link>
                </Button>
              )}
            </CardContent>
          ) : (
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
          )}
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
                    type="button" size="sm" variant="brand"
                    disabled={busy !== null || !documentsComplete || needsUnit}
                    title={
                      !documentsComplete
                        ? "Documents are still outstanding"
                        : needsUnit
                          ? nothingToAssign
                            ? "No unit is available on this property to assign"
                            : "Assign a unit above before approving"
                          : undefined
                    }
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
