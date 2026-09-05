// Audit 0729b — the findings, and the guards that were missing.
//
// S1 (High) — `regional_manager` held `applications.review_all`, so a manager for
//   one region read every applicant's identity documents in the organisation and
//   could rewrite the document requirements for every property in it.
// S2 (Medium) — `property_application_windows` had no `security_invoker`, so a
//   tenant or a vendor could read occupancy and vacancy for the whole portfolio.
// S3 (Low) — `stakeholder_assignments` claimed `security_invoker` in a comment
//   and did not have it.
// C1 (Med) — a valid 30-day resume link died the moment intake closed.
//
// ⚠️ The reason S1 survived is worth stating: the previous suite asserted the
// role held no FINANCIAL capability and no `tickets.read_all`. It never asserted
// it held no org-wide read of APPLICATIONS. A guard you did not think to assert
// is a guard you do not have — so this one asserts the whole shape, by listing
// every org-wide capability and requiring the role to hold none of them.
//
// Usage: node scripts/verify-audit-0729b.mjs
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const orgRes = await svc.from("orgs").select("id, delivery_brand, tenant_applications_open").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const oea = orgRes.data.find((o) => o.delivery_brand === "OEA");
const windowWasOpen = oea.tenant_applications_open;

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeUsers = [];
const madeProps = [];
const madeApps = [];

// Sweep anything a crashed run left behind.
{
  const { data: stale } = await svc.from("users").select("id").like("email", "probe0729b.%@oegroup.test");
  for (const u of stale ?? []) {
    await svc.from("users").delete().eq("id", u.id);
    await svc.auth.admin.deleteUser(u.id).catch(() => {});
  }
}

console.log("Audit 0729b\n");

console.log("S1. A regional manager is regional");
{
  const email = `probe0729b.rm.${S}@oegroup.test`;
  const { data: created, error } = await svc.auth.admin.createUser({
    email, password: PW, email_confirm: true,
  });
  if (error) { bad(`could not create a regional manager — ${error.message}`); }
  else {
    madeUsers.push(created.user.id);
    await svc.from("users").upsert({
      id: created.user.id, org_id: oea.id, email,
      full_name: "Probe RM", role: "regional_manager",
    });

    const c = await login(email);

    // The specific over-grant.
    const { data: reviewAll } = await c.rpc("has_permission", { p_capability: "applications.review_all" });
    reviewAll === false
      ? ok("does NOT hold applications.review_all")
      : bad("STILL HOLDS applications.review_all — reads every applicant in the org");

    // The whole shape, not just the one that was found. Every capability whose
    // meaning is "organisation-wide" must be absent from a role defined by its
    // region, or the next one added slips through the same gap.
    const ORG_WIDE = [
      "applications.review_all", "tickets.read_all", "assets.read",
      "sc.read_all", "properties.read_all", "sc.manage",
      "audit.read", "ledger.read", "ledger.write",
      "payment.approve", "payment.remit", "bank.configure",
      "permissions.edit", "invitation.create_admin", "channel.credentials",
      "people.deactivate",
    ];
    const held = [];
    for (const cap of ORG_WIDE) {
      const { data } = await c.rpc("has_permission", { p_capability: cap });
      if (data) held.push(cap);
    }
    held.length === 0
      ? ok(`holds none of the ${ORG_WIDE.length} organisation-wide capabilities`)
      : bad(`HOLDS ORG-WIDE: ${held.join(", ")}`);

    // And keeps what it is for.
    const keeps = [];
    for (const cap of ["tickets.assign", "tickets.close", "properties.write",
                       "units.assign_occupant", "people.invite", "assets.write", "bi.read"]) {
      const { data } = await c.rpc("has_permission", { p_capability: cap });
      if (data) keeps.push(cap);
    }
    keeps.length === 7
      ? ok("and keeps every operational capability it is meant to have")
      : bad(`lost operational capabilities — holds only ${keeps.join(", ")}`);

    // The second half of S1: rewriting the org's document requirements.
    const { error: reqErr } = await c
      .from("application_document_requirements")
      .update({ required: false })
      .eq("org_id", oea.id).eq("type", "individual").eq("kind", "national_id")
      .select("kind");
    const { data: stillRequired } = await svc
      .from("application_document_requirements")
      .select("required").eq("org_id", oea.id).eq("type", "individual").eq("kind", "national_id").single();
    stillRequired.required === true
      ? ok("cannot rewrite what documents every property in the org demands")
      : bad("A REGIONAL MANAGER CHANGED THE ORG'S DOCUMENT REQUIREMENTS");

    await c.auth.signOut();
  }
}

console.log("\nS1b. …but an executive still reads everything, as B7 says");
{
  const email = `probe0729b.exec.${S}@oegroup.test`;
  const { data: created } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  madeUsers.push(created.user.id);
  await svc.from("users").upsert({
    id: created.user.id, org_id: oea.id, email, full_name: "Probe Exec", role: "executive",
  });
  const c = await login(email);
  const { data: reviewAll } = await c.rpc("has_permission", { p_capability: "applications.review_all" });
  reviewAll === true
    ? ok("an executive holds applications.review_all — oversight sees the whole brand")
    : bad("the executive lost org-wide application review");
  await c.auth.signOut();
}

