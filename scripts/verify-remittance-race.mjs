// Audit 0804 S1/S3 — two people cannot pay the same landlord twice.
//
// ⚠️ Why this is a separate suite, with raw connections rather than supabase-js.
//
// `verify-rent-money` already asserts that the same rent cannot be remitted
// twice — SEQUENTIALLY, after the first call has committed. That passes with or
// without a lock, because by then `remitted_at` is set. It is the assertion that
// looks like it covers the race and does not, which is how the race survived
// review: the audit found the missing `FOR UPDATE` by reading the function, not
// by running the suite.
//
// A real double-pay needs two calls OVERLAPPING. Two HTTP requests fired at once
// might overlap, or might not, and a test that fails one run in twenty teaches
// people to re-run it. So the overlap is made deterministic with two Postgres
// connections and an open transaction:
//
//   A: begin; create_rent_remittance(...)        -- holds the row locks
//   B:        create_rent_remittance(...)        -- must BLOCK, not proceed
//   A: commit
//   B:                                            -- unblocks, must find nothing
//
// Without the lock, B reads A's uncommitted-invisible rows as unremitted and
// inserts a second full-amount remittance. With it, B waits and then sees the
// truth.
//
// Usage: node scripts/verify-remittance-race.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const naira = (n) => `₦${Number(n).toLocaleString()}`;

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const dbConfig = {
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const { data: orgs } = await svc.from("orgs").select("id, slug, management_fee_pct").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { properties: [], units: [], leases: [], intents: [], entries: [], remittances: [] };

console.log("Landlord remittance under concurrency\n");

// ── Fixtures: one property, one let unit, one collected year's rent ────────
const prop = (await svc.from("properties")
  .insert({ org_id: oea.id, name: `PROBERACE-Property-${S}` }).select("id").single()).data;
made.properties.push(prop.id);
const unit = (await svc.from("units")
  .insert({ org_id: oea.id, property_id: prop.id, label: `Unit ${S}`, apportionment_factor: 1 })
  .select("id").single()).data;
made.units.push(unit.id);

const { data: tenant } = await svc.from("users").select("id").eq("email", "oea.tenant@oegroup.test").single();
const { data: landlord } = await svc.from("users").select("id").eq("email", "oea.propertyowner@oegroup.test").single();
await svc.from("property_stakeholders")
  .insert({ org_id: oea.id, property_id: prop.id, user_id: landlord.id, relation: "owner" });

const lease = (await svc.from("leases").insert({
  org_id: oea.id, property_id: prop.id, unit_id: unit.id, tenant_user_id: tenant.id,
  start_date: "2026-09-01", end_date: "2027-09-01",
  rent_amount: 10_000_000, rent_frequency: "annual", status: "active",
}).select("id").single()).data;
made.leases.push(lease.id);

const { data: chargeId } = await svc.rpc("raise_rent_charge", {
  p_lease_id: lease.id, p_period_start: "2026-09-01", p_period_end: "2027-09-01",
});
const { data: intentId } = await svc.rpc("create_rent_payment_intent", { p_rent_charge_id: chargeId });
if (intentId) made.intents.push(intentId);
const { data: entryId, error: collectErr } = await svc.rpc("record_collection", {
  p_intent_id: intentId, p_amount_verified: 10_000_000,
});
if (collectErr) bad(`could not collect the rent — ${collectErr.message.slice(0, 70)}`);
if (entryId) made.entries.push(entryId);

// A verified bank recipient, or the function refuses before it ever reaches the
// code under test and the suite proves nothing.
const { data: existing } = await svc.from("payout_recipients")
  .select("id").eq("org_id", oea.id).eq("party", "landlord").eq("user_id", landlord.id)
  .eq("active", true).limit(1);
if (!existing?.length) {
  await svc.from("payout_recipients").insert({
    org_id: oea.id, party: "landlord", user_id: landlord.id,
    display_name: `Probe Landlord ${S}`,
    account_name: "Probe Landlord", account_number_last4: "0000",
    bank_name: "Probe Bank", recipient_code: `RCP_RACE_${S}`, active: true,
  });
}

// 0142 added the executor as a required argument: the function now records WHO
// released the money and insists they hold finance_approver.
const { data: financeUser } = await svc.from("users").select("id")
  .eq("org_id", oea.id).eq("role", "finance_approver").is("deactivated_at", null)
  .limit(1).single();

const CALL = `select create_rent_remittance($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid) as id`;
const ARGS = [oea.id, landlord.id, prop.id, "2026/27", financeUser.id];

// ── A. The lock exists at all ──────────────────────────────────────────────
console.log("A. A second caller BLOCKS rather than reading a stale set");
const a = new pg.Client(dbConfig);
const b = new pg.Client(dbConfig);
await a.connect();
await b.connect();

let aId = null;
try {
  await a.query("begin");
  const first = await a.query(CALL, ARGS);
  aId = first.rows[0].id;
  aId ? ok("the first call creates a remittance") : bad("the first call returned nothing");

  // B now attempts the same payout while A still holds the locks. If the lock
  // is missing this returns almost immediately with a SECOND remittance id.
  let bSettled = false;
  const bPromise = b.query(CALL, ARGS)
    .then((r) => ({ id: r.rows[0].id }))
    .catch((e) => ({ err: e.message }))
    .finally(() => { bSettled = true; });

  // Long enough that "still waiting" means blocked, not merely slow. A call that
  // is going to succeed on this data takes tens of milliseconds.
  await new Promise((r) => setTimeout(r, 2500));

  // ⚠️ Weak on its own, and deliberately kept as diagnosis rather than proof.
  // Run against the PRE-FIX function this still passes: B sailed through the
  // unlocked SELECT, inserted its own remittance, and only then blocked on the
  // closing UPDATE — by which point the damage was done. "It blocked" tells you
  // WHERE it blocked, not that it blocked in time. The assertion that decides
  // this suite is the outcome, below.
  bSettled
    ? bad("THE SECOND CALL DID NOT BLOCK AT ALL")
    : ok("2.5s later the second call is still waiting on a lock");

  await a.query("commit");

  const bResult = await bPromise;
  if (bResult.id) {
    made.remittances.push(bResult.id);
    bad(`THE SAME RENT WAS REMITTED TWICE — second remittance ${bResult.id}`);
  } else {
    /no collected rent awaiting remittance|remitted by another action/i.test(bResult.err ?? "")
      ? ok(`and once released it finds nothing to pay: "${(bResult.err ?? "").split("\n")[0].slice(0, 60)}"`)
      : bad(`the second call failed for the wrong reason — ${bResult.err}`);
  }
} catch (e) {
  bad(`the concurrency probe threw — ${String(e.message).slice(0, 90)}`);
  try { await a.query("rollback"); } catch { /* already closed */ }
} finally {
  await a.end();
  await b.end();
}

// ── B. Exactly one remittance exists, for the whole amount ────────────────
console.log("\nB. One payout, for the full collected amount");
{
  const { data: rems } = await svc.from("remittances")
    .select("id, net_amount, gross_amount, management_fee, admin_fee, status")
    .eq("property_id", prop.id);

  (rems ?? []).length === 1
    ? ok("exactly one remittance exists for this property")
    : bad(`${(rems ?? []).length} remittances exist — expected exactly 1`);

  const r = (rems ?? [])[0];
  if (r) {
    made.remittances.push(r.id);
    const expected = 10_000_000 - Math.round(10_000_000 * Number(oea.management_fee_pct) / 100 * 100) / 100;
    Math.abs(Number(r.net_amount) - expected) < 1
      ? ok(`it pays the snapshotted net once (${naira(r.net_amount)})`)
      : bad(`paid ${naira(r.net_amount)}, expected ${naira(expected)}`);
    Number(r.management_fee) === 0 && Number(r.admin_fee) === 0
      ? ok("and deducts no second fee")
      : bad(`a second fee was deducted: ${r.management_fee} / ${r.admin_fee}`);
  }

  const { data: charges } = await svc.from("rent_charges")
    .select("id, remitted_at, remittance_id").eq("lease_id", lease.id);
  (charges ?? []).every((ch) => ch.remitted_at && ch.remittance_id === r?.id)
    ? ok("every collected charge points at that one remittance")
    : bad("a charge is unclaimed or points somewhere else");
}

// ── C. The gate is the grant, not a capability that does not exist ────────
console.log("\nC. A browser session cannot reach the function at all");
{
  // S3: the old gate checked `has_permission('remittance.execute')` — a
  // capability never seeded, so it denied everyone including administrators,
  // AND it named a control that locked decision 7 forbids making delegable.
  // The real boundary is the grant: `authenticated` has none.
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } });
  const { error: signInErr } = await c.auth.signInWithPassword({
    email: "oea.admin@oegroup.test", password: "OEGroupDemo2026!",
  });
  if (signInErr) bad("could not sign in as an administrator");
  else {
    const { error } = await c.rpc("create_rent_remittance", {
      p_org_id: oea.id, p_landlord_user_id: landlord.id,
      p_property_id: prop.id, p_period: "2026/27", p_executed_by: financeUser.id,
    });
    // ⚠️ Must be refused BY THE GRANT (service_role only), not by "function not
    // found". When 0142 changed the signature this assertion went on passing
    // for the wrong reason — green, while proving nothing about the grant it
    // exists to test. A refusal is only evidence if it is the refusal you meant.
    error && !/Could not find the function/i.test(error.message)
      ? ok(`an administrator's own session is refused at the grant (${error.message.slice(0, 44)})`)
      : bad("AN ADMIN SESSION EXECUTED A REMITTANCE DIRECTLY — the grant is open");
    await c.auth.signOut();
  }

  // And the capability really is absent rather than present-and-off, so nobody
  // later "fixes" it by granting a row.
  const { data: cap } = await svc.from("capabilities").select("key").eq("key", "remittance.execute").maybeSingle();
  cap
    ? bad("`remittance.execute` was added to the catalogue — remittance execution must not be delegable (decision 7)")
    : ok("`remittance.execute` is not a toggle; execution stays hardwired, as decision 7 requires");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("rent_charges").update({ remitted_at: null, remittance_id: null }).eq("lease_id", lease.id);
for (const id of made.remittances) await svc.from("remittances").delete().eq("id", id);
await svc.from("ledger_postings").delete().in("entry_id", made.entries);
await svc.from("ledger_entries").delete().in("id", made.entries);
await svc.from("rent_charges").delete().eq("lease_id", lease.id);
await svc.from("payment_intents").delete().in("id", made.intents);
await svc.from("leases").delete().in("id", made.leases);
await svc.from("property_stakeholders").delete().in("property_id", made.properties);
await svc.from("units").delete().in("id", made.units);
await svc.from("properties").delete().in("id", made.properties);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a landlord is paid once, however many people click."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exitCode = failures === 0 ? 0 : 1;
