// Proves the four client-funds invariants are enforced by the DATABASE, using a
// real finance user through PostgREST — i.e. the same path a bug or a crafted
// request would take.
//
//   1. every entry balances (sum of postings = 0)
//   2. entries are immutable (no update, no delete)
//   3. client funds cannot go negative
//   4. a counterparty cannot be overpaid
//
// Plus: access is finance/admin only, and the segregation position is correct.
// Usage: npx tsx scripts/verify-ledger.mjs
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
const fm = await login("fm@oegroup.test");
const tenant = await login("resident@oegroup.test");
const { data: me } = await svc.from("users").select("org_id").eq("id", finance.id).single();
const orgId = me.org_id;

const stamp = Date.now().toString(36).toUpperCase().slice(-5);
const made = { accounts: [], entries: [] };

/** Posts a balanced entry as the finance user. Returns { error }. */
async function post(description, lines, source = "adjustment") {
  const { data: entry, error: eErr } = await finance.c
    .from("ledger_entries")
    .insert({ org_id: orgId, description, source, created_by: finance.id })
    .select("id").single();
  if (eErr) return { error: eErr };
  made.entries.push(entry.id);

  const { error: pErr } = await finance.c.from("ledger_postings").insert(
    lines.map((l) => ({ org_id: orgId, entry_id: entry.id, account_id: l.account, amount: l.amount }))
  );
  return { error: pErr, entryId: entry.id };
}

console.log("Client-funds ledger invariants\n");

// ── Set up a minimal chart of accounts ─────────────────────────────────────
async function account(code, name, cls, purpose) {
  const { data, error } = await finance.c.from("ledger_accounts")
    .insert({ org_id: orgId, code: `${code}-${stamp}`, name, class: cls, purpose })
    .select("id, code").single();
  if (error) throw new Error(`${code}: ${error.message}`);
  made.accounts.push(data.id);
  return data.id;
}
const BANK = await account("1000", "Client funds (test)", "asset", "client_funds");
const LANDLORD = await account("2100", "Landlord Adeyemi (test)", "liability", "landlord_payable");
const VENDOR = await account("2200", "Vendor PowerGen (test)", "liability", "vendor_payable");
const FEES = await account("4000", "Management fee income (test)", "income", "fee_income");
const EXPENSE = await account("5000", "Property expense (test)", "expense", "bank_charges");
ok("chart of accounts created by the finance user");

console.log("\nA. Invariant 1 — an entry must balance");
{
  const { error } = await post("Unbalanced — should be rejected", [
    { account: BANK, amount: 500000 },
    { account: LANDLORD, amount: -400000 },   // 100,000 short
  ]);
  error ? ok(`rejected (${error.message.slice(0, 60)})`) : bad("ALLOWED — an unbalanced entry committed");
}
{
  const { error } = await post("Single-sided — should be rejected", [
    { account: BANK, amount: 100000 },
  ]);
  error ? ok("single-sided entry rejected") : bad("ALLOWED — a one-legged entry committed");
}

console.log("\nB. A balanced collection posts cleanly");
{
  // Rent received into client funds, owed onward to the landlord.
  const { error } = await post("Rent collected — Ikoyi Heights", [
    { account: BANK, amount: 1200000 },       // debit: funds held
    { account: LANDLORD, amount: -1200000 },  // credit: owed to landlord
  ], "collection");
  error ? bad(`balanced entry refused — ${error.message}`) : ok("₦1,200,000 collected and recorded as owed");
}

console.log("\nC. Invariant 4 — a counterparty cannot be overpaid");
{
  const { error } = await post("Overpay the landlord — should be rejected", [
    { account: LANDLORD, amount: 1500000 },   // pay out more than the 1.2m owed
    { account: BANK, amount: -1500000 },
  ], "remittance");
  error ? ok(`rejected (${error.message.slice(0, 70)})`) : bad("ALLOWED — landlord paid more than owed (one client's money funding another)");
}

console.log("\nD. A legitimate remittance with a fee deduction works");
{
  // 10% management fee retained, balance remitted.
  const { error } = await post("Remit rent less 10% management fee", [
    { account: LANDLORD, amount: 1200000 },   // clear the liability
    { account: BANK, amount: -1080000 },      // cash out to the landlord
    { account: FEES, amount: -120000 },       // fee recognised as income
  ], "remittance");
  error ? bad(`legitimate remittance refused — ${error.message}`) : ok("₦1,080,000 remitted, ₦120,000 fee retained");
}

console.log("\nE. Invariant 3 — client funds cannot go negative");
{
  // First make the vendor genuinely owed ₦900,000, so paying them is not an
  // overpayment. That isolates invariant 3 from invariant 4 — otherwise the
  // overpayment rule fires first and this proves nothing about funds.
  const { error: accrue } = await post("Approve vendor invoice (accrue liability)", [
    { account: EXPENSE, amount: 900000 },
    { account: VENDOR, amount: -900000 },
  ]);
  accrue
    ? bad(`could not accrue the vendor liability — ${accrue.message}`)
    : ok("vendor is now genuinely owed ₦900,000");

  // Paying it would take the bank from 120,000 to −780,000.
  const { error } = await post("Pay the vendor with money not held", [
    { account: VENDOR, amount: 900000 },
    { account: BANK, amount: -900000 },
  ], "remittance");
  if (!error) bad("ALLOWED — disbursed funds that were never held");
  else if (/client funds/i.test(error.message))
    ok(`rejected by the funds rule (${error.message.slice(0, 60)})`);
  else bad(`rejected, but by the wrong rule: ${error.message.slice(0, 80)}`);
}

