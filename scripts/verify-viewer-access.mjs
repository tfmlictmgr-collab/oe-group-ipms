// Proves the read-only observer role is actually read-only, and actually blind
// to the things it must not see.
//
// This role exists to be given to someone OUTSIDE the organisation, so it is
// defined far more by its absences than its permissions — and an absence is the
// easiest thing in a schema to lose by accident. Every denial below is asserted
// against the live database under a real viewer session, never inferred from
// reading the policies.
//
// Usage: npx tsx scripts/verify-viewer-access.mjs
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
const EMAIL = "viewer.probe@oegroup.test";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

// ── Set up a throwaway viewer in the POC org ───────────────────────────────
const { data: seed } = await svc.from("users").select("org_id")
  .eq("email", "finance@oegroup.test").single();
const orgId = seed.org_id;

const { data: list } = await svc.auth.admin.listUsers();
let authUser = list?.users?.find((u) => u.email === EMAIL);
if (!authUser) {
  const { data, error } = await svc.auth.admin.createUser({
    email: EMAIL, password: PW, email_confirm: true,
  });
  if (error) throw new Error(error.message);
  authUser = data.user;
}
await svc.from("users").upsert({
  id: authUser.id, org_id: orgId, role: "viewer",
  full_name: "Probe Observer", email: EMAIL,
});

const viewer = createClient(URL_, ANON);
{
  const { error } = await viewer.auth.signInWithPassword({ email: EMAIL, password: PW });
  if (error) throw new Error(`viewer sign-in: ${error.message}`);
}

console.log("Read-only observer — what it can and cannot reach\n");

console.log("A. The role survives a round trip");
{
  const { data } = await viewer.from("users").select("role").eq("id", authUser.id).single();
  data?.role === "viewer" ? ok("signed in as viewer") : bad(`role came back as ${data?.role}`);
}

console.log("\nB. Can see the shape of the programme");
for (const [table, label] of [
  ["properties", "properties"],
  ["units", "units"],
  ["assets", "the asset register"],
  ["vendor_overview", "vendors (via the view)"],
  ["ticket_overview", "service requests (via the view)"],
  ["vendor_evaluations", "vendor scores"],
]) {
  const { error } = await viewer.from(table).select("*", { head: true, count: "exact" });
  error ? bad(`cannot read ${label} — ${error.message.slice(0, 60)}`) : ok(`reads ${label}`);
}

console.log("\nC. CANNOT see money — the reason this role exists");
for (const table of [
  "service_charges", "sc_budgets", "payments", "payment_intents", "payment_settings",
  "ledger_accounts", "ledger_entries", "ledger_postings",
  "bank_accounts", "bank_statement_lines", "reconciliations", "gateway_events",
]) {
  const { data, error } = await viewer.from(table).select("*").limit(1);
  // A denial may be an error OR an empty result — RLS filters silently. Either
  // is acceptable; a row coming back is not.
  (error || (data ?? []).length === 0)
    ? ok(`${table}: nothing returned`)
    : bad(`${table}: RETURNED ${data.length} ROW(S) to an external viewer`);
}

console.log("\nD. CANNOT see personal data or the audit trail");
for (const table of ["audit_log", "invitations", "vendor_applications", "channel_routes"]) {
  const { data, error } = await viewer.from(table).select("*").limit(1);
  (error || (data ?? []).length === 0)
    ? ok(`${table}: nothing returned`)
    : bad(`${table}: RETURNED ${data.length} ROW(S)`);
}
{
  // Own row is fine; anyone else's is not.
  const { data } = await viewer.from("users").select("id, email");
  const others = (data ?? []).filter((u) => u.id !== authUser.id);
  others.length === 0
    ? ok("users: sees only itself, no colleagues' contact details")
    : bad(`users: sees ${others.length} other people (${others[0].email})`);
}

console.log("\nD2. Reads granted by 0038 actually work, and nothing else does");
{
  // The review noted these were granted but never probed — a policy nobody
  // tests is a policy nobody knows the state of.
  for (const t of ["asset_identifiers", "asset_certificates", "asset_field_definitions",
                   "vendor_properties"]) {
    const { error } = await viewer.from(t).select("*", { head: true, count: "exact" });
    error ? bad(`cannot read ${t} — ${error.message.slice(0, 50)}`) : ok(`reads ${t}`);
  }
  for (const t of ["remittances", "payout_recipients"]) {
    const { data, error } = await viewer.from(t).select("*").limit(1);
    (error || (data ?? []).length === 0)
      ? ok(`${t}: nothing returned`)
      : bad(`${t}: RETURNED ${data.length} ROW(S) — payout destinations exposed`);
  }
}

