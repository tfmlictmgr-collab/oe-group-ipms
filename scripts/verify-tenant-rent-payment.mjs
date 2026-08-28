// The tenant-facing half of Day 9 (gap found by PC2, 2026-08-06) — and the
// standing check `create_rent_payment_intent` never had.
//
// Day 9's accounting was real and verified; what was missing was any way for
// the person who owes the rent to see it or pay it. Building that screen meant
// calling `create_rent_payment_intent`, which turned out to check only the
// caller's ORGANISATION — never that they are the tenant on the lease. Section
// C proves both halves of that: the refusal now, and (against a deliberately
// reverted function) that the test would have caught it before.
//
// Usage: node scripts/verify-tenant-rent-payment.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

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
const naira = (n) => `₦${Number(n).toLocaleString()}`;

async function login(email) {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: "OEGroupDemo2026!" });
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return c;
}

const MARK = "PROBERENT";
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { leases: [], charges: [], intents: [], units: [], properties: [], users: [] };

// Start-of-run sweep.
{
  const { data: strays } = await svc.from("properties").select("id").like("name", `${MARK}%`);
  if (strays?.length) {
    const pids = strays.map((s) => s.id);
    const { data: ls } = await svc.from("leases").select("id").in("property_id", pids);
    const lids = (ls ?? []).map((l) => l.id);
    if (lids.length) {
      const { data: rcs } = await svc.from("rent_charges").select("id").in("lease_id", lids);
      const rids = (rcs ?? []).map((r) => r.id);
      if (rids.length) await svc.from("payment_intents").delete().in("rent_charge_id", rids);
      await svc.from("rent_charges").delete().in("lease_id", lids);
      await svc.from("leases").delete().in("id", lids);
    }
    await svc.from("units").delete().in("property_id", pids);
    await svc.from("properties").delete().in("id", pids);
    console.log(`(swept ${strays.length} stray fixture propert(y/ies))`);
  }
}

const { data: oea } = await svc.from("orgs").select("id").eq("slug", "oea").single();
// ⚠️ Seeded fixtures only — `@oegroup.test`, never "whichever tenant is first".
//
// This was `.eq("role","tenant").limit(1).single()` with no ordering, and then
// signed in as whatever came back using the seed password. On staging the row
// it returned was `adikpelinda@oraegbunike.com` — a REAL account, created
// through the product on 24 Aug — and the suite died on "Invalid login
// credentials", which is the correct answer to asking a real person's account
// for a shared demo password.
//
// The failure was the harmless end of the problem. This file signs in as the
// account it picks, creates a lease naming them, and raises a rent demand
// against them; `verify-account-recovery` in the same directory RESETS THE
// PASSWORD of the account it picks. A verification suite must never be able to
// select a real user, and the seeded fixtures are exactly the ones on the
// `@oegroup.test` domain, which no real person ever holds.
const seeded = (q) => q.eq("org_id", oea.id).eq("role", "tenant")
  .is("deactivated_at", null).like("email", "%@oegroup.test").order("email");

const { data: tenants, error: tenantErr } = await seeded(
  svc.from("users").select("id, email")
);
if (tenantErr) throw new Error(`could not read tenants: ${tenantErr.message}`);
if (!tenants?.length) {
  throw new Error(
    "no seeded OEA tenant (@oegroup.test) on this world — run scripts/seed-brand-roles.mjs"
  );
}
const tenantA = tenants[0];

// The second tenant is BUILT, not hoped for.
//
// Sections B, C and G — "another tenant sees nothing of it", "standing to open
// a payment is checked", and the pre-fix proof that section C tests something
// real — are the reason this file exists: `create_rent_payment_intent` checked
// the caller's organisation and never that they were the tenant on the lease.
// They all guarded on `if (tenantB)` and skipped in silence when the world
// happened to hold only one seeded OEA tenant, which staging does. The file
// then printed ALL CHECKS PASSED having tested none of the isolation it is
// named for. A skipped check that reports as a pass is worse than a failure.
const probeEmail = `probe-rent-tenant-${S}@oegroup.test`;
const { data: madeAuth, error: authErr } = await svc.auth.admin.createUser({
  email: probeEmail, password: "OEGroupDemo2026!", email_confirm: true,
});
if (authErr) throw new Error(`second tenant (auth): ${authErr.message}`);
const { error: profErr } = await svc.from("users").insert({
  id: madeAuth.user.id, org_id: oea.id, role: "tenant",
  email: probeEmail, full_name: `Probe Rent Tenant ${S}`,
});
if (profErr) throw new Error(`second tenant (profile): ${profErr.message}`);
const tenantB = { id: madeAuth.user.id, email: probeEmail };
made.users.push(tenantB.id);