console.log("\nF. Invariant 2 — the ledger is append-only");
{
  // Judged on STATE, not on whether an error came back. With no UPDATE/DELETE
  // policy, RLS filters the row out before the immutability trigger can fire,
  // so the call is a silent no-op: zero rows affected, no error returned. That
  // is safe — but only an assertion about the DATA proves it.
  const { data: p } = await svc
    .from("ledger_postings").select("id, amount").eq("org_id", orgId).limit(1).single();

  const upd = await finance.c
    .from("ledger_postings").update({ amount: 1 }).eq("id", p.id).select("id");
  const { data: afterUpd } = await svc
    .from("ledger_postings").select("amount").eq("id", p.id).single();
  Number(afterUpd.amount) === Number(p.amount)
    ? ok(`amount unchanged after an update attempt (${upd.data?.length ?? 0} rows affected)`)
    : bad(`A POSTING WAS EDITED: ${p.amount} -> ${afterUpd.amount}`);

  await finance.c.from("ledger_postings").delete().eq("id", p.id).select("id");
  const { data: afterDel } = await svc
    .from("ledger_postings").select("id").eq("id", p.id).maybeSingle();
  afterDel ? ok("posting still present after a delete attempt") : bad("A POSTING WAS DELETED");

  const { data: before } = await svc
    .from("ledger_entries").select("description").eq("id", made.entries[0]).single();
  await finance.c
    .from("ledger_entries").update({ description: "rewritten" }).eq("id", made.entries[0]).select("id");
  const { data: after } = await svc
    .from("ledger_entries").select("description").eq("id", made.entries[0]).single();
  after.description === before.description
    ? ok("entry description unchanged after a rewrite attempt")
    : bad(`AN ENTRY WAS REWRITTEN: "${before.description}" -> "${after.description}"`);
}

console.log("\nG. Balances and the segregation position are correct");
{
  const { data: bal } = await finance.c
    .from("ledger_account_balances").select("account_id, natural_balance").in("account_id", [BANK, LANDLORD, FEES]);
  const by = Object.fromEntries((bal ?? []).map((b) => [b.account_id, Number(b.natural_balance)]));

  by[BANK] === 120000 ? ok("client funds hold ₦120,000 (1,200,000 in − 1,080,000 out)") : bad(`bank balance is ${by[BANK]}`);
  by[LANDLORD] === 0 ? ok("landlord is settled (₦0 owed)") : bad(`landlord owed ${by[LANDLORD]}`);
  by[FEES] === 120000 ? ok("₦120,000 recognised as fee income") : bad(`fee income is ${by[FEES]}`);

  // Section E deliberately left the books short: it accrued a ₦900,000 vendor
  // liability against an EXPENSE rather than funding it from a custodied bucket
  // (the correct entry would move value between liabilities, e.g. Dr service
  // charge fund / Cr vendor payable). The org therefore owes ₦900,000 while
  // holding ₦120,000 — a real shortfall.
  //
  // So the assertion is not "unallocated must be positive"; it is "the metric
  // must REPORT the shortfall accurately". A segregation alarm that never fires
  // is worth nothing.
  const { data: pos } = await finance.c
    .from("client_funds_position")
    .select("funds_held, funds_owed, unallocated").eq("org_id", orgId).single();

  const held = Number(pos.funds_held);
  const owed = Number(pos.funds_owed);
  const unallocated = Number(pos.unallocated);

  held === 120000 && owed === 900000
    ? ok(`position reads held ₦${held.toLocaleString()} vs owed ₦${owed.toLocaleString()}`)
    : bad(`position reads held ${held}, owed ${owed} — expected 120000 / 900000`);

  unallocated === held - owed
    ? ok(`shortfall computed correctly (₦${unallocated.toLocaleString()})`)
    : bad(`unallocated is ${unallocated}, expected ${held - owed}`);

  unallocated < 0
    ? ok("segregation alarm FIRES on a shortfall — this is the number to watch daily")
    : bad("the alarm stayed silent while liabilities exceeded funds held");
}

console.log("\nH. Access is finance/admin only");
{
  for (const [label, who] of [["FM/PM", fm], ["tenant", tenant]]) {
    const { data } = await who.c.from("ledger_postings").select("id").limit(5);
    (data ?? []).length === 0 ? ok(`${label} sees no ledger postings`) : bad(`${label} read ${data.length} postings`);
  }
  const { error } = await fm.c.from("ledger_entries")
    .insert({ org_id: orgId, description: "FM attempt", created_by: fm.id }).select("id");
  error ? ok("FM/PM cannot post to the ledger") : bad("ALLOWED — an FM posted a ledger entry");
}

console.log("\nI. Every entry is audited");
{
  const { count } = await svc.from("audit_log")
    .select("*", { count: "exact", head: true }).eq("action", "ledger.entry");
  count > 0 ? ok(`${count} ledger.entry audit records`) : bad("ledger entries are not audited");
}

// Cleanup (service role bypasses the immutability guard).
await svc.from("ledger_postings").delete().in("entry_id", made.entries);
await svc.from("ledger_entries").delete().in("id", made.entries);
await svc.from("ledger_accounts").delete().in("id", made.accounts);
console.log("\n(cleaned up test accounts and entries)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the ledger cannot be unbalanced, edited, or overdrawn."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
