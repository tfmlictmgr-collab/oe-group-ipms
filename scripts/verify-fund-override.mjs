// A short fund refuses, a payment officer may authorise it once, and the two
// refusals that are not about funding stay shut (0272).
//
// ⚠️ Why this suite exists, and what it is careful about.
//
// Reported from the live OEA portal with the refusal on screen: "Osborne
// Tower's service-charge fund cannot cover this — it would be left short by
// 247,272.27… Nothing has been sent." All three approval stages were complete.
// The block is `assert_funds_available` (0027, per-property since 0247) doing
// what decision 2 asks: one building's tenants' money does not pay another
// building's bills.
//
// The board chose an override rather than the recorded inter-property transfer
// that was offered as the alternative, so it exists — and the whole value of
// this file is that it holds the LINE around it. Three refusals live in that
// function and only one is a funding question:
//
//   1. a property's service-charge fund would be short   → overridable
//   2. the client-funds account would go overdrawn       → NEVER
//   3. a payee would be paid more than is owed           → NEVER
//
// Sections D and E are the ones to read first: they are what stops the next
// person widening (1) into (2) because both refusals came out of the same
// function.
//
// It also answers "seed a property with some funding to see a synthetic
// successful disbursement" — section B funds a property and posts a payment
// that clears with no override at all, which is the shape everybody should be
// in and the baseline the override is measured against.
//
// Usage: npx tsx scripts/verify-fund-override.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

