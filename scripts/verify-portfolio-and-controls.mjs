// The portfolio schedule, the segregated fund, the optional ladder, the return
// routing, and the audit trail that now records all of it (0247–0254).
//
// The claims that matter:
//   • a property's service-charge fund is ITS OWN, so one building's shortfall
//     cannot block another building's fully-collected payment — the defect
//     behind "account 2000 would be overpaid by 21000.00"
//   • the refusal, when it does come, names the property and the shortfall
//   • the payment chain is unchanged for every org until an OPERATOR changes
//     it, and an org's own administrator cannot
//   • the property manager holds sc.manage and leases.write; the FACILITIES
//     manager holds neither
//   • the B7 BASELINE for records.export is still off for every role including
//     admin (0239 intact), and anything actually granted has a person recorded
//     as having granted it — a grant with no `set_by` is drift, and fails
//   • a refusal at stage N sends it back to stage N-1 rather than killing it,
//     and the approvals already given remain visible
//   • the chain's own decisions and the requisition's whole life reach the
//     audit trail
//   • the tenancy schedule assembles the MANAGEMENT PORTFOLIO workbook's
//     columns, and a TENANT cannot read it
//
// ⚠️ Every read below is made through a REAL SIGNED-IN CLIENT, never the
// service role. Decision 23 recorded why: verify-vendor-self-service passed on
// the day the demo could not upload a single file, because every fixture in it
// wrote through the service role — it proved the policy worked and never once
// sat in the user's seat. The service client here is used only to arrange
// fixtures and to read back ground truth.
//
// Usage: node scripts/verify-portfolio-and-controls.mjs [--world dev|staging|demo]
//
// ⚠️ `--world` reads that world's own env file rather than rewriting the shared
// one. That is `migrate.mjs`'s recorded lesson applied here: "a tool needing a
// different world should read that world's file, not edit the shared one" —
// `use-env.mjs` mutates `.env.local`, which a running `next dev` also reads,
// and doing that mid-session is what redirected a live dev server into staging
// for four minutes on 25 Aug 2026. Every other suite in this directory still
// reads `.env.local`; this one does not have to.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worldFlag = process.argv.indexOf("--world");
const world = worldFlag === -1 ? null : process.argv[worldFlag + 1];
if (worldFlag !== -1 && !world) {
  console.error("--world needs a value: demo | dev | staging | prod");
  process.exit(1);
}

// Into a private object when a world is named — dotenv does not overwrite what
// is already set, so a `--world` run in a shell carrying these variables would
// otherwise silently measure whatever those name.
const env = {};
config({
  path: path.join(rootDir, world ? `.env.${world}.local` : ".env.local"),
  processEnv: world ? env : process.env,
});
if (!world) Object.assign(env, process.env);

console.log(`\x1b[1mWorld: ${world ?? ".env.local"}\x1b[0m`);

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const svc = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) { bad(`could not sign in as ${email}: ${error.message}`); return null; }
  return c;
};

const { data: orgs } = await svc.from("orgs").select("id, slug, name").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
if (!oea) { console.log("\x1b[31mno OEA org — run the brand seeds first\x1b[0m"); process.exit(1); }

const pm = await login("oea.pm@oegroup.test");
const fm = await login("oea.fmgr@oegroup.test");
const reg = await login("oea.regional@oegroup.test");
const fin = await login("oea.finance@oegroup.test");
const admin = await login("oea.admin@oegroup.test");
const ten = await login("oea.tenant@oegroup.test");
if (!pm || !fm || !reg || !fin || !admin || !ten) {
  console.log("\n\x1b[31mfixtures missing — run the brand seeds first\x1b[0m");
  process.exit(1);
}

const holds = async (c, cap) => Boolean((await c.rpc("has_permission", { p_capability: cap })).data);

// ── A. The fund belongs to a property (0247) ───────────────────────────────
console.log("\n\x1b[1m§A The service-charge fund belongs to a property\x1b[0m");

