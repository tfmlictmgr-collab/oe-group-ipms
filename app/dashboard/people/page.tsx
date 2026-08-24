import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import MemberList, { type Member } from "./members/MemberList";

export default async function MembersPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const profile = session.profile!;
  const brand = session.org?.delivery_brand ?? null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("users")
    .select("id, full_name, email, role, deactivated_at, approval_tier")
    .order("full_name");

  const members = ((data as Member[]) ?? []).map((m) => ({
    ...m,
    roleName: roleLabel(m.role, brand),
  }));
  const active = members.filter((m) => !m.deactivated_at);

  return (
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
  );
}