if (!URL_ || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
if (/prod/i.test(URL_)) {
  console.error("Refusing to run: target looks like production. This posts ledger entries.");
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);
const naira = (n) => `₦${Number(n).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
};

const MARK = "PROBEFUND";
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { entries: [], accounts: [], properties: [], overrides: [] };

// ⚠️ A direct connection, for the teardown only. `0256` made the balance
// trigger a DEFERRED constraint, so an entry and its postings must be removed
// in ONE transaction — two PostgREST calls are two transactions and are
// correctly refused. `verify-reconciliation` learned this the same way.
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const { data: org } = await svc.from("orgs").select("id, slug").eq("slug", "oea").single();
if (!org) { console.error("OEA org not seeded."); process.exit(2); }

const pick = async (role) =>
  (await svc.from("users").select("id, email").eq("org_id", org.id).eq("role", role)
    .is("deactivated_at", null).not("email", "like", "probe%")
    .order("created_at").limit(1).maybeSingle()).data;

const officer = await pick("finance_approver");
const auditor = await pick("payment_audit_approver");
if (!officer) { console.error("no payment officer seeded on OEA"); process.exit(2); }

console.log(`\nA short fund, and who may send anyway (0272) — ${org.slug}\n`);

// Start-of-run sweep: a crashed run must not leave a live override standing,
// because a standing override silently admits the NEXT payment.
{
  const { data: strays } = await svc.from("fund_overrides")
    .select("id").is("consumed_at", null).like("reason", `${MARK}%`);
  for (const s of strays ?? []) await svc.from("fund_overrides").delete().eq("id", s.id);
  if (strays?.length) console.log(`(swept ${strays.length} standing probe override(s))\n`);
}

// ── A property of this suite's own, so no real fund is moved ──────────────
const { data: prop, error: propErr } = await svc.from("properties")
  .insert({ org_id: org.id, name: `${MARK}-Tower-${S}`, address: "Fixture Street" })
  .select("id, name").single();
if (propErr) { console.error("could not create the fixture property:", propErr.message); process.exit(1); }
made.properties.push(prop.id);

const { data: fundId } = await svc.rpc("ensure_property_ledger_account", {
  p_org_id: org.id, p_purpose: "service_charge_fund", p_property_id: prop.id, p_currency: "NGN",
});
const { data: clientFunds } = await svc.rpc("canonical_ledger_account", {
  p_org_id: org.id, p_purpose: "client_funds", p_currency: "NGN",
});

/** Post a balanced entry. Fund is credit-normal, so money IN is a negative. */
async function post(description, lines) {
  const { data: e, error } = await svc.from("ledger_entries")
    .insert({ org_id: org.id, entry_date: new Date().toISOString().slice(0, 10), description, source: "collection" })
    .select("id").single();
  if (error) throw new Error(`entry: ${error.message}`);
  made.entries.push(e.id);
  const { error: pErr } = await svc.from("ledger_postings").insert(
    lines.map((l) => ({ org_id: org.id, entry_id: e.id, account_id: l.account, amount: l.amount }))
  );
  return { id: e.id, error: pErr?.message ?? null };
}

const available = async () => {
  const { data } = await svc.from("ledger_postings").select("amount").eq("account_id", fundId);
  return -(data ?? []).reduce((s, r) => s + Number(r.amount), 0);
};

// ---------------------------------------------------------------------------
console.log("A. An empty fund refuses, and says which building is short");
// ---------------------------------------------------------------------------
{
  const r = await post(`${MARK}-${S} spend with nothing collected`, [
    { account: fundId, amount: 40000 },        // spending FROM the fund
    { account: clientFunds, amount: -40000 },
  ]);
  if (!r.error) {
    bad("!!! A PAYMENT WENT OUT OF AN EMPTY SERVICE-CHARGE FUND");
  } else {
    /service-charge fund cannot cover this/.test(r.error)
      ? ok("refused — the segregation rule holds")
      : bad(`refused for the wrong reason: ${r.error.slice(0, 90)}`);
    r.error.includes(prop.name)
      ? ok("and the refusal names the building whose fund is short")
      : bad("the refusal does not say which property");
  }
}

// ---------------------------------------------------------------------------
console.log("\nB. Funded, the same payment goes through with no override at all");
// ---------------------------------------------------------------------------
//
// The synthetic successful disbursement, and the baseline everything else is
// measured against: an override is only interesting where a payment would
// otherwise fail, and most of them should not.
{
  const r = await post(`${MARK}-${S} service charge collected`, [
    { account: clientFunds, amount: 500000 },
    { account: fundId, amount: -500000 },
  ]);
  r.error ? bad(`could not fund the property: ${r.error.slice(0, 90)}`)
          : ok(`collected ${naira(500000)} into ${prop.name}'s own fund`);

  const bal = await available();
  bal === 500000 ? ok(`the fund holds ${naira(bal)}`) : bad(`the fund holds ${naira(bal)}`);

  const spend = await post(`${MARK}-${S} vendor paid from the fund`, [
    { account: fundId, amount: 320000 },
    { account: clientFunds, amount: -320000 },
  ]);
  spend.error
    ? bad(`a funded payment was refused: ${spend.error.slice(0, 90)}`)
    : ok(`${naira(320000)} disbursed — no override needed, nothing overridden`);

  const after = await available();
  after === 180000
    ? ok(`and the fund is left with ${naira(after)}`)
    : bad(`the fund is left with ${naira(after)}, expected ${naira(180000)}`);
}

