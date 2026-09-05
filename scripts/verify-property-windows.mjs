// Applications open per property, driven by vacancy but not dictated by it.
//
// The claims that matter:
//   • `auto` follows occupancy — open with a vacant unit, closed without one
//   • `open` keeps a full property taking applicants (a waiting list)
//   • `closed` shuts one whose units are empty (refurbishment, a dispute)
//   • the org flag is a master switch that overrides every property
//   • only an administrator may override, and the override is audited
//   • an application now CARRIES its property — which is what makes
//     property-scoped review possible, and is the Day 8 blocker closing
//   • a property id from another brand cannot be used at this org's endpoint
//
// Usage: node scripts/verify-property-windows.mjs
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
const anon = createClient(URL_, ANON);
const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}
const accepts = async (id) =>
  (await svc.rpc("property_accepts_applications", { p_property_id: id })).data;

const orgRes = await svc.from("orgs").select("id, delivery_brand, tenant_applications_open").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const oea = orgRes.data.find((o) => o.delivery_brand === "OEA");
const tfml = orgRes.data.find((o) => o.delivery_brand === "TFML");
const windowWasOpen = oea.tenant_applications_open;

const S = Date.now().toString(36).toUpperCase().slice(-5);
const props = [];
const units = [];
const apps = [];

await svc.from("orgs").update({ tenant_applications_open: true }).eq("id", oea.id);

const mkProperty = async (org, name) => {
  const { data, error } = await svc.from("properties")
    .insert({ org_id: org, name }).select("id").single();
  if (error) throw new Error(error.message);
  props.push(data.id);
  return data.id;
};
const mkUnit = async (org, propertyId, label, occupant = null) => {
  const { data, error } = await svc.from("units")
    .insert({ org_id: org, property_id: propertyId, label, apportionment_factor: 1, occupant_user_id: occupant })
    .select("id").single();
  if (error) throw new Error(error.message);
  units.push(data.id);
  return data.id;
};

console.log("Per-property application windows\n");

console.log("A. `auto` follows occupancy");
const vacantProp = await mkProperty(oea.id, `PROBE-Vacant-${S}`);
const fullProp = await mkProperty(oea.id, `PROBE-Full-${S}`);
{
  // The SEEDED OEA tenant. `demo.tenant@oraegbunike.com` was an account
  // created by hand on `dev` and exists on no other world, so the "occupied"
  // half of this section had no occupant anywhere else and the check reported
  // "no OEA demo tenant to occupy a unit with".
  const { data: tenant } = await svc.from("users")
    .select("id").eq("email", "oea.tenant@oegroup.test").maybeSingle();

  await mkUnit(oea.id, vacantProp, "Flat 1");                       // vacant
  await mkUnit(oea.id, fullProp, "Flat 1", tenant?.id ?? null);     // occupied

  (await accepts(vacantProp)) === true
    ? ok("a property with a vacant unit is accepting")
    : bad("a vacant property is not accepting");

  tenant?.id
    ? ((await accepts(fullProp)) === false
        ? ok("a fully occupied one is not")
        : bad("A FULLY OCCUPIED PROPERTY IS STILL ACCEPTING"))
    : bad("no OEA demo tenant to occupy a unit with");

  const noUnits = await mkProperty(oea.id, `PROBE-Empty-${S}`);
  (await accepts(noUnits)) === false
    ? ok("and a property with no units at all is not — nothing to let")
    : bad("a property with no units was accepting");
}

console.log("\nB. …and a person can overrule it, either way");
{
  await svc.rpc("set_property_application_state", { p_property_id: fullProp, p_state: "open", p_note: `waiting list ${S}` });
  (await accepts(fullProp)) === true
    ? ok("`open` keeps a full property taking applicants — a waiting list")
    : bad("forcing open did not work");

  await svc.rpc("set_property_application_state", { p_property_id: vacantProp, p_state: "closed", p_note: `refurb ${S}` });
  (await accepts(vacantProp)) === false
    ? ok("`closed` shuts one whose units are empty — refurbishment, a dispute")
    : bad("forcing closed did not work");

  await svc.rpc("set_property_application_state", { p_property_id: vacantProp, p_state: "auto" });
  (await accepts(vacantProp)) === true
    ? ok("and `auto` hands the decision back to occupancy")
    : bad("returning to auto did not restore it");
}

