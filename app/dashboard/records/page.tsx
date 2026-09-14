import { redirect } from "next/navigation";
import { FileDown } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { capabilityRefusal } from "@/lib/capability-refusal";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import RecordDownloads from "../people/RecordDownloads";

// Download Records — the roster CSVs, for the desks that hold `records.export`
// but not the Directory.
//
// 📌 12 Sept 2026. The Directory became the administrator's alone, and the
// board asked that whoever holds `records.export` keep "a minimal Download
// records card … without the interactive, clickable Directory". Three of those
// holders — the payment officer, the payment approver and the executive (decision
// 35) — could never open People at all, so the card lived on a screen they
// could not reach. It lives here instead: the downloads, and nothing about the
// people in them.
//
// The capability still decides, exactly as `/api/records/export` does: the
// route is the control, this page only offers its buttons.

const MAY_EXPORT = new Set([
  "finance_approver",
  "payment_approver",
  "executive",
  "property_manager",
  "regional_manager",
]);

export default async function RecordsPage() {
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");
  const role = session.profile.role;

  // An administrator's downloads sit at the top of their Directory.
  if (role === "admin") redirect("/dashboard/people/directory");

  const supabase = await createClient();
  const { data: canExport } = MAY_EXPORT.has(role)
    ? await supabase.rpc("has_permission", { p_capability: "records.export" })
    : { data: false };

  if (!canExport) {
    const why = await capabilityRefusal(supabase, "records.export", "Record export");
    return (
      <div className="space-y-6">
        <PageHeader title="Download Records" />
        <EmptyState icon={<FileDown />} title={why.message} description={why.hint} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Download Records"
        description="CSV rosters of this organisation's tenants, landlords and contractors, for reporting and record keeping."
      />
      <RecordDownloads isAdmin={false} />
      <p className="text-xs text-muted-foreground">
        A download is a copy that leaves the platform. Keep it where only the people who need it can
        open it, and delete it when you are done with it.
      </p>
    </div>
  );
}
