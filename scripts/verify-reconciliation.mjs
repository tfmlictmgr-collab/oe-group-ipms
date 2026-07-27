// Day 4 gate: statement import, matching, and bank-vs-ledger reconciliation.
//
// The workplan's acceptance test verbatim — "confirm the reconciliation report
// shows zero variance, then deliberately introduce one and see it flagged" —
// plus the import rules and access control.
// Usage: npx tsx scripts/verify-reconciliation.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { validateStatementCsv, buildStatementTemplateCsv } from "../lib/statement-import.ts";
import { parseCsv } from "../lib/asset-schema.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const naira = (n) => "₦" + Number(n).toLocaleString();

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
const { data: me } = await svc.from("users").select("org_id").eq("id", finance.id).single();
const orgId = me.org_id;

const stamp = Date.now().toString(36).toUpperCase().slice(-5);
const cleanup = { accounts: [], entries: [], bank: null };

console.log("Statement import & bank reconciliation\n");

// ── Fixture: a client-funds account with its own ledger account ────────────
const { data: bankLedger } = await svc.from("ledger_accounts")
  .insert({ org_id: orgId, code: `REC-BANK-${stamp}`, name: "Client funds (recon test)", class: "asset", purpose: "client_funds" })
  .select("id").single();
const { data: llLedger } = await svc.from("ledger_accounts")
  .insert({ org_id: orgId, code: `REC-LL-${stamp}`, name: "Landlord (recon test)", class: "liability", purpose: "landlord_payable" })
  .select("id").single();
cleanup.accounts.push(bankLedger.id, llLedger.id);

const { data: bank } = await svc.from("bank_accounts")
  .insert({ org_id: orgId, label: `Recon test ${stamp}`, purpose: "operating",
            ledger_account_id: bankLedger.id, bank_name: "Test Bank", account_number_last4: "0001" })
  .select("id").single();
cleanup.bank = bank.id;
ok("test bank account linked to its ledger account");

/** Posts a balanced entry via the service role. */
async function postEntry(date, description, lines) {
  const { data: e } = await svc.from("ledger_entries")
    .insert({ org_id: orgId, entry_date: date, description, source: "collection" })
    .select("id").single();
  cleanup.entries.push(e.id);
  const { error } = await svc.from("ledger_postings").insert(
    lines.map((l) => ({ org_id: orgId, entry_id: e.id, account_id: l.account, amount: l.amount }))
  );
  if (error) throw new Error(`${description}: ${error.message}`);
  return e.id;
}

console.log("\nA. The template is self-consistent");
{
  const grid = parseCsv(buildStatementTemplateCsv());
  grid.length === 1
    ? ok("guidance and example rows are skipped on re-import")
    : bad(`expected only a header to survive, got ${grid.length} rows`);
  ["date", "amount", "debit", "credit", "external_id"].every((k) => grid[0].includes(k))
    ? ok("header carries date, amount, debit/credit and external_id")
    : bad(`header is ${grid[0].join(",")}`);
}

