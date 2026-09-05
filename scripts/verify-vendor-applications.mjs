// Proves the public vendor-application path is safe. This is the only
// unauthenticated write in the system, so the claims that matter are:
//   • anon can INSERT but NEVER read back (no enumeration)
//   • a closed org rejects submissions (a leaked link is inert)
//   • an application can never create a vendor by itself
//   • only staff of the SAME org, holding the right capability, may decide
//   • two-tier since 0238: an FM/PM/RM recommends, only a regional manager or
//     admin approves, and the recommender may not also approve their own
//   • approving creates exactly one vendor, marked approved
//   • duplicates are refused while a decision is pending
//   • email confirmation is single-use and reveals nothing
//   • everything is audited
//
// ⚠️ Sections I onward were rewritten (0243-adjacent fix) after `0238` added
// the recommend/approve split to `approve_vendor_application` and this suite
// was never updated for it — it kept calling `approve_vendor_application`
// straight from `submitted`, which the new function correctly refuses
// ("has not been recommended by a first reviewer yet"). The gate was right;
// the test was stale — the same class of thing 0145's own header warns about.
//
// Usage: npx tsx scripts/verify-vendor-applications.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { generateInviteToken, hashInviteToken } from "../lib/invitation.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL, SVCK, { auth: { persistSession: false } });
const anon = createClient(URL, ANON);              // a member of the public
async function login(email) {
  const c = createClient(URL, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}
const admin = await login("oe-group-foundation-poc.admin@oegroup.test");
const tenant = await login("oe-group-foundation-poc.tenant@oegroup.test");
const oea = await login("oea.admin@oegroup.test");
// The first-tier reviewer (0238): recommends, never decides. A distinct
// person from `admin` on purpose — `approve_vendor_application` refuses the
// recommender, so testing the real two-tier shape needs two different
// people, exactly as the product requires.
const fm = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");

const { data: { user: adminUser } } = await admin.auth.getUser();
const { data: me } = await admin.from("users").select("org_id").eq("id", adminUser.id).single();
const orgId = me.org_id;
const { data: otherOrg } = await svc
  .from("orgs").select("id, name").is("deleted_at", null).neq("id", orgId).limit(1).single();

const stamp = Date.now().toString(36);
const bizName = `TestVendor-${stamp} Ltd`;
const created = { apps: [], vendors: [] };

console.log("Public vendor application — safety checks\n");

// Remember how the operator left this, and put it back at the end. Forcing it
// closed on cleanup meant running the suite silently took the live vendor
// application link offline — a test may borrow the product's state, not decide it.
const { data: orgBefore } = await svc
  .from("orgs").select("vendor_applications_open").is("deleted_at", null).eq("id", orgId).single();
const wasOpen = Boolean(orgBefore?.vendor_applications_open);

// Start from a known state: applications CLOSED.
await svc.from("orgs").update({ vendor_applications_open: false }).eq("id", orgId);

console.log("A. A closed org rejects public submissions (a leaked link is inert)");
{
  const { error } = await anon.from("vendor_applications").insert({
    org_id: orgId, business_name: bizName, contact_name: "Test", contact_email: `a-${stamp}@x.test`,
  });
  error ? ok(`blocked (${error.message.slice(0, 50)})`) : bad("ALLOWED — closed org accepted a submission");
}

console.log("\nB. The org opts in, then the public may apply");
await svc.from("orgs").update({ vendor_applications_open: true }).eq("id", orgId);
{
  const { error } = await anon.from("vendor_applications").insert({
    org_id: orgId, business_name: bizName, service_category: "Generator maintenance",
    cac_number: "RC 999999", contact_name: "Chidi Okafor",
    contact_email: `apply-${stamp}@vendor.test`, status: "submitted",
  });
  error ? bad(`open org refused a submission — ${error.message}`) : ok("submission accepted");
}

console.log("\nC. anon cannot read ANY application back (no enumeration)");
{
  const { data, error } = await anon.from("vendor_applications").select("id, contact_email");
  (data ?? []).length === 0
    ? ok(`nothing readable by anon${error ? ` (${error.message.slice(0, 30)})` : ""}`)
    : bad(`anon read ${data.length} application row(s)`);
}

console.log("\nD. anon cannot escalate the status on the way in");
{
  const { error } = await anon.from("vendor_applications").insert({
    org_id: orgId, business_name: `Escalate-${stamp}`, contact_name: "X",
    contact_email: `esc-${stamp}@vendor.test`, status: "approved",
  });
  error ? ok(`self-approval blocked (${error.message.slice(0, 45)})`) : bad("ALLOWED — applicant set status=approved");
}

console.log("\nE. Applying creates NO vendor record");
{
  const { data } = await svc.from("vendors").select("id").ilike("name", bizName);
  (data ?? []).length === 0 ? ok("no vendor exists for a pending application") : bad("a vendor was created on application");
}

console.log("\nF. A duplicate application is refused while pending");
{
  const { error } = await anon.from("vendor_applications").insert({
    org_id: orgId, business_name: bizName.toUpperCase(), contact_name: "Dupe",
    contact_email: `dupe-${stamp}@vendor.test`, status: "submitted",
  });
  error ? ok(`duplicate blocked (${error.message.slice(0, 45)})`) : bad("ALLOWED — duplicate application queued");
}

// Grab the application id via the service role for the remaining checks.
const { data: app } = await svc
  .from("vendor_applications").select("id, status").ilike("business_name", bizName).maybeSingle();
if (!app) {
  bad("no application row exists — cannot run the decision checks");
  console.log(`
[31m${failures} CHECK(S) FAILED[0m`);
  await svc.from("orgs").update({ vendor_applications_open: false }).eq("id", orgId);
  process.exit(1);
}
created.apps.push(app.id);

console.log("\nG. Only staff of the SAME org may decide");
{
  const { error: tErr } = await tenant.rpc("approve_vendor_application", { p_application_id: app.id });
  tErr ? ok(`tenant blocked (${tErr.message.slice(0, 45)})`) : bad("ALLOWED — a tenant approved a vendor");

  const { error: oErr } = await oea.rpc("approve_vendor_application", { p_application_id: app.id });
  oErr ? ok(`other-org admin blocked (${oErr.message.slice(0, 45)})`) : bad("ALLOWED — another org's admin approved");
}

console.log("\nH. Email confirmation is single-use and silent about failures");
{
  const token = generateInviteToken();
  await svc.from("vendor_applications")
    .update({ verification_token_hash: hashInviteToken(token) }).eq("id", app.id);

  const { data: first } = await anon.rpc("confirm_vendor_application_email", {
    p_token_hash: hashInviteToken(token),
  });
  first === true ? ok("valid token confirmed the email") : bad(`first confirmation returned ${first}`);

  const { data: second } = await anon.rpc("confirm_vendor_application_email", {
    p_token_hash: hashInviteToken(token),
  });
  second === false ? ok("re-use returns false (single-use)") : bad(`re-use returned ${second}`);

  const { data: junk } = await anon.rpc("confirm_vendor_application_email", {
    p_token_hash: hashInviteToken("nonsense"),
  });
  junk === false ? ok("unknown token returns a bare false, leaking nothing") : bad(`unknown token returned ${junk}`);
}

console.log("\nI. The first-tier reviewer puts it forward (0238)");
{
  const { error: shortErr } = await fm.rpc("recommend_vendor_application", {
    p_application_id: app.id, p_notes: "too short",
  });
  shortErr ? ok(`a two-word recommendation is refused (${shortErr.message.slice(0, 45)})`) : bad("ALLOWED — a rubber-stamp recommendation with no substance");

  const { error: capErr } = await tenant.rpc("recommend_vendor_application", {
    p_application_id: app.id, p_notes: "Checked CAC and bank evidence, all in order",
  });
  capErr ? ok(`a tenant cannot recommend (${capErr.message.slice(0, 45)})`) : bad("ALLOWED — a tenant recommended a vendor");

  const { error } = await fm.rpc("recommend_vendor_application", {
    p_application_id: app.id, p_notes: "Checked CAC and bank evidence, all in order",
  });
  if (error) bad(`recommendation failed — ${error.message}`);
  else {
    const { data: a1 } = await svc
      .from("vendor_applications").select("status, recommended_by").eq("id", app.id).single();
    a1?.status === "under_review" ? ok("moved to under_review") : bad(`status is ${a1?.status}`);
  }

  // The recommender here is an FM, who never holds vendors.approve at all —
  // this only proves the capability gate, not the self-approval refusal one
  // level up (a regional manager/admin recommending, then approving their
  // own). That narrower boundary is verify-vendor-two-tier.mjs's job, and it
  // covers it directly; this is just confirming an FM stays shut out end to
  // end, recommendation or not.
  const { error: sameApprove } = await fm.rpc("approve_vendor_application", { p_application_id: app.id });
  sameApprove
    ? ok(`the recommender (an FM, holding no vendors.approve) still cannot decide it (${sameApprove.message.slice(0, 45)})`)
    : bad("ALLOWED — an FM approved a vendor application");
}

console.log("\nJ. Approval creates exactly one approved vendor");
{
  const { data: vendorId, error } = await admin.rpc("approve_vendor_application", {
    p_application_id: app.id, p_notes: "Verified by test",
  });
  if (error) bad(`approval failed — ${error.message}`);
  else {
    created.vendors.push(vendorId);
    const { data: v } = await svc
      .from("vendors").select("id, name, approval_status").eq("id", vendorId).single();
    v?.approval_status === "approved" ? ok(`vendor created and approved (${v.name})`) : bad(`vendor state: ${JSON.stringify(v)}`);

    const { count } = await svc
      .from("vendors").select("*", { count: "exact", head: true }).ilike("name", bizName);
    count === 1 ? ok("exactly one vendor record") : bad(`${count} vendor records created`);

    const { data: a2 } = await svc
      .from("vendor_applications").select("status, vendor_id").eq("id", app.id).single();
    a2?.status === "approved" && a2.vendor_id === vendorId
      ? ok("application marked approved and linked to the vendor")
      : bad(`application state: ${JSON.stringify(a2)}`);
  }
}

console.log("\nK. An already-decided application cannot be approved twice");
{
  const { error } = await admin.rpc("approve_vendor_application", { p_application_id: app.id });
  error ? ok(`re-approval blocked (${error.message.slice(0, 45)})`) : bad("ALLOWED — approved twice, creating a second vendor");
}

console.log("\nL. The whole path is audited");
{
  const { count } = await svc
    .from("audit_log").select("*", { count: "exact", head: true }).eq("action", "vendor_application.write");
  count > 0 ? ok(`${count} vendor_application.write audit entries`) : bad("no audit entries");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("vendor_applications").delete().ilike("business_name", `%-${stamp}%`);
for (const id of created.vendors) await svc.from("vendors").delete().eq("id", id);
await svc.from("orgs").update({ vendor_applications_open: wasOpen }).eq("id", orgId);
console.log(`\n(cleaned up; vendor applications restored to ${wasOpen ? "OPEN" : "closed"})`);

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the public path cannot create a payable vendor."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