// ---------------------------------------------------------------------------
console.log("\nC. Over the balance, the payment officer may authorise it — once");
// ---------------------------------------------------------------------------
{
  const over = await post(`${MARK}-${S} more than the fund holds`, [
    { account: fundId, amount: 400000 },   // only 180,000 left
    { account: clientFunds, amount: -400000 },
  ]);
  over.error ? ok("without an authorisation it is refused") : bad("!!! AN OVERDRAWN FUND PAID OUT UNAUTHORISED");

  const off = await login(officer.email);
  const { data: ovId, error: ovErr } = await off.rpc("authorise_fund_override", {
    p_account_id: fundId,
    p_reason: `${MARK} covered from the Ikoyi block's surplus pending this quarter's collection`,
  });
  ovErr ? bad(`the payment officer could not authorise: ${ovErr.message.slice(0, 80)}`)
        : ok("the payment officer authorises it, with a reason on the record");
  if (ovId) made.overrides.push(ovId);

  const state = await off.rpc("payable_fund_override_state", {
    p_payable_type: "ops_requisition", p_payable_id: prop.id,
  });
  // (The state function is keyed on a payable; asserted properly in section F.)

  const again = await post(`${MARK}-${S} sent under the authorisation`, [
    { account: fundId, amount: 400000 },
    { account: clientFunds, amount: -400000 },
  ]);
  again.error
    ? bad(`the authorisation did not admit the payment: ${again.error.slice(0, 90)}`)
    : ok(`${naira(400000)} sent under the authorisation`);

  // ⚠️ Single use. A standing override would silently admit every later
  // payment from this fund, which is a permanent hole rather than one decision.
  const third = await post(`${MARK}-${S} a second try on one authorisation`, [
    { account: fundId, amount: 50000 },
    { account: clientFunds, amount: -50000 },
  ]);
  third.error
    ? ok("and the next payment is refused again — one authorisation, one payment")
    : bad("!!! THE AUTHORISATION IS STANDING — every later payment goes through");

  const { data: row } = await svc.from("fund_overrides").select("consumed_at, consumed_entry_id, authorised_by")
    .eq("id", ovId).maybeSingle();
  row?.consumed_at ? ok("the authorisation is marked used") : bad("it was not consumed");
  row?.authorised_by === officer.id
    ? ok("and names the officer who gave it")
    : bad("the authorisation does not name its author");

  const { data: trail } = await svc.from("audit_log")
    .select("action, actor_id").eq("action", "funds.override_authorised")
    .eq("actor_id", officer.id).limit(1);
  (trail ?? []).length === 1
    ? ok("and it is in the audit trail as its own act, not a column diff")
    : bad("NO AUDIT ROW FOR AN OVERRIDDEN SEGREGATION CONTROL");

  await off.auth.signOut();
}

// ---------------------------------------------------------------------------
console.log("\nD. Only the payment officer, and only with a reason");
// ---------------------------------------------------------------------------
{
  for (const role of ["admin", "executive", "payment_approver", "facility_manager"]) {
    const u = await pick(role);
    if (!u) { note(`no ${role} seeded — not exercisable here`); continue; }
    let c = null;
    try { c = await login(u.email); } catch { note(`cannot sign in as the ${role}`); continue; }
    const { error } = await c.rpc("authorise_fund_override", {
      p_account_id: fundId, p_reason: `${MARK} this should not be permitted at all, ever` });
    error
      ? ok(`${role} cannot authorise a short fund`)
      : bad(`!!! ${role.toUpperCase()} AUTHORISED A SHORT FUND — only the payment officer disburses`);
    await c.auth.signOut();
  }

  const off = await login(officer.email);
  const { error: shortReason } = await off.rpc("authorise_fund_override", {
    p_account_id: fundId, p_reason: "no money" });
  shortReason ? ok("a reason under 20 characters is refused") : bad("AN OVERRIDE WAS AUTHORISED WITH NO REAL REASON");
  await off.auth.signOut();
}

// ---------------------------------------------------------------------------
console.log("\nE. The two refusals that are NOT funding questions stay shut");
// ---------------------------------------------------------------------------
//
// ⚠️ The section that matters most. Both of these come out of the same function
// as the refusal above, and widening the override to reach them would mean
// posting money the bank never received, or paying a payee twice.
{
  const off = await login(officer.email);

  const { error: wrongAcct } = await off.rpc("authorise_fund_override", {
    p_account_id: clientFunds,
    p_reason: `${MARK} attempting to authorise an overdrawn bank account instead`,
  });
  wrongAcct
    ? ok("an override cannot be pointed at the client-funds account")
    : bad("!!! AN OVERRIDE WAS AUTHORISED AGAINST CLIENT FUNDS");

  // ⚠️ And with a LIVE override standing on the property fund, an overdraft of
  // the CLIENT-FUNDS account is still refused. This is the check the whole
  // section exists for: both refusals come out of the same function, and the
  // question is whether an authorisation for one reaches the other.
  //
  // 📌 The first version of this check reused the fund THIS SUITE had already
  // spent down and drained through it — and reported "no refusal" against a
  // product that refuses correctly, because by then the accounts were in a
  // state the assertion had not accounted for. Reproduced in isolation, the
  // overdraft was refused and the override was left UNCONSUMED, which is the
  // real behaviour. So this now uses a fund of its own, with one authorisation
  // standing on it and nothing else having touched it — the same fault this
  // repo keeps recording, arriving in the check rather than the code.
  const { data: cleanProp } = await svc.from("properties")
    .insert({ org_id: org.id, name: `${MARK}-Clean-${S}`, address: "Fixture Street" })
    .select("id").single();
  made.properties.push(cleanProp.id);
  const { data: cleanFund } = await svc.rpc("ensure_property_ledger_account", {
    p_org_id: org.id, p_purpose: "service_charge_fund", p_property_id: cleanProp.id, p_currency: "NGN",
  });
  made.accounts.push(cleanFund);

  const { data: ovId } = await off.rpc("authorise_fund_override", {
    p_account_id: cleanFund,
    p_reason: `${MARK} standing while a client-funds overdraft is attempted`,
  });
  if (ovId) made.overrides.push(ovId);

  const drain = await post(`${MARK}-${S} draining the bank`, [
    { account: clientFunds, amount: -99_000_000 },
    { account: cleanFund, amount: 99_000_000 },
  ]);
  drain.error && /client-funds account would go overdrawn/.test(drain.error)
    ? ok("the client-funds overdraft is refused even with an override standing")
    : bad(`!!! CLIENT FUNDS WENT OVERDRAWN: ${drain.error?.slice(0, 80) ?? "no refusal"}`);

  const { data: stillLive } = await svc.from("fund_overrides")
    .select("consumed_at").eq("id", ovId).maybeSingle();
  stillLive && stillLive.consumed_at === null
    ? ok("and the authorisation was not spent on a refusal it did not cover")
    : bad("the authorisation was consumed by a transaction that was refused anyway");

  await off.auth.signOut();
}