console.log("\nB. Import validation handles real-world messiness");
{
  const csv = [
    "date,description,reference,amount,debit,credit,external_id",
    // signed amount with Naira formatting
    `2026-08-01,TRF FROM ADEYEMI - RENT,,"₦1,200,000",,,FT-${stamp}-A`,
    // credit column instead of amount
    `2026-08-02,SERVICE CHARGE RECEIPT,,,,450000,FT-${stamp}-B`,
    // debit column -> negative
    `2026-08-03,REMITTANCE TO LANDLORD,,,1080000,,FT-${stamp}-C`,
    // parentheses notation for a negative
    `2026-08-03,BANK CHARGE,,(1075),,,FT-${stamp}-D`,
    // duplicate bank reference within the file
    `2026-08-01,TRF FROM ADEYEMI - RENT,,1200000,,,FT-${stamp}-A`,
    // both debit and credit
    `2026-08-04,CONFUSED LINE,,,500,500,FT-${stamp}-E`,
    // bad date
    `03/08/2026,BAD DATE,,1000,,,FT-${stamp}-F`,
    // no amount at all
    `2026-08-05,NOTHING,,,,,FT-${stamp}-G`,
    // no external id, identical to another line -> warning only
    `2026-08-06,ATM FEE,,(500),,,`,
    `2026-08-06,ATM FEE,,(500),,,`,
  ].join("\n");

  const { rows } = validateStatementCsv(csv, new Set());
  const by = Object.fromEntries(rows.map((r) => [r.rowNumber, r]));

  Number(by[2].values?.amount) === 1200000 ? ok('"₦1,200,000" parsed to 1200000') : bad(`row 2 amount ${by[2].values?.amount}`);
  Number(by[3].values?.amount) === 450000 ? ok("credit column parsed as money in (+450000)") : bad(`row 3 amount ${by[3].values?.amount}`);
  Number(by[4].values?.amount) === -1080000 ? ok("debit column parsed as money out (−1080000)") : bad(`row 4 amount ${by[4].values?.amount}`);
  Number(by[5].values?.amount) === -1075 ? ok("(1075) parsed as −1075") : bad(`row 5 amount ${by[5].values?.amount}`);
  by[6].duplicate ? ok("duplicate bank reference blocked") : bad("duplicate reference accepted");
  !by[7].valid ? ok("debit AND credit on one line rejected") : bad("both-sided line accepted");
  !by[8].valid ? ok("bad date rejected") : bad("bad date accepted");
  !by[9].valid ? ok("line with no amount rejected") : bad("amountless line accepted");

  // The important nuance: identical un-referenced lines are a WARNING.
  by[11].possibleDuplicate && by[11].valid
    ? ok("identical un-referenced line flagged as a possible duplicate but still importable")
    : bad("identical un-referenced line was blocked — two real ₦500 fees on one day would be lost");
}

console.log("\nC. A statement that matches the books reconciles to zero");
{
  // Books: rent in, remittance out.
  await postEntry("2026-08-01", `Rent collected ${stamp}`, [
    { account: bankLedger.id, amount: 1200000 },
    { account: llLedger.id, amount: -1200000 },
  ]);
  await postEntry("2026-08-03", `Remittance ${stamp}`, [
    { account: llLedger.id, amount: 1200000 },
    { account: bankLedger.id, amount: -1200000 },
  ]);

  // Statement: the same two movements.
  await finance.c.from("bank_statement_lines").insert([
    { org_id: orgId, bank_account_id: bank.id, value_date: "2026-08-01",
      description: "TRF FROM ADEYEMI", amount: 1200000, external_id: `S-${stamp}-1` },
    { org_id: orgId, bank_account_id: bank.id, value_date: "2026-08-03",
      description: "REMITTANCE", amount: -1200000, external_id: `S-${stamp}-2` },
  ]);

  const { data: matched, error: mErr } = await finance.c
    .rpc("auto_match_statement_lines", { p_bank_account_id: bank.id, p_day_window: 3 });
  mErr ? bad(`auto-match failed — ${mErr.message}`) : ok(`auto-matched ${matched} line(s) to ledger entries`);

  const { data: rec, error } = await finance.c
    .rpc("run_reconciliation", { p_bank_account_id: bank.id, p_as_of_date: "2026-08-31" });
  if (error) bad(`reconciliation failed — ${error.message}`);
  else {
    const r = Array.isArray(rec) ? rec[0] : rec;
    Number(r.variance) === 0
      ? ok(`ZERO VARIANCE — ledger ${naira(r.ledger_balance)} = bank ${naira(r.statement_balance)}`)
      : bad(`expected zero variance, got ${r.variance}`);
    r.status === "balanced" ? ok('status recorded as "balanced"') : bad(`status is ${r.status}`);
  }
}

