// Verifies 0325/0327: the Owner Rep sees every request on the properties they
// represent, may raise one there, sees those properties, their units and a
// cost-free asset register — and never sees money, by any switch.
//
// Every act runs in a signed-in user's own session (`set local role
// authenticated` with their claims), inside ONE transaction that is rolled
// back at the end — nothing this suite writes survives it, including the
// Owner Rep account itself.
//
// Usage: node scripts/verify-owner-representative.mjs [--env .env.dev.local]
import path from "node:path";
import crypto from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { requireNonProductionTarget } from "./lib/target-env.mjs";

const envArg = process.argv.indexOf("--env");
const envFile = envArg > -1 ? process.argv[envArg + 1] : ".env.local";
config({ path: path.join(process.cwd(), envFile), quiet: true, override: true });
requireNonProductionTarget(process.cwd(), "Writes Owner Rep fixtures in a rolled-back transaction.");

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const check = (cond, m, detail) => (cond ? ok(m) : bad(detail ? `${m} — ${detail}` : m));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const count = async (sql, p) => Number((await one(`select count(*)::int n from (${sql}) x`, p)).n);

async function as(uid) {
  await db.query("set local role authenticated");
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: uid, role: "authenticated" }),
  ]);
}
async function asOwner() {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', '', true)");
}
async function refused(sql, params) {
  await db.query("savepoint s");
  try {
    const r = await db.query(sql, params);
    await db.query("release savepoint s");
    refused.last = r;
    return null;
  } catch (e) {
    await db.query("rollback to savepoint s");
    return e.message;
  }
}
async function newUser(orgId, role, label) {
  const id = crypto.randomUUID();
  const email = `probe-ownerrep-${label}-${id.slice(0, 8)}@oegroup.test`;
  await db.query(
    "insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')",
    [id, email]
  );
  await db.query(
    "insert into users (id, org_id, role, full_name, email) values ($1, $2, $3, $4, $5)",
    [id, orgId, role, `Probe ${label}`, email]
  );
  return id;
}

// Every live consumer of the place resolver, and what an Owner Rep gets
// through it. A consumer missing from this list fails the suite until someone
// decides — the same enumeration-not-batch shape 0276 uses for notifications.
const REVIEWED_POLICIES = {
  // refused outright (money, tenancy terms, applicant PII, asset costs)
  "rent_charges.rent_charges_select": "refuse",
  "sc_budgets.sc_budgets_select": "refuse",
  "service_charges.service_charges_select": "refuse",
  "leases.leases_select": "refuse",
  "lease_notices.lease_notices_select": "refuse",
  "tenant_applications.tenant_applications_staff_select": "refuse",
  "application_document_findings.application_document_findings_select": "refuse",
  "assets.assets_select": "refuse",
  // behind a switch
  "properties.properties_select": "switch",
  "units.units_select": "switch",
  "tickets.tickets_select": "switch",
  "tickets.tickets_insert": "switch",
  // role- or capability-gated, the Owner Rep holds none of what they ask
  "asset_certificates.asset_certificates_write": "gated",
  "asset_identifiers.asset_identifiers_write": "gated",
  "assets.assets_insert": "gated",
  "assets.assets_update": "gated",
  "leases.leases_write": "gated",
  "ledger_accounts.ledger_accounts_select": "gated",
  "ledger_entries.ledger_entries_select": "gated",
  "ledger_postings.ledger_postings_select": "gated",
  "payment_intents.payment_intents_select": "gated",
  "sc_budgets.sc_budgets_insert": "gated",
  "sc_budgets.sc_budgets_update": "gated",
  "sc_budgets.sc_budgets_delete": "gated",
  "service_charges.service_charges_insert": "gated",
  "service_charges.service_charges_update": "gated",
  "tenant_applications.tenant_applications_staff_update": "gated",
};
const REVIEWED_FUNCTIONS = new Set([
  // refused for the Owner Rep in their own body (0327)
  "property_statement", "property_statement_lines", "create_rent_payment_intent",
  "create_service_charge_payment_intent", "archived_assets", "find_asset_by_identifier",
  "contest_document_finding", "owner_rep_asset_register",
  // capability- or role-gated before the place is read
  "assign_application_unit", "issue_tenancy_offer", "withdraw_tenancy_offer",
  "record_application_approval", "record_application_info_request",
  "record_application_recommendation", "record_application_rejection",
  "log_asset_running_hours", "restore_asset", "archive_asset", "raise_work_order",
  "resubmit_returned_payable", "retire_service_charges_for_regenerate", "void_sc_budget",
  "offline_allocatable_charges", "write_offline_claim_allocations", "may_read_offline_claim",
  "current_user_may_attach_property", "current_user_scoped_vendor_ids",
  "correct_lease_terms", "correct_rent_charge", "reopen_sc_budget_for_correction",
  // service-role only, or no data
  "system_recommend_application", "b7_grants",
  // names the managers of a property — no money, no tenant data
  "property_managers",
  // the resolver itself
  "current_user_property_ids",
]);
const REVIEWED_VIEWS = new Set(["application_overview", "rent_roll", "tenancy_schedule"]);

