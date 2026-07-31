import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { writableProperties } from "../../assets/actions";
import InviteDialog from "../InviteDialog";
import { PendingInvites } from "../PendingList";

export default async function InvitationsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const profile = session.profile!;
  const brand = session.org?.delivery_brand ?? null;

  const supabase = await createClient();
  const [invitesRes, vendorsRes, unitsRes, props, deliveriesRes, nodesRes] = await Promise.all([
    supabase
      .from("invitations")
      .select("id, email, role, expires_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    supabase.from("vendors").select("id, name").order("name"),
    supabase.from("units").select("id, label, property_id, properties(name)").order("label"),
    writableProperties(),
    // What actually became of each invitation email. `accepted` means the
    // provider took it, not that it arrived — a bounce lands here minutes later.
    supabase
      .from("email_deliveries")
      .select("entity_id, status, detail, sent_at")
      .eq("entity_type", "invitation")
      .order("sent_at", { ascending: false }),
    // The tree, for scoping a regional manager. Everyone in the org may read
    // it; `invitations_insert` still refuses a node outside the inviter's own
    // subtree, so offering the whole tree here is a convenience, not a grant.
    supabase.from("org_nodes").select("id, parent_id, level, name").order("name"),
  ]);

  // Most recent attempt per invitation.
  const delivery = new Map<string, { status: string; detail: string | null }>();
  for (const d of deliveriesRes.data ?? []) {
    if (d.entity_id && !delivery.has(d.entity_id)) {
      delivery.set(d.entity_id, { status: d.status, detail: d.detail });
    }
  }

  const writableIds = new Set(props.map((p) => p.id));
  const units = (unitsRes.data ?? [])
    .filter((u) => writableIds.has(u.property_id))
    .map((u) => ({
      id: u.id,
      label: `${u.label} — ${(u.properties as unknown as { name: string } | null)?.name ?? "—"}`,
    }));

  return (
    <div className="space-y-4">
      <InviteDialog
        brand={brand}
        isAdmin={profile.role === "admin"}
        properties={props.map((p) => ({ id: p.id, label: p.name }))}
        units={units}
        vendors={(vendorsRes.data ?? []).map((v) => ({ id: v.id, label: v.name }))}
        nodes={nodesRes.data ?? []}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Awaiting acceptance</CardTitle>
          <CardDescription>Invitations that haven&apos;t been used yet.</CardDescription>
        </CardHeader>
        <CardContent>
          <PendingInvites
            invites={(invitesRes.data ?? []).map((i) => ({
              ...i,
              delivery: delivery.get(i.id) ?? null,
            }))}
            brand={brand}
          />
        </CardContent>
      </Card>
    </div>
  );
}
