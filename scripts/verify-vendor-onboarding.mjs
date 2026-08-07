// A vendor onboarded by a person reaches the list, the dispatch dropdown, and
// their own work page.
//
// Reported live: a vendor onboarded under TFML appeared in none of them. The
// cause was not the invitation machinery — `invitations.vendor_id` exists, the
// invite dialog has a vendor picker, and `accept_invitation` already links the
// accepted user to the chosen company. It was that **no screen could create a
// vendor company at all**: `vendors` rows only arrived via the public
// self-service application flow or a seed, so TFML and OEA had none, the
// picker was empty, and the invitation was issued with `vendor_id = null`.
//
// One missing row, three symptoms — because the vendor list, the dispatch
// dropdown and My Work all read `vendors`. Section D asserts all three from
// the same fixture rather than trusting that they agree.
//
// Usage: node scripts/verify-vendor-onboarding.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

async function login(email) {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: "OEGroupDemo2026!" });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const MARK = "PROBEVENDOR";
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { vendors: [], tickets: [], invitations: [] };

// Start-of-run sweep.
{
  const { data: strays } = await svc.from("vendors").select("id").like("name", `${MARK}%`);
  if (strays?.length) {
    await svc.from("vendors").delete().in("id", strays.map((s) => s.id));
    console.log(`(swept ${strays.length} stray vendor(s))`);
  }
}

const { data: poc } = await svc.from("orgs").select("id").eq("slug", "oe-group-foundation-poc").single();
const ADMIN = "oe-group-foundation-poc.admin@oegroup.test";
const FM = "oe-group-foundation-poc.facilitymanager@oegroup.test";

console.log("Vendor onboarding — created by a person, usable everywhere\n");

console.log("A. An administrator can create a vendor company at all");
{
  const c = await login(ADMIN);
  const { data, error } = await c
    .from("vendors")
    .insert({
      org_id: poc.id, name: `${MARK}-Co-${S}`, service_category: "cleaning",
      contact_email: "ops@probe.example", status: "active", approval_status: "pending",
    })
    .select("id, approval_status")
    .single();

  if (error) bad(`an administrator could not create a vendor: ${error.message}`);
  else {
    made.vendors.push(data.id);
    ok("the vendor company is created — the path that did not exist");
    data.approval_status === "pending"
      ? ok("as PENDING approval, not approved — adding a company is not reviewing it")
      : bad(`created as ${data.approval_status}; an unreviewed vendor must not start approved`);
  }
  await c.auth.signOut();
}

console.log("\nB. A tenant cannot");
{
  const c = await login("oe-group-foundation-poc.tenant@oegroup.test");
  const { error } = await c.from("vendors").insert({
    org_id: poc.id, name: `${MARK}-Forged-${S}`, service_category: "cleaning", status: "active",
  });
  error
    ? ok("refused by RLS — creating a payable counterparty is not a tenant's to do")
    : bad("!!! A TENANT CREATED A VENDOR");
  await c.auth.signOut();
}

console.log("\nC. A vendor invitation must name a company (0116)");
{
  const { data: admin } = await svc.from("users").select("id").eq("email", ADMIN).single();
  const base = {
    org_id: poc.id, email: `${MARK}-${S}@probe.example`, role: "vendor",
    full_name: "Probe Vendor", token_hash: `${MARK}-${S}-hash`,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(), invited_by: admin.id,
  };

  const { error: orphanErr } = await svc.from("invitations").insert({ ...base, vendor_id: null });
  orphanErr
    ? ok("an invitation with no company is refused by the database")
    : bad("!!! a vendor invitation was accepted with no company — the original dead end");

  const { data: good, error: goodErr } = await svc
    .from("invitations")
    .insert({ ...base, token_hash: `${MARK}-${S}-hash2`, vendor_id: made.vendors[0] })
    .select("id")
    .single();
  if (goodErr) bad(`a properly-formed vendor invitation was refused: ${goodErr.message}`);
  else { made.invitations.push(good.id); ok("and one naming a company is accepted"); }
}