// ── Fixture: a property, a unit, a lease for tenant A, one unpaid demand ───
const { data: prop } = await svc.from("properties").insert({
  org_id: oea.id, name: `${MARK}-Court-${S}`, address: "1 Probe Street",
}).select("id").single();
made.properties.push(prop.id);

const { data: unit } = await svc.from("units").insert({
  org_id: oea.id, property_id: prop.id, label: `${MARK}-${S}`, apportionment_factor: 1,
}).select("id").single();
made.units.push(unit.id);

const { data: lease } = await svc.from("leases").insert({
  org_id: oea.id, property_id: prop.id, unit_id: unit.id, tenant_user_id: tenantA.id,
  start_date: "2026-01-01", end_date: "2026-12-31",
  rent_amount: 1200000, rent_frequency: "annual", currency: "NGN", status: "active",
}).select("id").single();
made.leases.push(lease.id);

// Raised through the real writer, not a hand-written insert: `raise_rent_charge`
// is "the only write path into rent_charges" (0091) precisely because it FREEZES
// the fee split onto the demand — a fixture that inserted directly would carry
// fee figures no production row ever could, and would prove nothing about the
// path a tenant actually pays against.
const { data: chargeId, error: raiseErr } = await svc.rpc("raise_rent_charge", {
  p_lease_id: lease.id,
  p_period_start: "2026-01-01",
  p_period_end: "2026-12-31",
  p_due_date: "2026-01-01",
});
if (raiseErr) throw new Error(`fixture rent charge: ${raiseErr.message}`);
const charge = { id: chargeId };
made.charges.push(charge.id);

console.log("Tenant rent payment — the person who owes it can see it and pay it\n");

console.log("A. The tenant sees their own rent, with the flat it belongs to");
{
  const c = await login(tenantA.email);
  const { data: rows, error } = await c.rpc("my_rent_charges");
  if (error) bad(`my_rent_charges failed: ${error.message}`);
  const mine = (rows ?? []).find((r) => r.charge_id === charge.id);
  mine
    ? ok(`the demand appears for its own tenant (${naira(mine.outstanding)} outstanding)`)
    : bad("THE TENANT CANNOT SEE THEIR OWN RENT DEMAND");
  mine?.property_name?.includes(MARK) && mine?.unit_label?.includes(MARK)
    ? ok("carrying the property and unit names — a tenant has no read on the register itself")
    : bad(`labels not denormalised: ${JSON.stringify({ p: mine?.property_name, u: mine?.unit_label })}`);
  await c.auth.signOut();
}

console.log("\nB. Another tenant sees nothing of it");
if (tenantB) {
  const c = await login(tenantB.email);
  const { data: rows } = await c.rpc("my_rent_charges");
  (rows ?? []).some((r) => r.charge_id === charge.id)
    ? bad("!!! ANOTHER TENANT SAW SOMEONE ELSE'S RENT DEMAND")
    : ok("an unrelated tenant's own list does not include it");
  const { data: direct } = await c.from("rent_charges").select("id").eq("id", charge.id);
  (direct ?? []).length === 0
    ? ok("nor can they reach it by querying rent_charges directly")
    : bad("!!! an unrelated tenant read the charge row directly");
  await c.auth.signOut();
} else {
  console.log("  (skipped — no second OEA tenant to test isolation with)");
}

console.log("\nC. Standing to open a payment is checked — the defect this work found");
if (tenantB) {
  const c = await login(tenantB.email);
  const { error } = await c.rpc("create_rent_payment_intent", { p_rent_charge_id: charge.id });
  error
    ? ok(`an unrelated tenant is refused ("${error.message.replace(/^.*?:\s*/, "").slice(0, 60)}")`)
    : bad("!!! AN UNRELATED TENANT OPENED A PAYMENT LINK ON SOMEONE ELSE'S RENT");
  await c.auth.signOut();

  // Nothing was created by the refused attempt.
  const { data: leaked } = await svc.from("payment_intents").select("id").eq("rent_charge_id", charge.id);
  (leaked ?? []).length === 0
    ? ok("and no intent row was left behind by the refusal")
    : bad(`the refused call still created ${leaked.length} intent(s)`);
} else {
  console.log("  (skipped — needs a second tenant)");
}

