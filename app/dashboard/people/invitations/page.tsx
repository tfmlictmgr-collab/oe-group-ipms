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
  const [invitesRes, vendorsRes, applicantsRes, unitsRes, props, deliveriesRes, nodesRes] = await Promise.all([
    supabase
      .from("invitations")
      .select("id, email, role, expires_at, node_id")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    supabase.from("vendors").select("id, name, contact_email").order("name"),
    supabase
      .from("vendor_applications")
      .select("vendor_id, contact_name")
      .not("vendor_id", "is", null)
      .order("decided_at", { ascending: false }),
    supabase.from("units").select("id, label, property_id, properties!units_property_id_fkey(name)").order("label"),
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

  // ⚠️ The region a PENDING regional-manager invitation names — the same
  // "portfolio in bracket" the roster now shows, one step earlier: before
  // acceptance, `stakeholder_assignments` has no row yet, and `invitations
  // .node_id` is the only record of what was actually offered. Built from
  // `nodesRes`, already fetched whole for the HierarchyPicker below, rather
  // than a round-trip to `node_full_name()` per invitation — a flat tree of a
  // few dozen rows is cheaper to walk in JS once than to ask the database once
  // per pending invite.
  const nodeById = new Map((nodesRes.data ?? []).map((n) => [n.id, n]));
  function nodeFullName(id: string | null): string | null {
    const chain: string[] = [];
    let cur = id ? nodeById.get(id) : undefined;
    while (cur) {
      chain.unshift(cur.name);
      cur = cur.parent_id ? nodeById.get(cur.parent_id) : undefined;
    }
    return chain.length > 0 ? chain.join(" / ") : null;
  }

  // What each vendor record already knows about its contact, so the invitation
  // form does not ask for it a second time.
  //
  // The email was copied onto `vendors` when the application was approved
  // (0021). The contact PERSON's name was not — it stays on the application
  // row, which survives approval and points back through `vendor_id`. So the
  // name is read from there rather than being unavailable.
  const contactNames = new Map<string, string>();
  for (const a of (applicantsRes.data ?? []) as { vendor_id: string | null; contact_name: string | null }[]) {
    if (a.vendor_id && a.contact_name && !contactNames.has(a.vendor_id)) {
      contactNames.set(a.vendor_id, a.contact_name);
    }
  }
  const vendorOptions = (vendorsRes.data ?? []).map((v) => ({
    id: v.id,
    label: v.name,
    email: v.contact_email,
    contactName: contactNames.get(v.id) ?? null,
  }));

  return (
    <div className="space-y-4">
      <InviteDialog
        brand={brand}
        myRole={profile.role ?? null}
        properties={props.map((p) => ({ id: p.id, label: p.name }))}
        units={units}
        vendors={vendorOptions}
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
              region: i.role === "regional_manager" ? nodeFullName(i.node_id) : null,
            }))}
            brand={brand}
          />
        </CardContent>
      </Card>
    </div>
  );
}