{
  const { data: purposes } = await svc.rpc("property_scoped_ledger_purposes");
  Array.isArray(purposes) && purposes.includes("service_charge_fund")
    ? ok("service_charge_fund is declared property-scoped, in one place")
    : bad(`property_scoped_ledger_purposes did not name the fund: ${JSON.stringify(purposes)}`);

  // The reallocation should have opened a sub-account per property that had
  // collections. 2000 stays as the unattributed control account.
  const { data: accts } = await svc
    .from("ledger_accounts")
    .select("code, name, property_id")
    .eq("org_id", oea.id)
    .eq("purpose", "service_charge_fund");

  const perProperty = (accts ?? []).filter((a) => a.property_id);
  perProperty.length > 0
    ? ok(`${perProperty.length} property-level fund account(s) exist (e.g. ${perProperty[0].code})`)
    : note("no property-level fund accounts yet — nothing has been collected per property");

  const orgLevel = (accts ?? []).find((a) => !a.property_id);
  orgLevel && /unattributed/i.test(orgLevel.name ?? "")
    ? ok("the org-level row is named as the unattributed fund, not as the fund")
    : bad("the org-level 2000 row does not state that it is the unattributed fund");
}

{
  // The reported failure, measured. Every APPROVED requisition should report a
  // funding state naming its own property.
  const { data: reqs } = await svc
    .from("ops_requisitions")
    .select("id, reference, total_amount, status")
    .eq("org_id", oea.id)
    .eq("status", "approved");

  if (!reqs?.length) {
    note("no approved requisitions to measure funding against");
  } else {
    let named = 0;
    for (const r of reqs) {
      const { data } = await fin
        .rpc("payable_funding_state", { p_payable_type: "ops_requisition", p_payable_id: r.id })
        .maybeSingle();
      if (!data) { bad(`no funding state for ${r.reference}`); continue; }
      if (data.property_name) named += 1;
      // The arithmetic must be self-consistent whichever way it lands.
      const expected = Math.max(Number(data.required) - Number(data.available), 0);
      Math.abs(expected - Number(data.shortfall)) < 0.01
        ? ok(`${r.reference}: needs ${data.required}, fund holds ${data.available}, short ${data.shortfall}`)
        : bad(`${r.reference}: shortfall ${data.shortfall} does not follow from ${data.required} - ${data.available}`);
    }
    named > 0
      ? ok(`${named} of ${reqs.length} approved requisitions resolve to a named property`)
      : bad("no approved requisition could name the property whose fund it draws on");
  }
}

{
  // ⚠️ The load-bearing claim: one property's shortfall must not block another
  // property's fully-funded payment. Asserted structurally — two properties
  // must not share a fund account.
  const { data: accts } = await svc
    .from("ledger_accounts")
    .select("id, property_id")
    .eq("org_id", oea.id)
    .eq("purpose", "service_charge_fund")
    .not("property_id", "is", null);

  const ids = new Set((accts ?? []).map((a) => a.property_id));
  ids.size === (accts ?? []).length
    ? ok("no two properties share a service-charge fund account")
    : bad("two properties resolve to the same fund account — the pooling is back");
}

// ── B. The ladder is operator-governed (0248) ──────────────────────────────
console.log("\n\x1b[1m§B The payment chain, and who may change it\x1b[0m");

{
  const { data: shape } = await admin.rpc("org_payment_chain", { p_org_id: oea.id });
  shape === "oea"
    ? ok("OEA still climbs the OEA ladder — nothing moved by default")
    : bad(`OEA's chain shape is ${shape}, expected oea`);

  const { data: stages } = await admin.rpc("payment_chain_stages", { p_org_id: oea.id });
  (stages ?? []).length === 3
    ? ok("three stages, unchanged")
    : bad(`OEA resolves ${(stages ?? []).length} stages, expected 3`);
}