console.log("\nE. The withheld COLUMNS are genuinely unreachable, not just hidden");
{
  // The whole point of the view. If the underlying table is readable, the view
  // was decoration.
  const { data, error } = await viewer.from("tickets").select("message_text").limit(1);
  (error || (data ?? []).length === 0)
    ? ok("tickets.message_text unreachable — the request text stays private")
    : bad(`READ ticket free text directly: "${String(data[0].message_text).slice(0, 40)}…"`);

  const { data: v, error: vErr } = await viewer.from("vendors").select("contact_email").limit(1);
  (vErr || (v ?? []).length === 0)
    ? ok("vendors.contact_email unreachable")
    : bad(`READ vendor contact details directly: ${v[0].contact_email}`);
}

console.log("\nF. Cannot write ANYTHING");
{
  const probes = [
    ["properties", { org_id: orgId, name: "Viewer probe property" }],
    ["assets", { org_id: orgId, asset_tag: `VP-${Date.now()}`, name: "Probe" }],
    ["vendors", { org_id: orgId, name: "Probe Vendor" }],
    ["tickets", { org_id: orgId, channel: "portal", message_text: "probe" }],
    ["service_charges", { org_id: orgId, amount: 1 }],
    ["payment_intents", { org_id: orgId, purpose: "service_charge", amount_expected: 1,
                          gateway: "simulated", gateway_reference: `VP-${Date.now()}` }],
    ["ledger_entries", { org_id: orgId, entry_date: "2026-01-01", description: "probe", source: "adjustment" }],
    ["invitations", { org_id: orgId, email: "x@y.com", role: "admin", token_hash: "x" }],
    // Configuration a viewer must never touch: where money is held, what the
    // approval thresholds are, and where payouts land.
    ["bank_accounts", { org_id: orgId, label: "Viewer probe", purpose: "operating" }],
    ["payment_settings", { org_id: orgId, min_performance_score: 0, approval_threshold_amount: 0 }],
    ["payout_recipients", { org_id: orgId, party: "vendor", display_name: "Probe",
                            recipient_code: "RCP_PROBE_VIEWER" }],
    ["remittances", { org_id: orgId, party: "vendor", gross_amount: 1, net_amount: 1,
                      reference: "VP-PROBE", recipient_id: null }],
  ];
  for (const [table, row] of probes) {
    const { error } = await viewer.from(table).insert(row);
    error ? ok(`${table}: insert refused`) : bad(`${table}: INSERT SUCCEEDED`);
  }

  // Update and delete on something it CAN read is the sharper test.
  const { data: prop } = await viewer.from("properties").select("id").limit(1).maybeSingle();
  if (prop) {
    const { error: uErr } = await viewer.from("properties")
      .update({ name: "Renamed by a viewer" }).eq("id", prop.id);
    const { data: after } = await svc.from("properties").select("name").eq("id", prop.id).single();
    after.name !== "Renamed by a viewer"
      ? ok("properties: update had no effect")
      : bad("properties: A VIEWER RENAMED A PROPERTY");
    if (uErr) ok(`  (refused outright: ${uErr.message.slice(0, 40)})`);

    await viewer.from("properties").delete().eq("id", prop.id);
    const { data: still } = await svc.from("properties").select("id").eq("id", prop.id).maybeSingle();
    still ? ok("properties: delete had no effect") : bad("properties: A VIEWER DELETED A PROPERTY");
  }
}

console.log("\nG. Cannot escalate its own role");
{
  await viewer.from("users").update({ role: "admin" }).eq("id", authUser.id);
  const { data } = await svc.from("users").select("role").eq("id", authUser.id).single();
  data.role === "viewer" ? ok("still a viewer") : bad(`ESCALATED TO ${data.role}`);
}

console.log("\nH. Cannot reach another organisation");
{
  const { data: otherOrg } = await svc.from("orgs").select("id, name").neq("id", orgId).limit(1).single();
  const { data: props } = await viewer.from("properties").select("org_id");
  const leaked = (props ?? []).filter((p) => p.org_id !== orgId);
  leaked.length === 0
    ? ok(`no rows from ${otherOrg.name}`)
    : bad(`LEAKED ${leaked.length} row(s) from another org`);

  const { data: orgs } = await viewer.from("orgs").select("id");
  (orgs ?? []).every((o) => o.id === orgId)
    ? ok("sees only its own organisation")
    : bad("sees other organisations");
}

console.log("\nI. The views do not widen access for anyone else");
{
  // A definer-rights view bypasses RLS, so a tenant must not be able to read
  // every ticket in the org through it.
  const tenant = createClient(URL_, ANON);
  const { error: tErr } = await tenant.auth.signInWithPassword({
    email: "resident@oegroup.test", password: PW,
  });
  if (tErr) { bad(`tenant sign-in: ${tErr.message}`); }
  else {
    const { data } = await tenant.from("ticket_overview").select("id");
    (data ?? []).length === 0
      ? ok("a tenant reads no rows through ticket_overview")
      : bad(`a tenant read ${data.length} row(s) through the view — it widened access`);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("users").delete().eq("id", authUser.id);
await svc.auth.admin.deleteUser(authUser.id);
console.log("\n(removed the probe account)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a viewer sees the programme, not the money, the people, or the trail."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
