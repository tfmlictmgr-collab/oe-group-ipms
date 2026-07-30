// Tenant applications — the heaviest PII in the system.
//
// The claims that matter:
//   • only an org with the lettings module AND an open window accepts one
//   • an applicant cannot READ anything back — the table cannot be enumerated
//   • a draft resumes only with its token, and the token dies at submission
//   • special-category data (religion, marital status) is stored APART and is
//     absent from what a reviewer reads
//   • a PM sees applications for properties they are attached to; a tenant,
//     vendor or viewer sees none
//   • retention purges PII and keeps an anonymised stub proving a decision
//   • no automated decisioning — nothing computes a score or a recommendation
//
// Usage: npx tsx scripts/verify-tenant-applications.mjs
import path from "node:path";
import crypto from "node:crypto";
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
const anon = createClient(URL_, ANON);
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}
const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
// An application is now raised against a PROPERTY (0076), so these checks need
// one that is accepting. Forced `open` rather than relying on a vacant unit: a
// suite should test what it is about, not the occupancy of demo data.
async function probeProperty(svcClient, orgId, label) {
  const { data, error } = await svcClient.from("properties")
    .insert({ org_id: orgId, name: `PROBE-PROP-${label}` })
    .select("id").single();
  if (error) throw new Error(`could not create a probe property: ${error.message}`);
  await svcClient.rpc("set_property_application_state", {
    p_property_id: data.id, p_state: "open", p_note: "verification fixture",
  });
  return data.id;
}


const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const made = [];
const probeProps = [];

const { data: orgs } = await svc.from("orgs").select("id, name, delivery_brand, tenant_applications_open");
const oea = orgs.find((o) => o.delivery_brand === "OEA");
const tfml = orgs.find((o) => o.delivery_brand === "TFML");

// Remember how the operator left these, and put them back at the end. An
// earlier version closed OEA's window unconditionally on cleanup, so running
// the suite silently took the live application link offline — the test was
// changing the product's state rather than borrowing it.
const wasOpen = { [oea.id]: oea.tenant_applications_open, [tfml.id]: tfml.tenant_applications_open };

console.log("Tenant applications — intake and its guardrails\n");