console.log(`\nOwner Rep (0325/0327) · ${envFile}`);
await db.connect();
await db.query("begin");

try {
  const org = await one("select id from orgs where slug = 'oea' and deleted_at is null");
  const pm = await one(
    `select u.id from users u where u.org_id = $1 and u.role = 'property_manager'
        and u.deactivated_at is null and u.email like 'oea.%@oegroup.test' order by u.email limit 1`,
    [org.id]
  );
  if (!pm) throw new Error("demo property manager missing");

  const P = await one(
    `select p.id from properties p
      where p.org_id = $1 and p.deleted_at is null
        and exists (select 1 from units u where u.property_id = p.id and u.deleted_at is null)
      order by p.created_at limit 1`,
    [org.id]
  );
  const Q = await one(
    "select id from properties where org_id = $1 and deleted_at is null and id <> $2 order by created_at limit 1",
    [org.id, P.id]
  );
  const unit = await one("select id from units where property_id = $1 and deleted_at is null order by label limit 1", [P.id]);

  // Fixtures, as the database owner.
  const rep = await newUser(org.id, "owner_representative", "rep");
  const tenant = await newUser(org.id, "tenant", "tenant");
  await db.query(
    "insert into property_stakeholders (org_id, property_id, user_id, relation) values ($1, $2, $3, 'representative')",
    [org.id, P.id, rep]
  );
  // The PM manages P for the duration, so the "others are unchanged" checks have a subject.
  await db.query(
    `insert into property_stakeholders (org_id, property_id, user_id, relation)
     values ($1, $2, $3, 'manager') on conflict do nothing`,
    [org.id, P.id, pm.id]
  );
  const tP = await one(
    `insert into tickets (org_id, sender_id, channel, message_text, status, property_id, sender_role)
     values ($1, $2, 'portal', 'PROBE leaking tap on P', 'open', $3, 'tenant') returning id`,
    [org.id, tenant, P.id]
  );
  const tQ = await one(
    `insert into tickets (org_id, sender_id, channel, message_text, status, property_id, sender_role)
     values ($1, $2, 'portal', 'PROBE broken lift on Q', 'open', $3, 'tenant') returning id`,
    [org.id, tenant, Q.id]
  );
  const lease = await one(
    `insert into leases (org_id, property_id, unit_id, tenant_name, start_date, end_date, rent_amount, rent_frequency, status)
     values ($1, $2, $3, 'PROBE Tenant Ltd', current_date, current_date + 365, 1200000, 'annual', 'draft') returning id`,
    [org.id, P.id, unit.id]
  );
  const charge = await one(
    `insert into rent_charges (org_id, lease_id, period_start, period_end, due_date, amount, currency,
                               management_fee_pct, management_fee_amount, admin_fee_amount, landlord_net_amount)
     values ($1, $2, '2399-01-01', '2399-12-31', '2399-01-01', 1200000, 'NGN', 10, 120000, 0, 1080000) returning id`,
    [org.id, lease.id]
  );
  const budget = await one(
    `insert into sc_budgets (org_id, property_id, period, total_amount, status)
     values ($1, $2, $3, 500000, 'draft') returning id`,
    [org.id, P.id, `OWNERREP-${crypto.randomBytes(3).toString("hex")}`]
  );
  await db.query(
    `insert into service_charges (org_id, budget_id, unit_id, billing_period, amount, status, property_or_unit)
     values ($1, $2, $3, 'probe', 500000, 'invoiced', 'probe')`,
    [org.id, budget.id, unit.id]
  );
  const asset = await one(
    `insert into assets (org_id, property_id, asset_tag, name, purchase_cost, replacement_cost, insured_value, quantity)
     values ($1, $2, $3, 'PROBE chiller', 9000000, 12000000, 10000000, 3) returning id`,
    [org.id, P.id, `OWNERREP-${crypto.randomBytes(3).toString("hex")}`]
  );

  section("A. The switches, and nothing else");
  await as(rep);
  const caps = (await one("select my_capabilities() c")).c;
  check(
    JSON.stringify([...caps].sort()) === JSON.stringify([
      "owner_rep.analytics", "owner_rep.assets", "owner_rep.properties",
      "owner_rep.requests_raise", "owner_rep.requests_read",
    ]),
    "an Owner Rep holds exactly its five switches at baseline", JSON.stringify(caps)
  );
  await asOwner();
  await db.query(
    `insert into role_permissions (org_id, role, capability, granted) values ($1, 'owner_representative', 'leases.read', true)
     on conflict (org_id, role, capability) do update set granted = true`,
    [org.id]
  );
  await as(rep);
  check((await one("select has_permission('leases.read') h")).h === false,
    "a role_permissions row granting it leases.read grants nothing");
  check(!(await one("select my_capabilities() c")).c.includes("leases.read"),
    "and my_capabilities does not report it");
  await asOwner();
  let m = await refused("select set_role_permission($1, 'owner_representative', 'sc.read_all', true)", [org.id]);
  check(/holds only its own switches/.test(m ?? ""), "the matrix refuses to grant it a money capability", m);
  m = await refused("select set_role_permission($1, 'property_manager', 'owner_rep.requests_read', true)", [org.id]);
  check(/means nothing for any other role/.test(m ?? ""), "the matrix refuses an Owner Rep switch for another role", m);

  section("B. The properties they represent, and no others");
  await as(rep);
  check(await count("select id from properties where id = $1", [P.id]) === 1, "sees the property they represent");
  check(await count("select id from properties where id = $1", [Q.id]) === 0, "does not see another property");
  check(await count("select id from units where property_id = $1", [P.id]) > 0, "sees its units");

  section("C. Every request on those properties");
  check(await count("select id from tickets where id = $1", [tP.id]) === 1, "sees a tenant's request on their property");
  check(await count("select id from tickets where id = $1", [tQ.id]) === 0, "does not see a request on another property");

  section("D. Raising");
  m = await refused(
    `insert into tickets (org_id, sender_id, channel, message_text, status, property_id)
     values ($1, $2, 'portal', 'PROBE rep raises on P', 'open', $3) returning id`,
    [org.id, rep, P.id]
  );
  check(m === null, "raises a request on their property", m);
  const raised = refused.last?.rows?.[0]?.id;
  m = await refused(
    `insert into tickets (org_id, sender_id, channel, message_text, status, property_id)
     values ($1, $2, 'portal', 'PROBE rep raises on Q', 'open', $3)`,
    [org.id, rep, Q.id]
  );
  check(m !== null, "cannot raise on a property they do not represent", m);
  m = await refused(
    `insert into tickets (org_id, sender_id, channel, message_text, status)
     values ($1, $2, 'portal', 'PROBE rep raises nowhere', 'open')`,
    [org.id, rep]
  );
  check(m !== null, "cannot raise a request with no property", m);
  if (raised) {
    const row = await one("select sender_role from tickets where id = $1", [raised]);
    check(row?.sender_role === "owner_representative", "the request carries sender_role = owner_representative", row?.sender_role);
  }

  section("E. No money, anywhere");
  for (const [label, sql] of [
    ["rent demands", "select id from rent_charges where lease_id = '" + lease.id + "'"],
    ["the tenancy", "select id from leases where id = '" + lease.id + "'"],
    ["the rent roll", "select lease_id from rent_roll where property_id = '" + P.id + "'"],
    ["the tenancy schedule", "select lease_id from tenancy_schedule where property_id = '" + P.id + "'"],
    ["service-charge budgets", "select id from sc_budgets where property_id = '" + P.id + "'"],
    ["service-charge invoices", "select id from service_charges where budget_id = '" + budget.id + "'"],
    ["lease notices", "select id from lease_notices"],
    ["payment requests", "select id from payment_intents"],
    ["payments", "select id from payments"],
    ["remittances", "select id from remittances"],
    ["ledger accounts", "select id from ledger_accounts"],
    ["ledger postings", "select id from ledger_postings"],
    ["the asset table (it carries costs)", "select id from assets where id = '" + asset.id + "'"],
    ["archived assets", "select id from archived_assets()"],
    ["tenancy applications", "select id from tenant_applications"],
    ["the application overview", "select id from application_overview"],
    ["the property statement", "select * from property_statement('" + P.id + "', '2000-01-01', '2999-12-31', null)"],
    ["the property statement lines", "select * from property_statement_lines('" + P.id + "', '2000-01-01', '2999-12-31', null)"],
  ]) {
    const n = await count(sql);
    check(n === 0, `cannot read ${label}`, `${n} row(s)`);
  }
  m = await refused("select create_rent_payment_intent($1, 'simulated')", [charge.id]);
  check(m !== null, "cannot raise a payment request against a rent demand", m);

  section("F. The asset register, without its costs");
  const reg = await db.query("select * from owner_rep_asset_register()");
  const mine = reg.rows.find((r) => r.id === asset.id);
  check(Boolean(mine), "the register lists the asset on their property");
  check(mine && mine.quantity === 3, "with its quantity", String(mine?.quantity));
  const cols = reg.fields.map((f) => f.name);
  check(!cols.some((c) => /cost|insur|value|notes|custom/.test(c)),
    "and no cost, insured value, notes or custom field column", cols.filter((c) => /cost|insur|value|notes|custom/.test(c)).join(","));

  section("G. Switched off");
  await asOwner();
  await db.query(
    `update role_permissions set granted = false
      where org_id = $1 and role = 'owner_representative'
        and capability in ('owner_rep.requests_read', 'owner_rep.requests_raise', 'owner_rep.assets', 'owner_rep.properties')`,
    [org.id]
  );
  await as(rep);
  check(await count("select id from tickets where id = $1", [tP.id]) === 0, "requests_read off: a tenant's request is hidden");
  if (raised) check(await count("select id from tickets where id = $1", [raised]) === 1, "but the request they raised stays theirs");
  m = await refused(
    `insert into tickets (org_id, sender_id, channel, message_text, status, property_id)
     values ($1, $2, 'portal', 'PROBE rep raises while off', 'open', $3)`,
    [org.id, rep, P.id]
  );
  check(m !== null, "requests_raise off: raising is refused", m);
  check(await count("select id from owner_rep_asset_register()") === 0, "assets off: the register is empty");
  check(await count("select id from properties where id = $1", [P.id]) === 0, "properties off: the property is hidden");

  section("H. Who may be attached as a representative");
  await asOwner();
  m = await refused(
    `insert into invitations (org_id, email, role, token_hash, invited_by)
     values ($1, 'probe-ownerrep-inv@oegroup.test', 'owner_representative', $2, $3)`,
    [org.id, crypto.randomBytes(16).toString("hex"), pm.id]
  );
  check(/choose at least one/.test(m ?? ""), "an Owner Rep invitation with no property is refused", m);
  m = await refused(
    `insert into invitations (org_id, email, role, token_hash, invited_by, property_ids, property_relation)
     values ($1, 'probe-ownerrep-inv2@oegroup.test', 'owner_representative', $2, $3, array[$4]::uuid[], 'manager')
     returning property_relation::text r`,
    [org.id, crypto.randomBytes(16).toString("hex"), pm.id, P.id]
  );
  check(m === null && refused.last.rows[0].r === "representative",
    "the relation follows the role (manager is overwritten to representative)", m ?? refused.last.rows[0].r);
  m = await refused(
    "insert into property_stakeholders (org_id, property_id, user_id, relation) values ($1, $2, $3, 'manager')",
    [org.id, Q.id, rep]
  );
  check(/as its representative, and to nothing else/.test(m ?? ""), "an Owner Rep cannot be attached as a manager", m);
  m = await refused(
    "insert into property_stakeholders (org_id, property_id, user_id, relation) values ($1, $2, $3, 'representative')",
    [org.id, Q.id, pm.id]
  );
  check(/Only an Owner Rep/.test(m ?? ""), "a property manager cannot be attached as a representative", m);

  section("I. Everyone else is unchanged");
  await as(pm.id);
  check(await count("select id from rent_charges where id = $1", [charge.id]) === 1, "the property manager still reads the rent demand");
  check(await count("select id from sc_budgets where id = $1", [budget.id]) === 1, "and the budget");
  check(await count("select id from tickets where id = $1", [tP.id]) === 1, "and the request");
  check(await count("select id from assets where id = $1", [asset.id]) === 1, "and the asset, costs included");

  section("J. Every reader of the place resolver has been decided for the Owner Rep");
  await asOwner();
  const pols = (await db.query(
    `select c.relname || '.' || p.polname k from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relnamespace = 'public'::regnamespace
        and (pg_get_expr(p.polqual, p.polrelid) like '%current_user_property_ids%'
             or pg_get_expr(p.polwithcheck, p.polrelid) like '%current_user_property_ids%')`
  )).rows.map((r) => r.k);
  const unknownPols = pols.filter((k) => !(k in REVIEWED_POLICIES));
  check(unknownPols.length === 0, `all ${pols.length} policies reading the resolver are reviewed`, unknownPols.join(", "));
  const fns = (await db.query(
    `select distinct proname from pg_proc where pronamespace = 'public'::regnamespace
        and prosrc like '%current_user_property_ids%'`
  )).rows.map((r) => r.proname);
  const unknownFns = fns.filter((f) => !REVIEWED_FUNCTIONS.has(f));
  check(unknownFns.length === 0, `all ${fns.length} functions reading the resolver are reviewed`, unknownFns.join(", "));
  const views = (await db.query(
    `select relname from pg_class where relkind = 'v' and relnamespace = 'public'::regnamespace
        and pg_get_viewdef(oid) like '%current_user_property_ids%'`
  )).rows.map((r) => r.relname);
  const unknownViews = views.filter((v) => !REVIEWED_VIEWS.has(v));
  check(unknownViews.length === 0, `all ${views.length} views reading the resolver are reviewed`, unknownViews.join(", "));
  for (const [k, mode] of Object.entries(REVIEWED_POLICIES)) {
    if (mode !== "refuse") continue;
    const [t, p] = k.split(".");
    const row = await one(
      "select pg_get_expr(polqual, polrelid) q from pg_policy where polrelid = $1::regclass and polname = $2",
      [t, p]
    );
    if (!row || !/NOT caller_is_owner_rep\(\)/.test(row.q)) bad(`${k} no longer refuses the Owner Rep`);
  }
} catch (e) {
  bad(`unexpected: ${e.message}`);
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}

if (failures > 0) {
  console.log(`\n\x1b[31m${failures} check(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log("\n\x1b[32mALL CHECKS PASSED — the Owner Rep sees its properties and their requests, and no money by any route.\x1b[0m");
