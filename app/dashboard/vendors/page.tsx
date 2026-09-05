import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { averageComposite } from "@/lib/vendor-score";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import RoleGate, { roleAllowed } from "../RoleGate";
import VendorList from "./VendorList";
import { FM_PM } from "@/lib/roles";

type VendorRow = {
  id: string;
  name: string;
  service_category: string | null;
  status: string;
};

export default async function VendorsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  // `executive` holds `vendors.read`. Scoring a vendor (`vendors.evaluate`) is
  // deliberately not theirs — an evaluation feeds the payment gate they sit on,
  // so writing one would let the same person set and clear their own bar.
  // ⚠️ `regional_manager` named explicitly, NOT folded into FM_PM — that
  // constant's own comment forbids it, because several call sites include the
  // regional manager and several deliberately do not. It belongs here because
  // they hold the capability this page is for (0236/0238); the nav offers the
  // link from that capability and only this list said no.
  if (!roleAllowed(session.profile?.role, [
    "admin", ...FM_PM, "regional_manager", "finance_approver", "executive",
  ])) {
    return <RoleGate title="Vendors" />;
  }

  // Reading the register is wider than adding to it: finance and an executive
  // see vendors, but creating a company is the same audience `vendors.write`
  // covers. RLS refuses the insert regardless — this only decides whether to
  // offer a button that would be refused.
  const canAddVendor = roleAllowed(session.profile?.role, ["admin", ...FM_PM, "regional_manager"]);

  const supabase = await createClient();
  // ⚠️ Scores come from `vendor_evaluation_tickets`, NOT an embedded
  // `vendor_evaluations(...)` join — the raw table's generated
  // `composite_score` zeroes whichever half of a dual-source pair a row does
  // not carry (0104), so the embedded version ranked every vendor on a number
  // that structurally undercounts them. Two queries rather than one embed,
  // because the corrected figure lives in a view PostgREST cannot embed
  // without a foreign key; grouped here instead.
  const [{ data }, { data: scored }] = await Promise.all([
    supabase.from("vendors").select("id, name, service_category, status").order("name"),
    supabase.from("vendor_evaluation_tickets").select("vendor_id, composite_score"),
  ]);

  const byVendor = new Map<string, { composite_score: number | string | null }[]>();
  for (const row of (scored as { vendor_id: string; composite_score: number | null }[]) ?? []) {
    const list = byVendor.get(row.vendor_id) ?? [];
    list.push({ composite_score: row.composite_score });
    byVendor.set(row.vendor_id, list);
  }

  const scoredVendors = ((data as VendorRow[]) ?? [])
    .map((v) => {
      const evals = byVendor.get(v.id) ?? [];
      return {
        ...v,
        // Discards the nulls a still-half-evaluated job contributes, exactly
        // as the gate does — a pending half must count for nothing, not zero.
        avg: averageComposite(evals),
        count: evals.length,
      };
    })
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));

  // ⚠️ The rank is fixed HERE, on the score ordering, and travels with the row.
  // The list below can be re-sorted by name or by evaluation count without the
  // badge changing meaning — it answers "where does this vendor stand on
  // score", never "which line is this". A vendor with no evaluations gets no
  // rank at all rather than last place: unmeasured is not the same as worst,
  // and the component renders a dash for it.
  const vendors = scoredVendors.map((v, i) => ({
    id: v.id,
    name: v.name,
    serviceCategory: v.service_category,
    avg: v.avg,
    count: v.count,
    rank: i + 1,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vendors"
        description="Ranked by composite performance score (weighted per AURA)."
        actions={
          canAddVendor ? (
            <Button asChild variant="brand">
              <Link href="/dashboard/vendors/new"><Plus /> Add Vendor</Link>
            </Button>
          ) : undefined
        }
      />

      {vendors.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title="No vendors yet"
          description="Vendors you onboard will appear here with their performance ranking."
        />
      ) : (
        <VendorList vendors={vendors} />
      )}
    </div>
  );
}