console.log("\nD. One row, three surfaces — the list, the dispatch picker, My Work");
{
  const vendorId = made.vendors[0];

  // 1. The vendor list (admin/FM read `vendors`).
  const f = await login(FM);
  const { data: listed } = await f.from("vendors").select("id, name").eq("id", vendorId);
  (listed ?? []).length === 1
    ? ok("appears in the vendor list")
    : bad("NOT IN THE VENDOR LIST — the reported symptom");

  // 2. The dispatch dropdown reads the same table, ordered by name.
  const { data: pickable } = await f.from("vendors").select("id, name").order("name");
  (pickable ?? []).some((v) => v.id === vendorId)
    ? ok("appears in the dispatch picker, so a request can be assigned to them")
    : bad("NOT IN THE DISPATCH PICKER — cannot be given work");

  // And genuinely assignable, not merely listed.
  const { data: reachable } = await f.from("tickets")
    .select("id, property_id").not("property_id", "is", null).limit(1).maybeSingle();
  if (reachable?.id) {
    const { data: t } = await svc.from("tickets").insert({
      org_id: poc.id, channel: "portal", message_text: `${MARK}-${S} assignment probe`,
      category: "maintenance", urgency: "normal", status: "open",
      property_id: reachable.property_id,
    }).select("id").single();
    made.tickets.push(t.id);

    const { data: assigned, error: aErr } = await f
      .from("tickets")
      .update({ assigned_vendor_id: vendorId, status: "assigned" })
      .eq("id", t.id)
      .select("assigned_vendor_id");
    !aErr && assigned?.[0]?.assigned_vendor_id === vendorId
      ? ok("and a real request is actually dispatched to them")
      : bad(`could not dispatch to the new vendor: ${aErr?.message ?? "no rows updated"}`);
  } else {
    console.log("  (skipped dispatch — no property-scoped ticket reachable by this FM)");
  }
  await f.auth.signOut();

  // 3. My Work resolves the vendor by user_id — the third symptom.
  const { data: vendorUser } = await svc.from("users").select("id, email")
    .eq("org_id", poc.id).eq("role", "vendor").is("deactivated_at", null).limit(1).maybeSingle();
  if (vendorUser) {
    const before = await svc.from("vendors").select("user_id").eq("id", vendorId).single();
    await svc.from("vendors").update({ user_id: vendorUser.id }).eq("id", vendorId);

    const v = await login(vendorUser.email);
    const { data: mine } = await v.from("vendors").select("id").eq("user_id", vendorUser.id);
    (mine ?? []).some((x) => x.id === vendorId)
      ? ok("and once a login is attached, their own My Work page resolves the company")
      : bad("MY WORK CANNOT RESOLVE THE COMPANY — the vendor sees an empty page");
    await v.auth.signOut();

    await svc.from("vendors").update({ user_id: before.data?.user_id ?? null }).eq("id", vendorId);
  } else {
    console.log("  (skipped My Work — no vendor-role user on this org)");
  }
}

console.log("\nE. Every organisation can actually reach this path");
{
  // The original failure was org-shaped: TFML and OEA had zero vendors, so the
  // invite picker was empty and there was no way to fill it. Assert the
  // capability that makes the screen work is present everywhere, rather than
  // only on the org that happened to be seeded with vendors.
  const { data: orgs } = await svc.from("orgs").select("id, name").is("deleted_at", null);
  const missing = [];
  for (const o of orgs ?? []) {
    const { data: cap } = await svc.from("role_permissions")
      .select("granted").eq("org_id", o.id).eq("role", "admin")
      .eq("capability", "vendors.write").maybeSingle();
    if (!cap?.granted) missing.push(o.name);
  }
  missing.length === 0
    ? ok(`an administrator holds vendors.write in all ${(orgs ?? []).length} organisations`)
    : bad(`admins cannot create vendors in: ${missing.join(", ")}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("tickets").delete().in("id", made.tickets);
await svc.from("invitations").delete().in("id", made.invitations);
await svc.from("vendors").delete().in("id", made.vendors);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a vendor added by a person is listed, dispatchable, and sees their own work."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
