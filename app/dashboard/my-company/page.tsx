import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Building2 } from "lucide-react";
import CompanyClient, {
  type Requirement,
  type VendorDoc,
  type VendorMember,
  type RegistrationRow,
  type Introduction,
} from "./CompanyClient";

/**
 * A vendor company's own administration — decision 17's UI half.
 *
 * ⚠️ Reached by a VENDOR, about their OWN company. `current_user_vendor_ids()`
 * is the resolver (the vendor-side twin of `current_user_property_ids()`), and
 * every query below is scoped by RLS through it rather than by anything this
 * page decides. A vendor with no `vendor_users` row reaches nothing, which is
 * the correct answer for someone whose company was never attached.
 */
export default async function MyCompanyPage() {
  // `profile`, not just `session`: the org id below is what every uploaded
  // document is filed under and what the storage policy checks against, so a
  // session without a profile row must not reach the form at all rather than
  // reach it and write objects under `undefined/`.
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");

  const supabase = await createClient();

  // The companies this person belongs to. More than one is possible in
  // principle; in practice it is one, and the first is the one they administer.
  const { data: memberships } = await supabase
    .from("vendor_users")
    .select("id, vendor_id, is_owner, capabilities, vendors(name)")
    .order("created_at");

  // `as unknown` first: PostgREST types an embedded to-one relation as an
  // ARRAY in the generated shape, so the direct cast is refused.
  const mine = ((memberships ?? []) as unknown as {
    id: string;
    vendor_id: string;
    is_owner: boolean;
    capabilities: string[];
    vendors: { name: string } | null;
  }[])[0];

  if (!mine) {
    return (
      <EmptyState
        icon={<Building2 />}
        title="No company attached to your login"
        description="Your account is not linked to a contractor record yet. Ask whoever invited you to attach you to the company, or contact the organisation you work for."
      />
    );
  }

  const vendorId = mine.vendor_id;

  const [stateRes, missingRes, regRes, docsRes, reqsRes, membersRes, introsRes] =
    await Promise.all([
      supabase.rpc("vendor_registration_state", { p_vendor_id: vendorId }),
      supabase.rpc("vendor_registration_missing", { p_vendor_id: vendorId }),
      supabase
        .from("vendor_registrations")
        .select("*")
        .eq("vendor_id", vendorId)
        .maybeSingle(),
      supabase
        .from("vendor_documents")
        .select("id, doc_type, file_name, uploaded_at, verified_at, expires_on")
        .eq("vendor_id", vendorId)
        .is("superseded_at", null),
      supabase
        .from("vendor_document_requirements")
        .select("tier, doc_type, required, label, help_text, sort_order")
        .order("sort_order"),
      supabase
        .from("vendor_users")
        // `vendor_users` has TWO FKs to `users` — `user_id` (the member) and
        // `invited_by` (who added them) — so the embed must name which one it
        // means or PostgREST refuses as ambiguous (PGRST201).
        .select("id, user_id, is_owner, capabilities, users!vendor_users_user_id_fkey(full_name, email)")
        .eq("vendor_id", vendorId),
      // 0165/0224 — this company's own consent to carry its registration
      // elsewhere on the platform. Named because the reader supplied the
      // slug themselves; the redacted direction is staff-side.
      supabase.rpc("my_vendor_introductions"),
    ]);

  const state = ((stateRes.data as { tier: string; status: string; outstanding: number }[]) ?? [])[0] ?? {
    tier: "standard",
    status: "draft",
    outstanding: 0,
  };
  const missing = ((missingRes.data as string[] | null) ?? []).map(String);

  // Only the requirements for THIS vendor's tier. An enhanced pack asks for
  // five more documents; showing a standard vendor all of them is how a
  // two-man contractor ends up unregistered (decision 17).
  const requirements = ((reqsRes.data as Requirement[]) ?? []).filter(
    (r) => r.tier === state.tier
  );

  const members = ((membersRes.data ?? []) as unknown as {
    id: string;
    user_id: string;
    is_owner: boolean;
    capabilities: string[];
    users: { full_name: string | null; email: string | null } | null;
  }[]).map<VendorMember>((m) => ({
    id: m.id,
    userId: m.user_id,
    isOwner: m.is_owner,
    capabilities: m.capabilities ?? [],
    name: m.users?.full_name ?? m.users?.email ?? "Unnamed",
    email: m.users?.email ?? null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={mine.vendors?.name ?? "My company"}
        description="Your registration with this organisation, the documents behind it, and who in your company may do what."
      />
      <CompanyClient
        vendorId={vendorId}
        orgId={session.profile.org_id}
        tier={state.tier}
        status={state.status}
        missing={missing}
        registration={(regRes.data as RegistrationRow) ?? null}
        documents={(docsRes.data as VendorDoc[]) ?? []}
        requirements={requirements}
        members={members}
        canManageProfile={mine.is_owner || mine.capabilities.includes("manage_profile")}
        canManageUsers={mine.is_owner || mine.capabilities.includes("manage_users")}
        canManageContracts={mine.is_owner || mine.capabilities.includes("manage_contracts")}
        myVendorUserId={mine.id}
        introductions={(introsRes.data as Introduction[]) ?? []}
      />
    </div>
  );
}