console.log("\nS2. Portfolio occupancy is not readable by everyone");
{
  for (const [email, label] of [
    ["oe-group-foundation-poc.tenant@oegroup.test", "a tenant"],
    ["oe-group-foundation-poc.vendor@oegroup.test", "a vendor"],
  ]) {
    const c = await login(email);
    const { data } = await c.from("property_application_windows").select("property_id, vacant_count");
    (data ?? []).length === 0
      ? ok(`${label} reads no property vacancy data`)
      : bad(`${label.toUpperCase()} READ ${data.length} PROPERTY VACANCY ROW(S)`);
    await c.auth.signOut();
  }

  const admin = await login("oea.admin@oegroup.test");
  const { data: asAdmin } = await admin.from("property_application_windows").select("property_id");
  (asAdmin ?? []).length > 0
    ? ok(`an administrator still reads it (${asAdmin.length} propert(ies))`)
    : bad("the administrator lost the intake screen");
  await admin.auth.signOut();
}

console.log("\nS3. The assignments view reads as the caller");
{
  const { data: views } = await svc.rpc("view_is_security_invoker", { p_view: "stakeholder_assignments" })
    .then((r) => r, () => ({ data: null }));
  if (views === null) {
    // No helper function; assert behaviourally instead.
    const c = await login("oe-group-foundation-poc.tenant@oegroup.test");
    const { data } = await c.from("stakeholder_assignments").select("id");
    (data ?? []).length === 0
      ? ok("a tenant sees no stakeholder assignments")
      : bad(`A TENANT READ ${data.length} ASSIGNMENT(S)`);
    await c.auth.signOut();
  }
}

console.log("\nC1. A resume link survives intake closing");
{
  // A property, open, so a draft can be started.
  const { data: prop } = await svc.from("properties")
    .insert({ org_id: oea.id, name: `PROBE-0729B-${S}` }).select("id").single();
  madeProps.push(prop.id);
  await svc.from("orgs").update({ tenant_applications_open: true }).eq("id", oea.id);
  await svc.rpc("set_property_application_state", { p_property_id: prop.id, p_state: "open" });

  const anon = createClient(URL_, ANON);
  const token = crypto.randomBytes(24).toString("base64url");
  const { data: appId, error } = await anon.rpc("start_tenant_application", {
    p_org_id: oea.id, p_property_id: prop.id, p_type: "individual",
    p_name: `Probe ${S}`, p_email: `probe0729b-${S}@example.com`, p_phone: null,
    p_token_hash: hash(token), p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  if (error) { bad(`could not start a draft — ${error.message.slice(0, 60)}`); }
  else {
    madeApps.push(appId);

    // Now shut intake completely — both the property and the brand switch.
    await svc.rpc("set_property_application_state", { p_property_id: prop.id, p_state: "closed" });
    await svc.from("orgs").update({ tenant_applications_open: false }).eq("id", oea.id);

    // The draft must still resume. This is what the page's reordered branch does.
    const { data: draft } = await anon
      .rpc("resume_application", { p_token_hash: hash(token) }).maybeSingle();
    draft?.id === appId
      ? ok("a draft still resumes after intake is closed — the 30 days were promised")
      : bad("THE RESUME LINK DIED WHEN INTAKE CLOSED");

    // And they can still finish it.
    for (const k of ["national_id", "passport_photo", "guarantor_id"]) {
      await anon.rpc("record_application_attachment", {
        p_token_hash: hash(token), p_kind: k,
        p_path: `${oea.id}/${appId}/${k}-${S}.pdf`,
        p_file_name: `${k}.pdf`, p_content_type: "application/pdf", p_size: 1024,
      });
    }
    const { error: se } = await anon.rpc("submit_tenant_application", {
      p_token_hash: hash(token), p_form: { full_name: `Probe ${S}` },
      p_sensitive: {}, p_consent: "probe consent",
    });
    !se
      ? ok("and can be submitted — closing intake stops NEW applications, not one in progress")
      : bad(`could not submit an in-progress draft — ${se.message.slice(0, 60)}`);

    // A NEW application must still be refused.
    const { error: newErr } = await anon.rpc("start_tenant_application", {
      p_org_id: oea.id, p_property_id: prop.id, p_type: "individual",
      p_name: "Probe", p_email: `probe0729b-new-${S}@example.com`, p_phone: null,
      p_token_hash: hash(`new${S}`), p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    newErr
      ? ok("while a new application is still refused")
      : bad("A NEW APPLICATION WAS ACCEPTED WITH INTAKE CLOSED");
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("application_attachments").delete().in("application_id", madeApps);
await svc.from("tenant_applications").delete().in("id", madeApps);
await svc.from("properties").delete().in("id", madeProps);
for (const id of madeUsers) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id).catch(() => {});
}
await svc.from("orgs").update({ tenant_applications_open: windowWasOpen }).eq("id", oea.id);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the regional manager is regional, and a draft outlives the window it was started in."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