console.log("\nC. The org flag is a master switch");
{
  await svc.from("orgs").update({ tenant_applications_open: false }).eq("id", oea.id);
  const anyOpen = await Promise.all([accepts(vacantProp), accepts(fullProp)]);
  anyOpen.every((x) => x === false)
    ? ok("with the brand switch off, no property accepts — including a forced-open one")
    : bad("A PROPERTY ACCEPTED WHILE THE BRAND SWITCH WAS OFF");
  await svc.from("orgs").update({ tenant_applications_open: true }).eq("id", oea.id);
}

console.log("\nD. Only an administrator may override");
{
  const fin = await login("oea.financeapprover@oegroup.test");
  const { error } = await fin.rpc("set_property_application_state", {
    p_property_id: vacantProp, p_state: "closed", p_note: "should not work",
  });
  error ? ok("a finance approver is refused") : bad("A NON-ADMIN CHANGED A PROPERTY'S WINDOW");
  await fin.auth.signOut();

  const admin = await login("oea.admin@oegroup.test");
  const { error: ae } = await admin.rpc("set_property_application_state", {
    p_property_id: vacantProp, p_state: "auto",
  });
  !ae ? ok("an administrator is not") : bad(`the administrator was refused — ${ae.message.slice(0, 60)}`);
  await admin.auth.signOut();

  // Cross-org: a TFML property must not be reachable from an OEA session.
  const tfmlProp = await mkProperty(tfml.id, `PROBE-TFML-${S}`);
  const oeaAdmin = await login("oea.admin@oegroup.test");
  const { error: xe } = await oeaAdmin.rpc("set_property_application_state", {
    p_property_id: tfmlProp, p_state: "open",
  });
  xe ? ok("and cannot reach another brand's property") : bad("CROSS-ORG WINDOW CHANGE SUCCEEDED");
  await oeaAdmin.auth.signOut();

  const { data: audit } = await svc.from("audit_log")
    .select("action, after_state").eq("action", "property.application_state")
    .in("entity_id", props);
  (audit ?? []).length >= 3
    ? ok(`${audit.length} override(s) on the audit trail`)
    : bad(`only ${(audit ?? []).length} audit entries for the overrides`);
}

console.log("\nE. The public list shows only what is accepting");
{
  const { data: list } = await anon.rpc("properties_accepting_applications", { p_org_id: oea.id });
  const ids = (list ?? []).map((p) => p.id);
  ids.includes(vacantProp)
    ? ok("a vacant property is offered to an anonymous applicant")
    : bad("the vacant property is missing from the public list");

  await svc.rpc("set_property_application_state", { p_property_id: vacantProp, p_state: "closed" });
  const { data: after } = await anon.rpc("properties_accepting_applications", { p_org_id: oea.id });
  !(after ?? []).map((p) => p.id).includes(vacantProp)
    ? ok("and disappears the moment it is closed")
    : bad("A CLOSED PROPERTY IS STILL OFFERED PUBLICLY");
  await svc.rpc("set_property_application_state", { p_property_id: vacantProp, p_state: "auto" });
}

