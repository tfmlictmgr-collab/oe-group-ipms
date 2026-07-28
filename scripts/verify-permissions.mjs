// The Day 6.5 gate.
//
// A permission screen that only hides menu items is theatre. The claims that
// matter, each asserted against a live signed-in session:
//   • flipping a toggle changes what the DATABASE returns, not just the UI
//   • locked capabilities cannot be moved — by UI or by direct API call
//   • a brand administrator cannot reach the editor for their OWN org
//   • one org's matrix cannot be read or written by another
//   • org isolation and own-record access are NOT capabilities and survive
//     every toggle being off
//   • every change lands in the audit trail naming both orgs
//
// Usage: npx tsx scripts/verify-permissions.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

/** Sets a permission and FAILS LOUDLY if the call itself was refused. */
async function setPerm(orgId, role, capability, granted) {
  const { error } = await svc.rpc("set_role_permission", {
    p_org_id: orgId, p_role: role, p_capability: capability, p_granted: granted,
  });
  if (error) bad(`set_role_permission(${role}, ${capability}) failed — ${error.message}`);
  return !error;
}

async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const { data: orgs } = await svc.from("orgs").select("id, name, delivery_brand, is_platform_operator");
const operator = orgs.find((o) => o.is_platform_operator);
const tfml = orgs.find((o) => o.delivery_brand === "TFML");

console.log("Permission matrix — the toggles are real\n");

console.log("A. Exactly one platform operator, and it is OE Group");
{
  const ops = orgs.filter((o) => o.is_platform_operator);
  ops.length === 1 ? ok(`operator is "${ops[0].name}"`) : bad(`${ops.length} orgs claim operator status`);
  operator?.delivery_brand === "direct"
    ? ok("the operator is not a client-facing brand")
    : bad("a client-facing brand holds operator status");
}

// The FM in the operator org is the subject: their capabilities are what we
// toggle, and their session is what proves the effect.
const fm = await login("fm@oegroup.test");
const { data: fmUser } = await svc.from("users").select("id, org_id")
  .eq("email", "fm@oegroup.test").single();

console.log("\nB. A toggle changes what the DATABASE returns");
{
  // vendors.read is org-wide and has no property-scoped fallback, so the effect
  // is unambiguous — unlike assets, where an FM would still see their own
  // properties' rows via the attaché assignment.
  const before = await fm.from("vendors").select("id");
  const sawBefore = (before.data ?? []).length;

  await setPerm(fmUser.org_id, "facility_manager", "vendors.read", false);

  const after = await fm.from("vendors").select("id");
  const sawAfter = (after.data ?? []).length;

  sawBefore > 0
    ? ok(`FM saw ${sawBefore} vendor(s) with the capability granted`)
    : bad("no vendors visible to begin with — the test proves nothing");
  sawAfter === 0
    ? ok("revoking it returned ZERO rows — enforced by RLS, not the menu")
    : bad(`still saw ${sawAfter} vendor(s) after revoking`);

  // Restore, and prove it comes back.
  await setPerm(fmUser.org_id, "facility_manager", "vendors.read", true);
  const restored = await fm.from("vendors").select("id");
  (restored.data ?? []).length === sawBefore
    ? ok("granting it again restored exactly what was there")
    : bad(`restored to ${(restored.data ?? []).length}, expected ${sawBefore}`);
}

console.log("\nC. A revoked WRITE is refused, not merely hidden");
{
  await setPerm(fmUser.org_id, "facility_manager", "vendors.write", false);
  const { error } = await fm.from("vendors")
    .insert({ org_id: fmUser.org_id, name: `Perm probe ${Date.now()}` });
  error ? ok("insert refused with the capability off") : bad("INSERT SUCCEEDED without the capability");

  await setPerm(fmUser.org_id, "facility_manager", "vendors.write", true);
  const { data: made, error: e2 } = await fm.from("vendors")
    .insert({ org_id: fmUser.org_id, name: `Perm probe ${Date.now()}` }).select("id").single();
  e2 ? bad(`insert still refused after granting — ${e2.message.slice(0, 50)}`)
     : ok("granting it made the same insert succeed");
  if (made) await svc.from("vendors").delete().eq("id", made.id);
}

