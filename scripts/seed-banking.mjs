// The one thing `npm run seed` never gave the demo dataset: a bank account.
//
// ⚠️ Why this exists. `0146` made a remittance name the account the money left,
// and `client_funds_bank_account()` raises when the organisation has none:
//
//   "this organisation has no active NGN client-funds account, so nothing can
//    be paid out of one — configure it under Settings → Banking first"
//
// Nothing in the seed pipeline ever created that row. It was added by hand
// through Settings → Banking on `dev`, months ago, by whoever needed it first —
// so `dev` has one and every other world does not. That is invisible until you
// point the verification suites somewhere else, at which point FIVE of them
// fail at their fixture and never reach a single assertion:
// `verify-remittance`, `verify-remittance-account`, `verify-approval-chain`,
// `verify-ops-requisitions` and `verify-fx-collections`. Worse than the noise:
// `verify-approval-chain` dies before its cleanup block, leaving a probe
// property and a landlord payout recipient behind on every run — and the
// recipient occupies the `(org_id, user_id)` unique slot that
// `verify-remittance-account` then needs, so one missing row failed suites
// that had nothing to do with banking.
//
// 📌 The lesson is the one `0206` records for document requirements one file
// earlier: a thing every organisation needs, created once by hand against the
// organisations that happened to exist, is not configuration — it is a gap
// waiting for the next environment. Remittance is part of the demo; the demo
// seed has to produce something that can remit.
//
// This is NOT the production path. Production starts empty and a real bank
// account is entered by a real administrator through Settings → Banking, with
// a real bank behind it (GO_LIVE_CHECKLIST §1). This seeds the *synthetic*
// worlds so the demo and the suites have something to point at, and it builds
// the row exactly the way `saveBankAccount` does — same purpose, same currency,
// same `canonical_ledger_account` resolution — so what it writes is what the
// product would have written.
//
// Idempotent. Safe to re-run; touches nothing that already exists.
//
//   node scripts/seed-banking.mjs                  → whatever .env.local points at
//   node scripts/seed-banking.mjs --world staging  → .env.staging.local, directly
//
// ⚠️ Refuses to run against a world holding a live payment gateway key, on the
// same reasoning `migrate.mjs` gives for preferring `--world`: the cost of
// being wrong about which environment you are in is not symmetrical.
import path from "node:path";
import { existsSync } from "node:fs";
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
if (world === "prod") {
  console.error(
    "Refusing to seed banking on prod. A production client-funds account is a real\n" +
    "bank account, entered by a real administrator through Settings → Banking."
  );
  process.exit(1);
}

const envFile = world ? `.env.${world}.local` : ".env.local";
const envPath = path.join(rootDir, envFile);
if (!existsSync(envPath)) {
  console.error(`Missing ${envFile}.`);
  process.exit(1);
}

// Read into a private object when a world is named — dotenv does not overwrite
// what is already set, so a shell carrying SUPABASE_* would silently win.
const env = {};
config({ path: envPath, processEnv: world ? env : process.env });
if (!world) Object.assign(env, process.env);

const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log(`Seeding client-funds banking: ${envFile}\n`);

const { data: orgs, error: orgErr } = await svc
  .from("orgs")
  .select("id, name, slug, is_platform_operator")
  .is("deleted_at", null)
  .order("name");
if (orgErr) {
  console.error("could not read orgs:", orgErr.message);
  process.exit(1);
}

let created = 0;
let already = 0;

for (const org of orgs) {
  // The operator org holds no client money — it governs, it does not collect
  // (decision 7). Giving it a client-funds account would put a segregated
  // balance on the one organisation that must never have one.
  if (org.is_platform_operator) {
    console.log(`  ${org.slug ?? org.id} — skipped (platform operator holds no client funds)`);
    continue;
  }

  const { data: existing, error: exErr } = await svc
    .from("bank_accounts")
    .select("id, label, active")
    .eq("org_id", org.id)
    .eq("purpose", "client_funds")
    .eq("currency", "NGN")
    .maybeSingle();
  if (exErr) {
    console.error(`  ${org.slug} — could not check: ${exErr.message}`);
    process.exitCode = 1;
    continue;
  }
  if (existing) {
    already += 1;
    console.log(`  ${org.slug ?? org.id} — already has "${existing.label}"${existing.active ? "" : " (INACTIVE)"}`);
    continue;
  }

  // The chart of accounts first: a bank account with no ledger counterpart
  // reconciles against nothing, and `client_funds_bank_account()` requires
  // `ledger_account_id is not null` before it will resolve the row at all.
  // Idempotent by its own definition.
  const { error: coaErr } = await svc.rpc("ensure_default_ledger_accounts", { p_org_id: org.id });
  if (coaErr) {
    console.error(`  ${org.slug} — chart of accounts: ${coaErr.message}`);
    process.exitCode = 1;
    continue;
  }

  const { data: ledgerAccountId, error: laErr } = await svc.rpc("canonical_ledger_account", {
    p_org_id: org.id, p_purpose: "client_funds", p_currency: "NGN",
  });
  if (laErr || !ledgerAccountId) {
    console.error(`  ${org.slug} — no client_funds ledger account: ${laErr?.message ?? "resolved null"}`);
    process.exitCode = 1;
    continue;
  }

  // Last four digits only, never a full number — the rule `saveBankAccount`
  // enforces and `0164` restates for vendors. Synthetic digits, derived from
  // nothing, because there is no real account behind this row.
  const { error: insErr } = await svc.from("bank_accounts").insert({
    org_id: org.id,
    label: "Client funds account",
    purpose: "client_funds",
    bank_name: "Demo Bank (synthetic)",
    account_name: `${org.name} — Client Funds`,
    account_number_last4: "0000",
    currency: "NGN",
    ledger_account_id: ledgerAccountId,
    active: true,
  });
  if (insErr) {
    console.error(`  ${org.slug} — insert failed: ${insErr.message}`);
    process.exitCode = 1;
    continue;
  }
  created += 1;
  console.log(`  ${org.slug ?? org.id} — created a segregated NGN client-funds account`);
}

console.log(
  `\n${created} created, ${already} already configured. ` +
  `No opening balance is posted — the ledger starts at zero and reconciles to it.`
);