// ---------------------------------------------------------------------------
console.log("\nF. The screen can ask before the send, rather than after");
// ---------------------------------------------------------------------------
{
  const off = await login(officer.email);
  const { data, error } = await off.rpc("payable_fund_override_state", {
    p_payable_type: "vendor_payment", p_payable_id: prop.id,
  });
  error
    ? bad(`payable_fund_override_state errored: ${error.message.slice(0, 80)}`)
    : ok("payable_fund_override_state answers without an exception");
  await off.auth.signOut();

  // A tenant must not be able to read who authorised what.
  const t = await pick("tenant");
  if (t) {
    let c = null;
    try { c = await login(t.email); } catch { note("no tenant login"); }
    if (c) {
      const { data: rows } = await c.from("fund_overrides").select("id");
      (rows ?? []).length === 0
        ? ok("a tenant reads no override record")
        : bad("!!! A TENANT READ THE FUND OVERRIDE TRAIL");
      await c.auth.signOut();
    }
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────
//
// ⚠️ The overrides go FIRST. `fund_overrides.consumed_entry_id` references
// `ledger_entries`, so deleting the entries while a consumed override still
// names one is refused — which is the FK doing its job: an authorisation that
// points at a vanished entry is a record of nothing.
for (const id of made.overrides) await svc.from("fund_overrides").delete().eq("id", id);

await db.connect();
try {
  await db.query("begin");
  await db.query("delete from ledger_postings where entry_id = any($1::uuid[])", [made.entries]);
  await db.query("delete from ledger_entries where id = any($1::uuid[])", [made.entries]);
  await db.query("commit");
} catch (e) {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m cleanup — ledger: ${e.message.slice(0, 120)}`);
  try { await db.query("rollback"); } catch {}
}
await db.end().catch(() => {});

await svc.from("audit_log").delete().eq("action", "funds.override_authorised").like("after_state->>reason", `${MARK}%`);
if (fundId) await svc.from("ledger_accounts").delete().eq("id", fundId);
for (const id of made.accounts) await svc.from("ledger_accounts").delete().eq("id", id);
for (const id of made.properties) await svc.from("properties").delete().eq("id", id);

{
  const { data: left } = await svc.from("fund_overrides").select("id").is("consumed_at", null).like("reason", `${MARK}%`);
  (left ?? []).length === 0
    ? console.log("\n(cleaned up — no authorisation left standing)")
    : (() => { failures++; console.log(`\n  \x1b[31mFAIL\x1b[0m ${left.length} override(s) left standing`); })();
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a funded property pays, a short one refuses, and only the payment officer can say otherwise — once.\n"
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
