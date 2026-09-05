import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import MemberList, { type Member } from "./members/MemberList";
import RecordDownloads from "./RecordDownloads";

export default async function MembersPage() {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) redirect("/login");
  const { profile, org } = session;
  const brand = org.delivery_brand ?? null;

  const supabase = await createClient();
  const [{ data }, { data: canExport }] = await Promise.all([
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
  ]);

  const members = ((data as Member[]) ?? []).map((m) => ({
    ...m,
    roleName: roleLabel(m.role, brand),
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