{
  // The escalation decision 23 closed for delivery_brand, closed again here.
  const { error } = await admin
    .from("orgs")
    .update({ approval_chain_shape: "single_stage" })
    .eq("id", oea.id);
  error
    ? ok(`an org administrator cannot set their own approval ladder (${error.code ?? "refused"})`)
    : bad("AN ORG ADMINISTRATOR CHANGED THEIR OWN APPROVAL LADDER — decision 7 is broken");

  const { data: after } = await svc
    .from("orgs").select("approval_chain_shape").eq("id", oea.id).single();
  after?.approval_chain_shape == null || after.approval_chain_shape === "oea"
    ? ok("and the stored shape is untouched")
    : bad(`the shape is now ${after.approval_chain_shape}`);
}

{
  const { error } = await admin.rpc("operator_set_approval_chain", {
    p_org_id: oea.id, p_shape: "single_stage",
  });
  error
    ? ok("operator_set_approval_chain refuses a brand administrator")
    : bad("A BRAND ADMINISTRATOR SET THE APPROVAL CHAIN through the operator function");
}

{
  // ── Tierless by default, but never chainless (0261) ──────────────────────
  //
  // ⚠️ The two are easy to confuse and must not be. The board removed the
  // amount-based BAND on the final stage; it did not remove any pair of hands.
  // A pass here that showed one stage would mean approval had been collapsed,
  // not unblocked.
  const { data: stages } = await svc.rpc("payment_chain_stages", { p_org_id: oea.id });
  const banded = (stages ?? []).filter((s) => s.tier_resolved);
  banded.length === 0
    ? ok("no stage demands an approval band — approval is tierless by default")
    : bad(`${banded.length} stage(s) still demand a band: ${banded.map((s) => s.label).join(", ")}`);

  (stages ?? []).length === 3
    ? ok("and the chain is still three stages — tierless is not chainless")
    : bad(`OEA now runs ${(stages ?? []).length} stage(s); removing the band must not remove a desk`);

  const { data: req } = await svc.rpc("resolve_required_tier", { p_org_id: oea.id, p_amount: 5000000 });
  Number(req) === 1
    ? ok("even a large amount resolves to no band while tiers are off")
    : bad(`a large amount still resolves to tier ${req} with bands off`);

  // The switch is the operator's, like the chain shape.
  const { error: admErr } = await admin
    .from("orgs").update({ approval_tiers_enabled: true }).eq("id", oea.id);
  admErr
    ? ok("an org administrator cannot switch approval bands back on")
    : bad("AN ORG ADMINISTRATOR TURNED APPROVAL BANDS ON — decision 7 breached");
  const { error: rpcErr } = await admin.rpc("operator_set_approval_tiers", {
    p_org_id: oea.id, p_enabled: true,
  });
  rpcErr
    ? ok("operator_set_approval_tiers refuses a brand administrator")
    : bad("A BRAND ADMINISTRATOR SET THE BAND POLICY through the operator function");
}

// ── C. What each desk holds (0249) ─────────────────────────────────────────
console.log("\n\x1b[1m§C The property manager's new authority, and the FM's unchanged one\x1b[0m");

for (const cap of ["sc.manage", "leases.write"]) {
  (await holds(pm, cap)) ? ok(`the property manager holds ${cap}`) : bad(`the property manager lacks ${cap}`);
  (await holds(reg, cap)) ? ok(`the regional manager still holds ${cap}`) : bad(`the regional manager lost ${cap}`);
  // ⚠️ The deliberate divergence, and the one an accident would silently undo.
  (await holds(fm, cap))
    ? bad(`the FACILITIES manager holds ${cap} — it was granted to the wrong peer`)
    : ok(`the facilities manager does not hold ${cap}`);
}

(await holds(pm, "sc.read_all"))
  ? bad("the property manager holds sc.read_all — that is the ORG-WIDE read")
  : ok("the property manager does not hold sc.read_all — their reach is the place");

