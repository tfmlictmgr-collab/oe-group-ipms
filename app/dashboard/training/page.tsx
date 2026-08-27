import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Download } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { processesForEdition, type Edition } from "@/lib/guides/processes";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import AdminOnly from "../settings/AdminOnly";
import TrainingBrowser from "./TrainingBrowser";

// The trainer's handbook: every process in this org, for the platform admin
// to train an org admin with, and for an org admin to train their own team
// with in turn.
//
// ⚠️ Admin-only, same boundary `settings/permissions` already draws — this
// screen names approval thresholds and refusal reasons, and for the operator
// edition, that other organisations exist at all (B1). It is not a capability
// in the B7 matrix because it governs nothing; it is governed the way
// `/dashboard/guide` is, by who is signed in, never by a parameter.
//
// One source, filtered, never a second copy: `lib/guides/processes.ts` is the
// same catalogue `verify-training-guide.mjs` checks against the live database.
// A process added there without a role/capability/route to justify it fails
// that suite; one added FOR a role/capability/route with nothing describing
// it fails the same way. The screen can only ever show what the suite has
// already proven is real.
export default async function TrainingPage() {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) redirect("/login");

  const { profile, org } = session;
  if (profile.role !== "admin") return <AdminOnly what="the training handbook" />;

  // Same derivation as `isOperator` in the dashboard layout: an operator
  // admin's edition is allowed to say other organisations exist; a brand
  // admin's is not, and never sees the operator-only journeys at all.
  const isOperator = Boolean(org.is_platform_operator);
  const edition: Edition = isOperator
    ? "operator"
    : org.delivery_brand === "OEA"
      ? "OEA"
      : "TFML";

  const supabase = await createClient();
  const { data: moduleRows } = await supabase
    .from("org_modules")
    .select("module")
    .eq("org_id", profile.org_id)
    .eq("enabled", true);
  const orgFeatures = new Set((moduleRows ?? []).map((r) => r.module as string));

  const processes = processesForEdition(edition, orgFeatures);
  const brand = org.delivery_brand ?? null;

  // Every role this edition's processes actually name, in catalogue order,
  // for the role-filter chips — never a hand-kept list that could drift from
  // what is actually written.
  const roles = Array.from(new Set(processes.flatMap((p) => p.roles)));

  return (
    <div className="space-y-6">
      <PageHeader
        title={isOperator ? "Training — operator" : `Training — ${org.name}`}
        description={
          isOperator
            ? "Every journey that belongs to running the platform itself, not to any one client organisation."
            : "Every process in this organisation, by role and by module — for training an admin or their team."
        }
        actions={
          processes.length > 0 && (
            <Button asChild variant="brand">
              {/* Plain link, not a fetch — same reasoning as the role guide's
                  own download: the browser's own handler survives a large PDF
                  on a weak connection far better than anything written here. */}
              <a href="/api/training?scope=all" download>
                <Download className="size-4" /> Download the handbook
              </a>
            </Button>
          )
        }
      />
      {processes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No processes are available for this organisation yet.
        </p>
      ) : (
        // `TrainingBrowser` reads `?present=1` via `useSearchParams` to support
        // a deep link straight into slide mode — that hook requires a Suspense
        // boundary around its caller.
        <Suspense>
          <TrainingBrowser
            processes={processes}
            roles={roles.map((r) => ({ key: r, label: roleLabel(r, brand) }))}
          />
        </Suspense>
      )}
    </div>
  );
}

export const metadata = { title: "Training" };