console.log("A. Lettings is OEA-only, and the window must be open");
{
  const { data: oeaHas } = await svc.rpc("org_has_module", { p_org_id: oea.id, p_module: "lettings" });
  const { data: tfmlHas } = await svc.rpc("org_has_module", { p_org_id: tfml.id, p_module: "lettings" });
  oeaHas ? ok("OEA has the lettings module") : bad("OEA does not have lettings");
  !tfmlHas ? ok("TFML does not — it runs facilities, not tenancies") : bad("TFML has lettings enabled");

  // Set the state this asserts on rather than assuming it. A previous run that
  // died before cleanup left the window OPEN, and this check then reported a
  // product failure that was really leftover fixture state.
  await svc.from("orgs").update({ tenant_applications_open: false }).eq("id", oea.id);

  const oeaProp = await probeProperty(svc, oea.id, `A-${stamp}`);
  probeProps.push(oeaProp);
  const shut = await anon.rpc("start_tenant_application", {
    p_org_id: oea.id, p_property_id: oeaProp, p_type: "individual", p_name: "Probe",
    p_email: `probe-${stamp}@example.com`, p_phone: null,
    p_token_hash: hash(`shut-${stamp}`), p_expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  shut.error ? ok("a closed window refuses a submission") : bad("SUBMITTED INTO A CLOSED WINDOW");

  await svc.from("orgs").update({ tenant_applications_open: true }).eq("id", oea.id);
}

console.log("\nB. TFML cannot take a tenancy application even with a window open");
{
  await svc.from("orgs").update({ tenant_applications_open: true }).eq("id", tfml.id);
  const tfmlProp = await probeProperty(svc, tfml.id, `B-${stamp}`);
  probeProps.push(tfmlProp);
  const { error } = await anon.rpc("start_tenant_application", {
    p_org_id: tfml.id, p_property_id: tfmlProp, p_type: "individual", p_name: "Probe",
    p_email: `probe-tfml-${stamp}@example.com`, p_phone: null,
    p_token_hash: hash(`tfml-${stamp}`), p_expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  error ? ok("refused — the module gate holds independently of the window")
        : bad("TFML ACCEPTED A TENANCY APPLICATION");
  await svc.from("orgs").update({ tenant_applications_open: wasOpen[tfml.id] }).eq("id", tfml.id);
}

console.log("\nC. An applicant can submit but can never read back");
let appId, token;
{
  token = crypto.randomBytes(24).toString("base64url");
  const { data, error } = await anon.rpc("start_tenant_application", {
    p_org_id: oea.id, p_property_id: probeProps[0], p_type: "individual",
    p_name: `Probe Applicant ${stamp}`,
    p_email: `applicant-${stamp}@example.com`, p_phone: null,
    p_token_hash: hash(token),
    p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });

  if (error || !data) { bad(`could not submit — ${error?.message.slice(0, 60) ?? "no id"}`); }
  else { appId = data; made.push(appId); ok("an anonymous applicant created a draft"); }

  // A direct INSERT must still be impossible — the policy was removed in 0063
  // precisely so there is ONE way in.
  const direct = await anon.from("tenant_applications").insert({
    org_id: oea.id, type: "individual", status: "draft",
    applicant_name: "Bypass", applicant_email: `bypass-${stamp}@example.com`,
  });
  direct.error
    ? ok("a direct insert is refused — the RPC is the only way in")
    : bad("A DIRECT INSERT SUCCEEDED, bypassing the function's gate");

  const { data: readBack } = await anon.from("tenant_applications").select("*");
  (readBack ?? []).length === 0
    ? ok("and can read nothing back — the table cannot be enumerated")
    : bad(`AN ANONYMOUS CALLER READ ${readBack.length} APPLICATION(S)`);
}

console.log("\nD. A draft resumes only with its token");
{
  const { data } = await anon.rpc("resume_application", { p_token_hash: hash(token) });
  const row = Array.isArray(data) ? data[0] : data;
  // `appId` is explicitly required: comparing two undefineds passed happily when
  // the draft had failed to create, which is how a broken step reported PASS.
  appId && row?.id === appId
    ? ok("the right token returns the draft")
    : bad(`the token did not resume it (appId=${appId ?? "none"})`);

  const { data: wrong } = await anon.rpc("resume_application", { p_token_hash: hash("not-the-token") });
  (Array.isArray(wrong) ? wrong.length : wrong ? 1 : 0) === 0
    ? ok("a wrong token returns nothing")
    : bad("A WRONG TOKEN RESUMED AN APPLICATION");
}

console.log("\nE. Special-category data is stored apart from the form");
{
  await svc.from("tenant_applications").update({
    form: { full_name: "Probe Applicant", phone: "+2348000000000" },
    sensitive: { religion: "PROBE-RELIGION", marital_status: "PROBE-STATUS" },
    status: "submitted", submitted_at: new Date().toISOString(),
    consent_given_at: new Date().toISOString(), consent_statement: "probe consent",
  }).eq("id", appId);

  const { data: raw } = await svc.from("tenant_applications")
    .select("form, sensitive").eq("id", appId).single();
  !JSON.stringify(raw.form).includes("PROBE-RELIGION")
    ? ok("religion is NOT in the general form payload")
    : bad("special-category data leaked into `form`");
  JSON.stringify(raw.sensitive).includes("PROBE-RELIGION")
    ? ok("it is in the separate `sensitive` column")
    : bad("the sensitive column did not receive it");
}

console.log("\nF. What a reviewer reads excludes it");
{
  const oeaAdmin = await login("oea@oegroup.test");
  const { data: view, error } = await oeaAdmin.from("application_overview")
    .select("*").eq("id", appId).maybeSingle();

  if (error || !view) { bad(`a reviewer could not read the application — ${error?.message ?? "no row"}`); }
  else {
    ok("a reviewer reads the application through application_overview");
    !("sensitive" in view)
      ? ok("the view carries no `sensitive` column at all")
      : bad("application_overview EXPOSES special-category data");
    !JSON.stringify(view).includes("PROBE-RELIGION")
      ? ok("nothing in what they read contains it")
      : bad("special-category data reached the reviewer");
  }
}

console.log("\nG. Who cannot see it");
{
  for (const [email, label] of [
    ["resident@oegroup.test", "a tenant"],
    ["vendor@oegroup.test", "a vendor"],
  ]) {
    const c = await login(email);
    const { data } = await c.from("tenant_applications").select("id");
    (data ?? []).length === 0
      ? ok(`${label} sees no applications`)
      : bad(`${label.toUpperCase()} SAW ${data.length}`);
  }

  // Cross-org: a TFML admin must not see OEA's applicants.
  const tfmlAdmin = await login("tfml@oegroup.test");
  const { data: cross } = await tfmlAdmin.from("tenant_applications").select("id, org_id");
  (cross ?? []).filter((r) => r.org_id === oea.id).length === 0
    ? ok("a TFML administrator sees none of OEA's applications")
    : bad("CROSS-BRAND LEAK of tenant applications");
}

console.log("\nH. Retention purges the person, keeps the decision");
{
  await svc.from("tenant_applications").update({
    status: "rejected",
    decided_at: new Date().toISOString(),
    decision_notes: "probe rejection",
    // 90 days is the rule; dated in the past here so the purge is exercised.
    purge_after: new Date(Date.now() - 1000).toISOString(),
  }).eq("id", appId);

  const { data: purged, error } = await svc.rpc("purge_expired_applications");
  if (error) { bad(`purge failed — ${error.message.slice(0, 60)}`); }
  else {
    Number(purged) >= 1 ? ok(`purged ${purged} expired application(s)`) : bad("nothing was purged");

    const { data: after } = await svc.from("tenant_applications")
      .select("applicant_name, applicant_email, form, sensitive, status, decided_at, purged_at")
      .eq("id", appId).single();

    after.applicant_name === "[purged]" && after.applicant_email === "[purged]"
      ? ok("the applicant's identity is gone")
      : bad("PII survived the purge");
    JSON.stringify(after.form) === "{}" && JSON.stringify(after.sensitive) === "{}"
      ? ok("both payloads are emptied")
      : bad("form or sensitive data survived");
    after.status === "rejected" && after.decided_at
      ? ok("the decision stub remains — proof a decision was made, without the person")
      : bad("the decision record was destroyed along with the PII");
  }
}

console.log("\nI. Nothing decides automatically");
{
  // A guardrail worth asserting rather than assuming: no trigger or function on
  // this table may set a decision. NDPA Art. 37 and locked decision 2.
  const { data: fns } = await svc.rpc("purge_expired_applications");
  const { data: cols } = await svc.from("tenant_applications")
    .select("decided_by, decided_at").eq("id", appId).single();
  cols.decided_by === null
    ? ok("no decider was set by any automated path")
    : bad("something set decided_by without a human");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("application_attachments").delete().in("application_id", made);
await svc.from("tenant_applications").delete().in("id", made);
await svc.from("properties").delete().in("id", probeProps);
await svc.from("orgs").update({ tenant_applications_open: wasOpen[oea.id] }).eq("id", oea.id);
console.log(`\n(cleaned up; OEA's window restored to ${wasOpen[oea.id] ? "OPEN" : "closed"})`);

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — intake is gated, unreadable to applicants, and special-category data stays apart."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