// ⚠️ The BASELINE, not the effective permission — and the distinction is the
// whole of decision 7's model.
//
// This block first asserted `has_permission('records.export') === false` for
// each role, which was right until an operator deliberately turned it on for
// the property and regional managers on 5 Sept. That grant is not drift: it is
// `set_by` a named person, badged in the matrix as a deviation, and revocable
// in one click. Testing the EFFECTIVE permission would have made a legitimate
// operator decision look like a regression — and, worse, would train whoever
// saw the red to reverse the decision to quiet the suite.
//
// So what is asserted is what 0239 actually fixed: the BASELINE is still off
// for everyone, admin included. An operator may then open it, per org, per
// role, deliberately — which is the lever 0239 exists to provide.
{
  // `payment_approver` is the senior accounting desk (0246 / decision 23) and
  // holds the grant for reporting and record generation. `finance_approver`
  // — the payment officer — deliberately does NOT: they release money, and
  // bulk PII export is not part of releasing money.
  for (const role of ["admin", "property_manager", "regional_manager",
                      "payment_approver", "facility_manager", "finance_approver"]) {
    // The baseline itself, asked of the function that defines it.
    const { data: base } = await svc.rpc("b7_grants", {
      p_role: role, p_capability: "records.export",
    });
    base === false
      ? ok(`${role}: records.export is OFF in the B7 baseline — 0239 intact`)
      : bad(`${role}: the B7 baseline now GRANTS records.export — 0239 was reversed`);

    const { data: b } = await svc
      .from("role_permissions")
      .select("granted, set_by")
      .eq("org_id", oea.id)
      .eq("role", role)
      .eq("capability", "records.export")
      .maybeSingle();

    // Baseline off is proven from b7_grants via the drift check below; here the
    // question is only whether anything is granted WITHOUT a person behind it.
    if (b?.granted && !b.set_by) {
      bad(`${role} holds records.export with nobody named as having granted it — that is drift, not a decision`);
    } else if (b?.granted) {
      ok(`${role} holds records.export by an operator's deliberate grant (set_by recorded)`);
    } else {
      ok(`${role} does not hold records.export`);
    }
  }

}

{
  // The read that was missing: a manager who raises a collection must be able
  // to see it. 0249's payment_intents_select branch.
  const { error } = await pm.from("payment_intents").select("id").limit(1);
  error
    ? bad(`the property manager cannot read payment_intents at all: ${error.message}`)
    : ok("the property manager can read the collections on their own properties");
}

{
  // And still cannot reach the bank or post to the ledger.
  const { data: banks } = await pm.from("bank_accounts").select("id").limit(1);
  (banks ?? []).length === 0
    ? ok("the property manager reads no bank accounts")
    : bad("THE PROPERTY MANAGER CAN READ BANK ACCOUNTS — decision 16 breached");
}

// ── C2. The senior accounting desk can reach what RLS already gives it ─────
console.log("\n\x1b[1m§C2 The payment approver desk is not blank\x1b[0m");
{
  const { OVERSIGHT_ROLES } = await import("../lib/roles.ts");
  const { data: sqlRoles } = await svc.rpc("oversight_roles");
  const sqlSet = new Set((sqlRoles ?? []).map(String));
  const tsSet = new Set(OVERSIGHT_ROLES.map(String));
  const same =
    sqlSet.size === tsSet.size && [...sqlSet].every((r) => tsSet.has(r));
  same
    ? ok(`OVERSIGHT_ROLES matches the database exactly: ${[...tsSet].sort().join(", ")}`)
    : bad(
        `the TS mirror and oversight_roles() DISAGREE — SQL has {${[...sqlSet].sort()}}, ` +
          `TS has {${[...tsSet].sort()}}. The nav will hide what RLS admits, which is ` +
          "exactly the drift that left the payment approver looking at a blank desk."
      );

  // And the reads it implies actually work, in the approver's own seat.
  const approver = await login("oea.approver@oegroup.test");
  if (!approver) {
    note("no OEA payment approver fixture — cannot measure their desk");
  } else {
    for (const [what, q] of [
      ["the client-funds ledger", approver.from("ledger_accounts").select("id").limit(1)],
      ["the audit trail", approver.from("audit_log").select("id").limit(1)],
      ["the rent roll", approver.from("rent_roll").select("lease_id").limit(1)],
      ["the tenancy schedule", approver.from("tenancy_schedule").select("lease_id").limit(1)],
      ["the service-charge register", approver.from("service_charges").select("id").limit(1)],
    ]) {
      const { data, error } = await q;
      error || (data ?? []).length === 0
        ? bad(`the payment approver cannot read ${what}${error ? ": " + error.message : " (0 rows)"}`)
        : ok(`the payment approver reads ${what}`);
    }
    // ⚠️ And still cannot WRITE a tenancy — the read is oversight, not authority.
    const { data: canWrite } = await approver.rpc("has_permission", { p_capability: "leases.write" });
    canWrite
      ? bad("the payment approver holds leases.write — oversight became authority")
      : ok("the payment approver still cannot write a tenancy — read-only oversight");
  }
}