console.log("\nD. Introduce a discrepancy — it must be flagged");
{
  // A payment left the bank that nobody recorded in the books. This is exactly
  // the scenario reconciliation exists to catch.
  await finance.c.from("bank_statement_lines").insert({
    org_id: orgId, bank_account_id: bank.id, value_date: "2026-08-10",
    description: "UNRECORDED DEBIT — not in our books", amount: -75000,
    external_id: `S-${stamp}-3`,
  });

  const { data: rec } = await finance.c
    .rpc("run_reconciliation", { p_bank_account_id: bank.id, p_as_of_date: "2026-08-31" });
  const r = Array.isArray(rec) ? rec[0] : rec;

  Number(r.variance) === 75000
    ? ok(`variance detected: ${naira(r.variance)} — the ledger shows more than the bank holds`)
    : bad(`expected a 75000 variance, got ${r.variance}`);
  r.status === "variance" ? ok('status recorded as "variance"') : bad(`status is ${r.status}`);
  Number(r.unmatched_lines) === 1
    ? ok("the unexplained line is reported as unmatched")
    : bad(`unmatched_lines is ${r.unmatched_lines}`);
}

console.log("\nE. Both runs are kept, so the history is auditable");
{
  const { data: runs } = await finance.c
    .from("reconciliations").select("status, variance")
    .eq("bank_account_id", bank.id).order("run_at");
  (runs ?? []).length === 2
    ? ok(`${runs.length} runs recorded (balanced, then variance) — not just the successful one`)
    : bad(`expected 2 recorded runs, found ${(runs ?? []).length}`);

  const { count } = await svc.from("audit_log")
    .select("*", { count: "exact", head: true }).eq("action", "reconciliation.run");
  count > 0 ? ok(`${count} reconciliation.run audit records`) : bad("reconciliation runs are not audited");
}

console.log("\nF. Reconciliation is finance/admin only");
{
  const { data: seen } = await fm.c.from("bank_statement_lines").select("id").limit(5);
  (seen ?? []).length === 0 ? ok("FM/PM sees no statement lines") : bad(`FM read ${seen.length} lines`);

  const { error } = await fm.c
    .rpc("run_reconciliation", { p_bank_account_id: bank.id, p_as_of_date: "2026-08-31" });
  error ? ok(`FM/PM cannot run a reconciliation (${error.message.slice(0, 45)})`) : bad("ALLOWED — an FM reconciled");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
// Checked, not assumed. This block used to print "(cleaned up)" while leaving
// its fake client-funds account behind, and that debris was not harmless: a
// real collection was later debited to it, and an admin configuring the org's
// actual client-funds account had it linked to it. A test that litters the
// database it verifies eventually verifies the litter.
async function purge(label, run) {
  const { error } = await run();
  if (error) { failures++; console.log(`  \x1b[31mFAIL\x1b[0m cleanup — ${label}: ${error.message}`); }
}

await purge("reconciliations", () =>
  svc.from("reconciliations").delete().eq("bank_account_id", cleanup.bank));
await purge("statement lines", () =>
  svc.from("bank_statement_lines").delete().eq("bank_account_id", cleanup.bank));
await purge("bank account", () =>
  svc.from("bank_accounts").delete().eq("id", cleanup.bank));
await purge("postings", () =>
  svc.from("ledger_postings").delete().in("entry_id", cleanup.entries));
await purge("entries", () =>
  svc.from("ledger_entries").delete().in("id", cleanup.entries));
await purge("accounts", () =>
  svc.from("ledger_accounts").delete().in("id", cleanup.accounts));

// Prove it, rather than trusting the deletes returned no error.
{
  const { data: left } = await svc
    .from("ledger_accounts").select("id, code").in("id", cleanup.accounts);
  const { data: banks } = await svc
    .from("bank_accounts").select("id").eq("id", cleanup.bank);
  (left ?? []).length === 0 && (banks ?? []).length === 0
    ? console.log("\n(cleaned up — verified nothing left behind)")
    : (() => {
        failures++;
        console.log(
          `\n  \x1b[31mFAIL\x1b[0m cleanup left ${(left ?? []).length} ledger account(s) ` +
          `and ${(banks ?? []).length} bank account(s) behind: ` +
          `${(left ?? []).map((a) => a.code).join(", ")}`
        );
      })();
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a clean statement reconciles to zero, and a discrepancy is caught."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
