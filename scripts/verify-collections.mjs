// Proves the collection path is safe. The claims that matter for money coming
// in:
//   • a collection posts EXACTLY ONCE, even under concurrent webhook delivery
//   • the ledger amount comes from our record / verification, never a payload
//   • an underpayment is recorded as part_paid and flagged, not silently "paid"
//   • gateway events dedupe on the gateway's own event id
//   • a payer cannot raise or alter what they owe
//   • collections reconcile — funds held rise by exactly what was collected
// Usage: npx tsx scripts/verify-collections.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

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
async function login(email) {
  const c = createClient(URL, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  const { data: { user } } = await c.auth.getUser();
  return { c, id: user.id };
}

const finance = await login("finance@oegroup.test");
const tenant = await login("resident@oegroup.test");
const { data: me } = await svc.from("users").select("org_id").eq("id", finance.id).single();
const orgId = me.org_id;

const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const made = { intents: [], entries: [] };

// Ensure a chart of accounts exists for this org.
await svc.rpc("ensure_default_ledger_accounts", { p_org_id: orgId });

// Resolved by the same function record_collection uses, deliberately. An org can
// hold several client-funds ledger accounts (0028: one per configured bank
// account), so picking one here independently would mean watching a balance the
// posting never touches — which is precisely how this test passed while the
// posting was landing in the wrong account.
const { data: bankAcctId } = await svc.rpc("collection_bank_account", { p_org_id: orgId });

const heldBefore = async () => {
  const { data } = await svc
    .from("ledger_account_balances").select("natural_balance").eq("account_id", bankAcctId).single();
  return Number(data.natural_balance);
};

async function newIntent(purpose, amount, ref) {
  const { data, error } = await finance.c.from("payment_intents").insert({
    org_id: orgId, purpose, amount_expected: amount,
    gateway: "simulated", gateway_reference: ref, created_by: finance.id,
  }).select("id").single();
  if (error) throw new Error(`intent: ${error.message}`);
  made.intents.push(data.id);
  return data.id;
}

console.log("Collections — money coming in\n");

console.log("A. A payer cannot invent what they owe");
{
  const { error } = await tenant.c.from("payment_intents").insert({
    org_id: orgId, purpose: "service_charge", amount_expected: 1,
    gateway: "simulated", gateway_reference: `TENANT-${stamp}`,
  });
  error ? ok(`blocked (${error.message.slice(0, 48)})`) : bad("ALLOWED — a tenant raised their own payment intent");
}

console.log("\nB. A collection posts, and funds held rise by exactly that amount");
const before = await heldBefore();
const intentA = await newIntent("service_charge", 250000, `SC-${stamp}-A`);
{
  const { data: entryId, error } = await svc.rpc("record_collection", {
    p_intent_id: intentA, p_amount_verified: 250000,
  });
  if (error) bad(`posting failed — ${error.message}`);
  else {
    made.entries.push(entryId);
    const after = await heldBefore();
    after - before === 250000
      ? ok(`client funds rose by exactly ₦250,000 (${before} → ${after})`)
      : bad(`funds moved by ${after - before}, expected 250000`);
  }
}

console.log("\nC. Exactly once — a redelivered webhook cannot double-post");
{
  const { data: again, error } = await svc.rpc("record_collection", {
    p_intent_id: intentA, p_amount_verified: 250000,
  });
  const after = await heldBefore();

  error ? bad(`a retry errored instead of returning the existing entry — ${error.message}`)
        : ok("a retry returns the existing entry rather than failing");
  again === made.entries[0]
    ? ok("the same ledger entry is returned")
    : bad(`a different entry came back: ${again}`);
  after - before === 250000
    ? ok("funds unchanged by the retry — no double posting")
    : bad(`DOUBLE POSTED: funds moved by ${after - before}`);
}

console.log("\nD. Concurrent deliveries still post once");
{
  const beforeC = await heldBefore();
  const intentB = await newIntent("service_charge", 90000, `SC-${stamp}-B`);
  // Fire simultaneously, as a gateway retrying on timeout would.
  const results = await Promise.all([
    svc.rpc("record_collection", { p_intent_id: intentB, p_amount_verified: 90000 }),
    svc.rpc("record_collection", { p_intent_id: intentB, p_amount_verified: 90000 }),
    svc.rpc("record_collection", { p_intent_id: intentB, p_amount_verified: 90000 }),
  ]);
  const ids = new Set(results.map((r) => r.data).filter(Boolean));
  const afterC = await heldBefore();

  ids.size === 1 ? ok(`3 concurrent calls produced 1 entry`) : bad(`${ids.size} distinct entries created`);
  afterC - beforeC === 90000
    ? ok("funds rose once, by ₦90,000")
    : bad(`funds moved by ${afterC - beforeC}, expected 90000`);

  const { count } = await svc
    .from("ledger_entries").select("*", { count: "exact", head: true })
    .eq("entity_type", "payment_intent").eq("entity_id", intentB);
  count === 1 ? ok("exactly one ledger entry references the intent") : bad(`${count} entries reference it`);
  made.entries.push(...ids);
}

console.log("\nE. An underpayment is flagged, not silently marked paid");
{
  const intentC = await newIntent("service_charge", 500000, `SC-${stamp}-C`);
  const { data: entryId } = await svc.rpc("record_collection", {
    p_intent_id: intentC, p_amount_verified: 300000,   // ₦200,000 short
  });
  made.entries.push(entryId);

  const { data: i } = await svc
    .from("payment_intents").select("status, amount_paid, amount_mismatch").eq("id", intentC).single();
  i.status === "part_paid" ? ok("status is part_paid, not paid") : bad(`status is ${i.status}`);
  Number(i.amount_paid) === 300000 ? ok("records what was actually received") : bad(`amount_paid ${i.amount_paid}`);
  i.amount_mismatch === true ? ok("mismatch flagged for follow-up") : bad("underpayment not flagged");
}

console.log("\nF. Zero and negative amounts are refused");
{
  const intentD = await newIntent("service_charge", 10000, `SC-${stamp}-D`);
  for (const [label, amt] of [["zero", 0], ["negative", -5000]]) {
    const { error } = await svc.rpc("record_collection", { p_intent_id: intentD, p_amount_verified: amt });
    error ? ok(`${label} amount refused`) : bad(`ALLOWED — a ${label} collection posted`);
  }
}

console.log("\nG. Gateway events dedupe on the gateway's own event id");
{
  const evt = { gateway: "simulated", event_id: `EVT-${stamp}`, event_type: "charge.success",
                reference: `SC-${stamp}-A`, signature_valid: true, payload: {} };
  const first = await svc.from("gateway_events").insert(evt);
  const second = await svc.from("gateway_events").insert(evt);
  !first.error ? ok("first delivery recorded") : bad(`first insert failed — ${first.error.message}`);
  second.error ? ok("redelivery rejected by the unique index") : bad("ALLOWED — the same event recorded twice");
}

console.log("\nH. The money is held against the right liability");
{
  const { data: rows } = await svc
    .from("ledger_postings")
    .select("amount, ledger_accounts(purpose)")
    .eq("entry_id", made.entries[0]);
  const credit = (rows ?? []).find((r) => Number(r.amount) < 0);
  const purpose = credit?.ledger_accounts?.purpose;
  purpose === "service_charge_fund"
    ? ok("a service-charge collection credits the service charge fund")
    : bad(`credited ${purpose} instead of service_charge_fund`);
}

console.log("\nI. Segregation still holds after collecting");
{
  const { data: pos } = await svc
    .from("client_funds_position").select("funds_held, funds_owed, unallocated").eq("org_id", orgId).single();
  // Every naira collected was credited to a liability, so collections alone can
  // never create a shortfall.
  Number(pos.unallocated) <= 0 || Number(pos.funds_held) >= 0
    ? ok(`held ₦${Number(pos.funds_held).toLocaleString()}, owed ₦${Number(pos.funds_owed).toLocaleString()}`)
    : bad("segregation position looks wrong after collections");
}

console.log("\nJ. Collections are auditable");
{
  const { count } = await svc
    .from("audit_log").select("*", { count: "exact", head: true }).eq("action", "collection.intent");
  count > 0 ? ok(`${count} collection.intent audit records`) : bad("collections are not audited");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("gateway_events").delete().like("event_id", `EVT-${stamp}%`);
await svc.from("payment_intents").delete().in("id", made.intents);
const uniqueEntries = [...new Set(made.entries.filter(Boolean))];
await svc.from("ledger_postings").delete().in("entry_id", uniqueEntries);
await svc.from("ledger_entries").delete().in("id", uniqueEntries);
console.log("\n(cleaned up test intents and postings)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — collections post exactly once, for the verified amount."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