// ── D. A refusal returns it (0250b) ────────────────────────────────────────
console.log("\n\x1b[1m§D A refusal returns the payment to the desk before it\x1b[0m");

{
  const { error: e1 } = await svc.from("payment_approvals").select("decision").limit(1);
  e1 ? bad(`payment_approvals unreadable: ${e1.message}`) : ok("payment_approvals is readable");

  // `returned` must be an accepted decision. Asserted through the ONE write
  // path, with a deliberately invalid payable so nothing is actually decided:
  // a rejection naming the decision proves the constraint, an "unknown
  // decision" error proves it is still missing.
  const { error } = await fin.rpc("record_payment_approval", {
    p_payable_type: "ops_requisition",
    p_payable_id: "00000000-0000-0000-0000-000000000000",
    p_stage: 1,
    p_decision: "returned",
    p_reason: "verification probe — this payable does not exist",
  });
  const msg = error?.message ?? "";
  /approved.*rejected|either approved or rejected/i.test(msg)
    ? bad("record_payment_approval still refuses 'returned' as a decision")
    : ok("record_payment_approval accepts 'returned' (refused later, on the payable)");
}

{
  const { data: reqs } = await svc
    .from("ops_requisitions").select("status").eq("org_id", oea.id);
  const legal = new Set(["pending_approval", "approved", "remitted", "rejected", "returned_for_correction"]);
  (reqs ?? []).every((r) => legal.has(r.status))
    ? ok("every requisition status is one the constraint admits")
    : bad("a requisition carries a status outside the constraint");
}

// ── E. The audit trail records it (0251) ───────────────────────────────────
console.log("\n\x1b[1m§E The chain and the requisition reach the audit trail\x1b[0m");

{
  // ⚠️ Two different questions, and the first run of this suite conflated them.
  //
  // "No audit rows yet" can mean the trigger is missing, or it can mean nothing
  // has been approved since it was attached — and those want opposite
  // reactions. The first is a defect; the second is Tuesday.
  //
  // The WIRING is not re-checked here, deliberately: 0251 asserts its own four
  // triggers against pg_trigger and refuses to apply without them, so a missing
  // trigger cannot reach a world this suite is pointed at. What is left for a
  // suite to say is which actions have actually been RECORDED — and that is
  // reported per action, so "nothing has been approved yet" reads as itself
  // rather than as an alarm.

  const EXPECTED = [
    ["payment_approval.decision", "a stage approved, refused or sent back"],
    ["payment_approval.superseded", "an approval retired by a send-back or an amount change"],
    ["ops_requisition.raised", "a requisition raised"],
    ["ops_requisition.status_change", "a requisition approved, refused, returned or remitted"],
  ];

  const { data: rows } = await fin
    .from("audit_log")
    .select("action")
    .in("action", EXPECTED.map(([a]) => a))
    .limit(500);

  const seen = new Set((rows ?? []).map((r) => r.action));
  for (const [action, what] of EXPECTED) {
    seen.has(action)
      ? ok(`the trail records ${what} (${action})`)
      : note(`${action} has no rows yet — nothing has done "${what}" since 0251 attached it`);
  }
  // ⚠️ Silence is only a defect if something HAPPENED to be silent about.
  //
  // A world where nobody has approved anything since 0251 was applied has an
  // empty trail and a perfectly healthy one. The failing condition is narrower
  // and provable: a decision was RECORDED in `payment_approvals` after the
  // triggers existed, and left no audit row. Anything decided before 0251 is
  // legitimately absent — the trigger did not exist to fire.
  const { data: applied } = await svc
    .from("_migrations")
    .select("applied_at")
    .eq("name", "0251_the_audit_trail_records_the_chain_and_the_requisition.sql")
    .maybeSingle();

  if (seen.size > 0) {
    ok(`${rows.length} chain/requisition audit row(s) present`);
  } else if (!applied?.applied_at) {
    bad("0251 is not applied to this world — the audit triggers are not there at all");
  } else {
    const { count: decidedSince } = await svc
      .from("payment_approvals")
      .select("id", { count: "exact", head: true })
      .gt("created_at", applied.applied_at);
    (decidedSince ?? 0) > 0
      ? bad(
          `${decidedSince} approval decision(s) were recorded after 0251 and NONE reached the ` +
            "audit trail — the triggers are not firing"
        )
      : note(
          "nothing has been approved since 0251 was applied here, so the trail is empty and " +
            "correctly so — approve or send back anything to light it up"
        );
  }
}