console.log("\nD. The tenant it belongs to CAN open one, once");
{
  const c = await login(tenantA.email);
  const { data: id1, error: e1 } = await c.rpc("create_rent_payment_intent", { p_rent_charge_id: charge.id });
  if (e1) bad(`the rightful tenant was refused: ${e1.message}`);
  else { ok("the demand's own tenant opens a payment"); made.intents.push(id1); }

  const { data: intent } = await svc.from("payment_intents")
    .select("amount_expected, payer_user_id, purpose, rent_charge_id").eq("id", id1).single();
  Number(intent.amount_expected) === 1200000
    ? ok(`for the outstanding balance computed by the database (${naira(intent.amount_expected)}), never a figure the client sent`)
    : bad(`wrong amount: ${intent.amount_expected}`);
  intent.payer_user_id === tenantA.id && intent.purpose === "rent"
    ? ok("attributed to the tenant, as a rent collection")
    : bad(`mis-attributed: ${JSON.stringify(intent)}`);

  const { error: e2 } = await c.rpc("create_rent_payment_intent", { p_rent_charge_id: charge.id });
  e2
    ? ok("a second link for the same demand is refused — two open links is how a tenant pays twice")
    : bad("A SECOND LIVE PAYMENT LINK WAS OPENED FOR ONE DEBT");
  await c.auth.signOut();
}

console.log("\nE. The live link is surfaced rather than a second one attempted");
{
  const c = await login(tenantA.email);
  const { data: rows } = await c.rpc("my_rent_charges");
  const mine = (rows ?? []).find((r) => r.charge_id === charge.id);
  mine?.open_intent_reference?.startsWith("RENT-")
    ? ok(`the screen sees the open reference (${mine.open_intent_reference}) and can continue it`)
    : bad(`no open intent reference surfaced: ${JSON.stringify(mine?.open_intent_reference)}`);
  await c.auth.signOut();
}

console.log("\nF. A fully-paid demand cannot be paid again");
{
  await svc.from("payment_intents").delete().eq("rent_charge_id", charge.id);
  const { data: full } = await svc.from("rent_charges").select("amount").eq("id", charge.id).single();
  await svc.from("rent_charges")
    .update({ amount_paid: full.amount, status: "paid" }).eq("id", charge.id);

  const c = await login(tenantA.email);
  const { error } = await c.rpc("create_rent_payment_intent", { p_rent_charge_id: charge.id });
  error
    ? ok("refused — already paid in full")
    : bad("A PAID RENT DEMAND ACCEPTED ANOTHER PAYMENT");
  await c.auth.signOut();

  await svc.from("rent_charges").update({ amount_paid: 0, status: "due" }).eq("id", charge.id);
}