console.log("\nF. An application carries its property — the Day 8 blocker");
{
  const token = crypto.randomBytes(24).toString("base64url");
  const { data: appId, error } = await anon.rpc("start_tenant_application", {
    p_org_id: oea.id, p_property_id: vacantProp, p_type: "individual",
    p_name: `Probe ${S}`, p_email: `probe-${S}@example.com`, p_phone: null,
    p_token_hash: hash(token), p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (error) { bad(`could not start against a property — ${error.message.slice(0, 60)}`); }
  else {
    apps.push(appId);
    const { data: row } = await svc.from("tenant_applications")
      .select("property_id").eq("id", appId).single();
    row.property_id === vacantProp
      ? ok("the application is filed against the property it was raised through")
      : bad(`property_id is ${row.property_id}`);
  }

  // Closed property → refused.
  await svc.rpc("set_property_application_state", { p_property_id: vacantProp, p_state: "closed" });
  const { error: shut } = await anon.rpc("start_tenant_application", {
    p_org_id: oea.id, p_property_id: vacantProp, p_type: "individual",
    p_name: "Probe", p_email: `probe2-${S}@example.com`, p_phone: null,
    p_token_hash: hash(`x${S}`), p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  shut ? ok("a closed property refuses an application") : bad("A CLOSED PROPERTY ACCEPTED ONE");
  await svc.rpc("set_property_application_state", { p_property_id: vacantProp, p_state: "auto" });

  // A property from another brand, posted at this org's endpoint.
  const { error: cross } = await anon.rpc("start_tenant_application", {
    p_org_id: oea.id, p_property_id: props[props.length - 1], p_type: "individual",
    p_name: "Probe", p_email: `probe3-${S}@example.com`, p_phone: null,
    p_token_hash: hash(`y${S}`), p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  cross
    ? ok("a property belonging to another brand is refused")
    : bad("A TFML PROPERTY WAS USED TO APPLY TO OEA");
}

console.log("\nG. …and a property-scoped reviewer can now see it");
{
  // The point of the whole change: reachable through PROPERTY SCOPING, without
  // `applications.review_all`.
  //
  // Deliberately not finance_approver — that role HOLDS review_all, so it would
  // see every application in the org and this check would pass without property
  // scoping doing anything at all. A test that passes for the wrong reason is
  // worse than no test.
  const pmEmail = `probe.pm.${S}@oegroup.test`;
  const { data: created, error: ce } = await svc.auth.admin.createUser({
    email: pmEmail, password: PW, email_confirm: true,
  });
  if (ce) { bad(`could not create a scoped reviewer — ${ce.message}`); }
  else {
    await svc.from("users").upsert({
      id: created.user.id, org_id: oea.id, email: pmEmail,
      full_name: "Probe PM", role: "facility_manager",
    });

    const c0 = await login(pmEmail);
    const { data: hasAll } = await c0.rpc("has_permission", { p_capability: "applications.review_all" });
    hasAll === false
      ? ok("the reviewer does NOT hold applications.review_all, so only scoping can help them")
      : bad("the probe reviewer holds review_all — this check would prove nothing");

    const { data: beforeAttach } = await c0.from("application_overview").select("id").in("id", apps);
    (beforeAttach ?? []).length === 0
      ? ok("and sees nothing before being attached to the property")
      : bad(`saw ${(beforeAttach ?? []).length} application(s) with no assignment`);
    await c0.auth.signOut();

    const { data: stake } = await svc.from("property_stakeholders")
      .insert({ org_id: oea.id, user_id: created.user.id, property_id: vacantProp, relation: "manager" })
      .select("id").single();

    const c = await login(pmEmail);
    const { data: seen } = await c.from("application_overview").select("id, property_id").in("id", apps);
    (seen ?? []).length === apps.length
      ? ok("attached to the property, they can read its applications — the blocker is closed")
      : bad(`the scoped reviewer saw ${(seen ?? []).length} of ${apps.length}`);
    await c.auth.signOut();

    await svc.from("property_stakeholders").delete().eq("id", stake.id);
    await svc.from("users").delete().eq("id", created.user.id);
    await svc.auth.admin.deleteUser(created.user.id).catch(() => {});
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("application_attachments").delete().in("application_id", apps);
await svc.from("tenant_applications").delete().in("id", apps);
await svc.from("audit_log").delete().eq("action", "property.application_state").in("entity_id", props);
await svc.from("units").delete().in("id", units);
await svc.from("properties").delete().in("id", props);
await svc.from("orgs").update({ tenant_applications_open: windowWasOpen }).eq("id", oea.id);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — intake follows occupancy, a person can overrule it, and an application knows where it belongs."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