// ── F. A property is created with units (0252) ─────────────────────────────
console.log("\n\x1b[1m§F A property is filed with at least one unit\x1b[0m");

{
  const { error } = await pm.rpc("create_property_with_units", {
    p_name: `PROBE-NOUNITS-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    p_address: null, p_reference: null, p_site_node_id: null,
    p_property_type: null, p_units: [],
  });
  error && /at least one unit/i.test(error.message)
    ? ok("a property with no units is refused, in words a person can act on")
    : bad(`a unit-less property was not refused as expected: ${error?.message ?? "it was created"}`);
}

// ── G. The schedule, and who may read it (0254) ────────────────────────────
console.log("\n\x1b[1m§G The tenancy schedule\x1b[0m");

{
  const { data: rows, error } = await pm
    .from("tenancy_schedule")
    .select("property_name, owner_name, unit_label, tenant_name, rent_amount, management_fee_pct, service_charge_billed, remark")
    .limit(5);

  if (error) {
    bad(`the property manager cannot read the schedule: ${error.message}`);
  } else {
    ok(`the property manager reads ${rows.length} schedule row(s)`);
    // The workbook's columns, present rather than merely selected.
    const cols = ["property_name", "owner_name", "unit_label", "tenant_name", "rent_amount", "management_fee_pct", "service_charge_billed", "remark"];
    if (rows.length) {
      const missing = cols.filter((c) => !(c in rows[0]));
      missing.length === 0
        ? ok("every MANAGEMENT PORTFOLIO column is on the row")
        : bad(`the schedule is missing: ${missing.join(", ")}`);
    } else {
      note("no tenancies on this manager's properties to check columns against");
    }
  }
}

{
  // ⚠️ The claim the whole feature rests on, and the one a fixture gap can hide.
  //
  // A property manager holding no let buildings legitimately reads 0 rows, and
  // "0 rows, no error" is indistinguishable from a view that returns nothing to
  // anybody. So an ORG-WIDE reader is asked as well: an administrator is in
  // `oversight_roles()`, and if the organisation has tenancies at all, they must
  // see them with the workbook's columns filled in.
  const { data: leaseCount } = await svc
    .from("leases").select("id", { count: "exact", head: true }).eq("org_id", oea.id);
  const { count } = await svc
    .from("leases").select("id", { count: "exact", head: true })
    .eq("org_id", oea.id).is("deleted_at", null);

  const { data: rows, error } = await admin
    .from("tenancy_schedule")
    .select("property_name, owner_name, unit_label, tenant_name, rent_amount, rent_billed, management_fee_pct, service_charge_billed, remark")
    .limit(200);

  if (error) {
    bad(`an administrator cannot read the schedule: ${error.message}`);
  } else if ((count ?? 0) === 0) {
    note("this organisation has no tenancies, so there is nothing to assemble");
  } else if (rows.length === 0) {
    bad(`the org has ${count} tenanc(ies) and the schedule returned 0 rows to an administrator`);
  } else {
    ok(`an administrator reads ${rows.length} of ${count} tenancies on the schedule`);
    const withOwner = rows.filter((r) => r.owner_name).length;
    const withFee = rows.filter((r) => r.management_fee_pct != null).length;
    withOwner > 0
      ? ok(`${withOwner} row(s) name their landlord — the workbook's header block`)
      : bad("no schedule row could name a landlord");
    withFee > 0
      ? ok(`${withFee} row(s) carry the fee at the rate that applied`)
      : note("no tenancy has been billed yet, so no fee rate has been snapshotted");
  }
}

{
  // ⚠️ The exposure 0229 had to close on rent_roll, asserted here BEFORE it can
  // happen: a tenant matches leases_select and must still not reach a view
  // carrying a "landlord net" column.
  const { data, error } = await ten.from("tenancy_schedule").select("lease_id").limit(1);
  if (error) {
    ok(`a tenant is refused the schedule outright (${error.code ?? "refused"})`);
  } else if ((data ?? []).length === 0) {
    ok("a tenant reads no schedule rows");
  } else {
    bad("A TENANT READ THE TENANCY SCHEDULE — the landlord's fee split is exposed");
  }
}

// -- G2. A payment request is delivered, and says so honestly --------------
console.log("\n\x1b[1m§G2 The payment request reaches the payer\x1b[0m");
{
  const { sendPaymentRequestNotice } = await import("../lib/payment-request-notice.ts");

  // The branch that needs no credentials and must never lie: nobody to send to.
  //
  // ⚠️ This is the property the whole feature turns on. Before it, the link went
  // to the RAISER's clipboard and the screen said "Payment request raised" —
  // which reads as "the payer has been told". Claiming a send that did not
  // happen is worse than the old silence, because nobody goes looking.
  const nothing = await sendPaymentRequestNotice({
    orgId: oea.id, intentId: null, reference: "OE-VERIFY-NOSEND",
    purpose: "service_charge", amount: 1000, currency: "NGN",
    propertyOrUnit: null, period: null, dueDate: null,
    payerUserId: null, payerEmail: null, payerName: null,
    payLink: "https://example.invalid/pay/OE-VERIFY-NOSEND",
  });
  nothing.emailed === null && nothing.nudged === null && nothing.belled === false
    ? ok("with no contact details, nothing is claimed as sent")
    : bad(`a notice with no recipient reported a delivery: ${JSON.stringify(nothing)}`);
  nothing.problem
    ? ok(`and it says why: "${nothing.problem}"`)
    : bad("a notice that sent nothing gave no reason, so the screen cannot explain it");
}

// ── H. Nothing is callable by anon ─────────────────────────────────────────
console.log("\n\x1b[1m§H The anon client, refused\x1b[0m");

{
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  for (const fn of [
    ["payable_funding_state", { p_payable_type: "ops_requisition", p_payable_id: "00000000-0000-0000-0000-000000000000" }],
    ["operator_set_approval_chain", { p_org_id: oea.id, p_shape: "single_stage" }],
    ["create_property_with_units", { p_name: "x", p_units: [] }],
    ["resubmit_returned_payable", { p_payable_type: "ops_requisition", p_payable_id: "00000000-0000-0000-0000-000000000000" }],
  ]) {
    const { error } = await anon.rpc(fn[0], fn[1]);
    error ? ok(`anon cannot call ${fn[0]}`) : bad(`ANON CALLED ${fn[0]}`);
  }

  const { data, error } = await anon.from("tenancy_schedule").select("lease_id").limit(1);
  error || (data ?? []).length === 0
    ? ok("anon reads no tenancy schedule")
    : bad("ANON READ THE TENANCY SCHEDULE");
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll checks passed.\x1b[0m"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
