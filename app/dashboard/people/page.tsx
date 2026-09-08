import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { portfolioLabel } from "@/lib/roles";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import MemberList, { type Member } from "./members/MemberList";
import RecordDownloads from "./RecordDownloads";

export default async function MembersPage() {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) redirect("/login");
  const { profile, org } = session;
  const brand = org.delivery_brand ?? null;

  const supabase = await createClient();
  const [{ data }, { data: canExport }, { data: assignments }] = await Promise.all([
    supabase
      .from("users")
      .select("id, full_name, email, role, deactivated_at, approval_tier, former_email, email_released_at")
      .order("full_name"),
    // Operator's own edition never needs this — see RecordDownloads / 0223.
    //
    // ⚠️ Widened past `admin` (5 Sept 2026), to match the route. This screen
    // and `/api/records/export` disagreed: the route now admits the accounting
    // desks and the property/regional managers, and a page that hides the
    // button from someone the route would serve is the same nav-versus-policy
    // split decision 26 found on Service Charges. The CAPABILITY still decides
    // — it is off for everyone until an operator turns it on.
    ["admin", "finance_approver", "payment_approver", "executive",
     "property_manager", "regional_manager"].includes(profile.role)
      ? supabase.rpc("has_permission", { p_capability: "records.export" })
      : Promise.resolve({ data: false }),
    // ⚠️ A regional manager's region, for the roster — asked for directly:
    // "the regional managers when assigned should have their regions as part
    // of their portfolio in bracket". `stakeholder_assignments` (0067) already
    // resolves a node to a readable label and reads through the CALLER's own
    // policies, so it cannot show anything this viewer could not already see
    // by opening the hierarchy screen — every role that reaches /dashboard/people
    // (admin, FM/PM, regional manager) holds `properties.read_all` or
    // `hierarchy.write`, so the view is never empty for the wrong reason.
    //
    // ⚠️ `.not("node_id", "is", null)` is load-bearing, found by looking at the
    // rendered page rather than by reasoning about the query: a regional
    // manager can ALSO hold an ordinary property_id attaché row (seen live —
    // `oea.regionalmanager@` carries one dated 30 Aug, node_id null), and
    // `stakeholder_assignments.scope_label` resolves THAT to the property's
    // own name. Without this filter that property name rendered inside the
    // bracket as though it were their region — "Regional Properties Manager
    // (Lake River)" — which is the wrong fact in the right-looking shape: a
    // reader would take it for the portfolio the badge exists to state.
    supabase
      .from("stakeholder_assignments")
      .select("user_id, scope_label")
      .eq("role", "regional_manager")
      .not("node_id", "is", null),
  ]);

  // One user can hold more than one node (0067's uniqueness is per node, not
  // per person) — grouped rather than assuming the first row is the only one.
  const regionsByUser = new Map<string, string[]>();
  for (const a of assignments ?? []) {
    const list = regionsByUser.get(a.user_id) ?? [];
    if (a.scope_label) list.push(a.scope_label);
    regionsByUser.set(a.user_id, list);
  }

  const members = ((data as Member[]) ?? []).map((m) => ({
    ...m,
    roleName: portfolioLabel(m.role, brand, regionsByUser.get(m.id)),
  }));
  const active = members.filter((m) => !m.deactivated_at);

  const isOperator = profile.role === "admin" && Boolean(org.is_platform_operator);

  return (
    <div className="space-y-6">
      {(isOperator || canExport) && (
        <RecordDownloads isAdmin={isOperator || profile.role === "admin"} />
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Members</CardTitle>
          <CardDescription>
            {active.length} active
            {members.length > active.length &&
              ` · ${members.length - active.length} deactivated`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MemberList
            members={members}
            currentUserId={profile.id}
            isAdmin={profile.role === "admin"}
          />
        </CardContent>
      </Card>
    </div>
  );
}