console.log("\nD. Locked capabilities cannot be moved");
{
  const { data: locked } = await svc.from("capabilities").select("key").eq("locked", true);
  for (const cap of (locked ?? []).slice(0, 4)) {
    const { error } = await svc.rpc("set_role_permission", {
      p_org_id: fmUser.org_id, p_role: "tenant",
      p_capability: cap.key, p_granted: true,
    });
    error ? ok(`${cap.key}: refused (${error.message.slice(0, 40)})`)
          : bad(`${cap.key}: A LOCKED CAPABILITY WAS GRANTED`);
  }
  const { error: unknownErr } = await svc.rpc("set_role_permission", {
    p_org_id: fmUser.org_id, p_role: "tenant",
    p_capability: "ledger.drain", p_granted: true,
  });
  unknownErr ? ok("an unknown capability is refused, not silently created")
             : bad("an invented capability was accepted");
}

console.log("\nE. Only the OPERATOR may change a matrix");
{
  // A brand administrator, on their own org.
  const tfmlAdmin = await login("tfml@oegroup.test");
  const { error } = await tfmlAdmin.rpc("set_role_permission", {
    p_org_id: tfml.id, p_role: "facility_manager",
    p_capability: "vendors.read", p_granted: false,
  });
  error ? ok(`a brand admin cannot edit their own matrix (${error.message.slice(0, 46)})`)
        : bad("A BRAND ADMIN CHANGED THEIR OWN PERMISSIONS");

  // ...but may read it. Transparency without control.
  const { data: seen } = await tfmlAdmin.from("role_permissions").select("capability").limit(1);
  (seen ?? []).length > 0
    ? ok("a brand admin CAN read their own matrix")
    : bad("a brand admin cannot even see what applies to their staff");

  // And cannot read anyone else's.
  const { data: other } = await tfmlAdmin.from("role_permissions").select("org_id");
  (other ?? []).every((r) => r.org_id === tfml.id)
    ? ok("sees only its own organisation's matrix")
    : bad("READ ANOTHER ORGANISATION'S MATRIX");

  // A non-admin cannot even read.
  const tenant = await login("resident@oegroup.test");
  const { error: tErr } = await tenant.rpc("set_role_permission", {
    p_org_id: fmUser.org_id, p_role: "tenant",
    p_capability: "vendors.read", p_granted: true,
  });
  tErr ? ok("a tenant cannot change permissions") : bad("A TENANT CHANGED PERMISSIONS");
}

console.log("\nF. Isolation and identity are NOT capabilities");
{
  // Turn EVERY configurable capability off for the FM, then confirm the things
  // that must never depend on a toggle still work.
  const { data: caps } = await svc.from("capabilities").select("key").eq("locked", false);
  for (const c of caps ?? []) {
    await setPerm(fmUser.org_id, "facility_manager", c.key, false);
  }

  const { data: rows } = await fm.from("tickets").select("org_id");
  const foreign = (rows ?? []).filter((r) => r.org_id !== fmUser.org_id);
  foreign.length === 0
    ? ok("with every capability off, still no cross-org rows")
    : bad(`LEAKED ${foreign.length} row(s) from another org`);

  const { data: self } = await fm.from("users").select("id").eq("id", fmUser.id);
  (self ?? []).length === 1
    ? ok("can still see their own profile — identity is not a privilege")
    : bad("lost access to their own record");

  // Restore the baseline.
  await svc.rpc("reset_org_permissions_to_b7", { p_org_id: fmUser.org_id });
  const { data: back } = await fm.from("vendors").select("id");
  (back ?? []).length > 0
    ? ok("reset to B7 restored the FM's vendor access")
    : bad("reset did not restore the baseline");
}

console.log("\nG. Every change is auditable, naming both organisations");
{
  // audit_log records state as before_state / after_state — it has no `metadata`
  // column. Selecting one returns an ERROR, not an empty set, which is how this
  // check reported "nothing was audited" while 22 rows sat in the table.
  const { data: log, error } = await svc
    .from("audit_log")
    .select("action, before_state, after_state")
    .in("action", ["permission.set", "permission.reset"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) { bad(`could not read the audit trail — ${error.message}`); }
  else {
    const row = (log ?? [])[0];
    if (!row) { bad("no permission change was audited"); }
    else {
      ok(`latest audited change: ${row.action}`);
      row.after_state?.target_org
        ? ok(`names the organisation changed (${row.after_state.target_org})`)
        : bad("does not record WHOSE matrix changed");
      row.after_state?.by_org
        ? ok(`names who changed it (${row.after_state.by_org})`)
        : bad("does not record WHO changed it");
    }
  }
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the toggles move the database, the locks hold, and only the operator turns them."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
