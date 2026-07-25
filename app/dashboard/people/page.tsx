import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { PageHeader } from "@/components/patterns/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import RoleGate, { roleAllowed } from "../RoleGate";
import { writableProperties } from "../assets/actions";
import InviteDialog from "./InviteDialog";
import { PendingInvites, VendorApprovals } from "./PendingList";
import UnitAssign from "./UnitAssign";

export default async function PeoplePage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // Enrolment is an admin / FM-PM responsibility.
  if (!roleAllowed(session.profile?.role, ["admin", "facility_manager"])) {
    return <RoleGate title="People & Onboarding" />;
  }

  const isAdmin = session.profile?.role === "admin";
  const brand = session.org?.delivery_brand ?? null;
  const supabase = await createClient();

  const [membersRes, invitesRes, vendorsRes, pendingVendorsRes, unitsRes, props] =
    await Promise.all([
      supabase.from("users").select("id, full_name, email, role").order("full_name"),
      supabase
        .from("invitations")
        .select("id, email, role, expires_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      supabase.from("vendors").select("id, name").order("name"),
      supabase
        .from("vendors")
        .select("id, name, service_category, contact_email")
        .eq("approval_status", "pending")
        .order("created_at", { ascending: false }),
      supabase
        .from("units")
        .select("id, label, property_id, occupant_user_id, properties(name)")
        .order("label"),
      // Attaché assignment may only target properties the inviter controls.
      writableProperties(),
    ]);

  const members = membersRes.data ?? [];
  const memberById = new Map(members.map((m) => [m.id, m.full_name ?? m.email ?? "User"]));
  const tenants = members
    .filter((m) => m.role === "tenant")
    .map((m) => ({ id: m.id, label: m.full_name ?? m.email ?? "Tenant" }));

  const writableIds = new Set(props.map((p) => p.id));
  const units = (unitsRes.data ?? [])
    .filter((u) => writableIds.has(u.property_id))
    .map((u) => ({
      id: u.id,
      label: u.label,
      property: (u.properties as unknown as { name: string } | null)?.name ?? "—",
      occupantId: u.occupant_user_id,
      occupantName: u.occupant_user_id ? memberById.get(u.occupant_user_id) ?? null : null,
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="People &amp; Onboarding"
        description="Invite staff, vendors and tenants into this organisation, and set what each of them can reach."
      />

      <InviteDialog
        brand={brand}
        isAdmin={isAdmin}
        properties={props.map((p) => ({ id: p.id, label: p.name }))}
        units={units.map((u) => ({ id: u.id, label: `${u.label} — ${u.property}` }))}
        vendors={(vendorsRes.data ?? []).map((v) => ({ id: v.id, label: v.name }))}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Awaiting acceptance</CardTitle>
            <CardDescription>Invitations that haven&apos;t been used yet.</CardDescription>
          </CardHeader>
          <CardContent>
            <PendingInvites invites={invitesRes.data ?? []} brand={brand} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Vendor approvals</CardTitle>
            <CardDescription>
              A vendor can&apos;t be assigned work or paid until approved.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VendorApprovals vendors={pendingVendorsRes.data ?? []} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Unit occupancy</CardTitle>
          <CardDescription>
            Assign a tenant to their unit — this is what links their requests and
            service-charge statements to the right property.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UnitAssign units={units} tenants={tenants} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4 text-brand" /> Members
          </CardTitle>
          <CardDescription>{members.length} people in this organisation.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {members.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {m.full_name ?? m.email}
                    {m.id === session.profile?.id && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                </div>
                <Badge variant="outline">{roleLabel(m.role, brand)}</Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