console.log("\nG. THE PRE-FIX STATE — proving section C tests something real");
{
  const dbConfig = {
    host: process.env.SUPABASE_DB_HOST, port: Number(process.env.SUPABASE_DB_PORT || 5432),
    database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
  };
  const client = new pg.Client(dbConfig);
  await client.connect();

  // Save the current (fixed) definition, then install the org-only one 0092
  // shipped — the exact code that was live before 0110.
  const { rows: saved } = await client.query(
    "select pg_get_functiondef(oid) as def from pg_proc where proname = 'create_rent_payment_intent'"
  );
  const fixedDef = saved[0].def;

  await client.query(`
    create or replace function create_rent_payment_intent(p_rent_charge_id uuid, p_gateway payment_gateway default 'paystack')
    returns uuid language plpgsql security definer set search_path = public as $fn$
    declare rc rent_charges%rowtype; l leases%rowtype; v_id uuid; v_ref text; v_outstanding numeric(16,2);
    begin
      select * into rc from rent_charges where id = p_rent_charge_id;
      if rc.id is null then raise exception 'that rent demand could not be found'; end if;
      if auth.uid() is not null and rc.org_id is distinct from current_user_org_id() then
        raise exception 'that demand belongs to another organisation';
      end if;
      v_outstanding := rc.amount - rc.amount_paid;
      if v_outstanding <= 0 then raise exception 'that rent has already been paid in full'; end if;
      if exists (select 1 from payment_intents where rent_charge_id = rc.id and status = 'pending') then
        raise exception 'a payment link is already open for this rent demand';
      end if;
      select * into l from leases where id = rc.lease_id;
      v_ref := 'RENT-' || to_char(rc.period_start, 'YYYYMM') || '-' || left(replace(rc.id::text, '-', ''), 10);
      insert into payment_intents (org_id, purpose, rent_charge_id, property_id, unit_id, payer_user_id,
        amount_expected, currency, gateway, gateway_reference, created_by)
      values (rc.org_id, 'rent', rc.id, l.property_id, l.unit_id, l.tenant_user_id,
        v_outstanding, rc.currency, p_gateway, v_ref, auth.uid())
      returning id into v_id;
      return v_id;
    end; $fn$;
  `);

  if (tenantB) {
    const c = await login(tenantB.email);
    const { data: sneaked, error } = await c.rpc("create_rent_payment_intent", { p_rent_charge_id: charge.id });
    !error && sneaked
      ? ok("without the check, the unrelated tenant DID open a link on another tenant's rent — the finding reproduced")
      : bad(`expected the pre-fix function to allow it, but it refused: ${error?.message}`);
    if (sneaked) await svc.from("payment_intents").delete().eq("id", sneaked);
    await c.auth.signOut();
  } else {
    console.log("  (skipped — needs a second tenant)");
  }

  await client.query(fixedDef);
  await client.end();

  // And the restored function refuses again — the database is left protected.
  if (tenantB) {
    const c = await login(tenantB.email);
    const { error } = await c.rpc("create_rent_payment_intent", { p_rent_charge_id: charge.id });
    error
      ? ok("the fix was restored afterwards — the database is left protected")
      : bad("!!! THE FIX WAS NOT RESTORED — the database is left vulnerable");
    await c.auth.signOut();
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
//
// ⚠️ Strict dependency order, and it is longer than it looks. Learned the hard
// way clearing a browser fixture that had actually been PAID:
//   gateway_events → payment_intents → ledger_postings → ledger_entries
//   → rent_charges → leases → units → properties
// Two traps in that chain. `payment_intents.rent_charge_id` is ON DELETE SET
// NULL, so deleting the charge first does not block — it silently orphans the
// intent, which then blocks the ledger entry with no obvious connection back.
// And `payment_intents` also references `unit_id`, so an intent left behind
// blocks the unit and property too, several steps later.
{
  const { data: intents } = await svc.from("payment_intents")
    .select("id, ledger_entry_id").in("rent_charge_id", made.charges);
  const intentIds = (intents ?? []).map((i) => i.id);
  const entryIds = (intents ?? []).map((i) => i.ledger_entry_id).filter(Boolean);

  if (intentIds.length) {
    await svc.from("gateway_events").delete().in("intent_id", intentIds);
    await svc.from("payment_intents").delete().in("id", intentIds);
  }
  if (entryIds.length) {
    await svc.from("ledger_postings").delete().in("entry_id", entryIds);
    await svc.from("ledger_entries").delete().in("id", entryIds);
  }
  await svc.from("rent_charges").delete().in("id", made.charges);
  await svc.from("leases").delete().in("id", made.leases);
  await svc.from("units").delete().in("id", made.units);
  await svc.from("properties").delete().in("id", made.properties);

  // The probe tenant, from both places a user lives. Deleting only the profile
  // would leave a login that still works and cannot be seen from the app —
  // the trap `sweep-probe-residue.mjs` documents. This one has raised no
  // audited action (its every call was refused, which is the point of it), so
  // the delete is not held by `audit_log.actor_id`.
  for (const id of made.users ?? []) {
    const { error } = await svc.from("users").delete().eq("id", id);
    if (error) {
      await svc.from("users")
        .update({ deactivated_at: new Date().toISOString() }).eq("id", id);
      console.log(`  (probe tenant retained but deactivated: ${error.message})`);
      continue;
    }
    await svc.auth.admin.deleteUser(id).catch(() => {});
  }
}
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a tenant can see and pay their own rent, and only their own."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
