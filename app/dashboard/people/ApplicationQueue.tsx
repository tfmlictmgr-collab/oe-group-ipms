"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Ban, MailCheck, MailWarning, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/patterns/empty-state";
import { decideVendorApplication } from "./actions";
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
};

export default function ApplicationQueue({ applications }: { applications: Application[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

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
              {a.notes && (
                <p className="max-w-prose pt-1 text-xs text-muted-foreground">{a.notes}</p>
              )}
            </div>

            <div className="flex flex-shrink-0 gap-2">
              <Button
                variant="outline" size="sm" disabled={busy === a.id}
                onClick={() => decide(a.id, false, a.business_name)}
              >
                <Ban /> Reject
              </Button>
              <Button
                variant="brand" size="sm" disabled={busy === a.id}
                onClick={() => decide(a.id, true, a.business_name)}
              >
                <Check /> Approve
              </Button>
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
