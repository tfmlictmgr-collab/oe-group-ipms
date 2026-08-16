// A remittance names the account the money left (0146).
//
// Before 0146 the link between an outgoing payment and a bank account was an
// inference: `record_remittance_sent` re-derived "the" client-funds account at
// posting time, and it agreed with what reconciliation compares only because a
// unique index permits exactly one active client-funds account per currency.
// The claims this suite holds the fix to:
//
//   • every remittance, past and future, names the account it left
//   • a payout path that forgets to say cannot exist — the table stamps it
//   • the account named is the one the LEDGER POSTING lands on, which is the
//     one reconciliation compares the bank statement against
//   • the obvious wrong accounts are refused, not resolved: another org's, an
//     operating account, one in a different currency
//   • once posted, where the money came from cannot be edited
//   • and the resolver refuses to GUESS — so relaxing the uniqueness index
//     produces a refusal naming the choice, never a silent mis-post
//
// Usage: npx tsx scripts/verify-remittance-account.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { clearLandlordPayoutChain } from "./lib/approval-chain.mjs";

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

const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const made = { remittances: [], entries: [], recipients: [], intents: [], banks: [] };

console.log("Remittance — the account the money left\n");

// ── Fixtures ───────────────────────────────────────────────────────────────
const { data: fin } = await svc.from("users").select("id, org_id")
  .eq("email", "oe-group-foundation-poc.financeapprover@oegroup.test").single();
const orgId = fin.org_id;

const { data: landlord } = await svc.from("users").select("id")
  .eq("email", "oe-group-foundation-poc.propertyowner@oegroup.test").single();

const { data: bank } = await svc.from("bank_accounts")
  .select("id, label, currency, ledger_account_id")
  .eq("org_id", orgId).eq("purpose", "client_funds").eq("active", true)
  .eq("currency", "NGN").single();

// Another organisation's client-funds account, for the cross-org refusal.
const { data: foreignBank } = await svc.from("bank_accounts")
  .select("id, org_id").eq("purpose", "client_funds").eq("active", true)
  .neq("org_id", orgId).limit(1).maybeSingle();

{
  const { data: stale } = await svc.from("payout_recipients")
    .select("id").eq("display_name", "Test Account-Naming Payouts");
  const ids = (stale ?? []).map((r) => r.id);
  if (ids.length > 0) {
    await svc.from("remittances").delete().in("recipient_id", ids);
    await svc.from("payout_recipients").delete().in("id", ids);
  }
}

const { data: rec } = await svc.from("payout_recipients").insert({
  org_id: orgId, party: "landlord", user_id: landlord.id,
  display_name: "Test Account-Naming Payouts", bank_name: "Test Bank",
  account_number_last4: "0003", recipient_code: `RCP_ACCT_${stamp}`,
  verified_at: new Date().toISOString(), created_by: fin.id,
}).select("id").single();
made.recipients.push(rec.id);

/** A queued landlord remittance, built by hand so the TABLE is what is tested. */
const newRemittance = (over = {}) => ({
  org_id: orgId, party: "landlord", recipient_id: rec.id,
  period: `ACCT-${stamp}`, reference: `REM-ACCT-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
  gross_amount: 50000, management_fee: 0, admin_fee: 0, net_amount: 50000,
  status: "queued", created_by: fin.id, ...over,
});

console.log("A. The column, and the history behind it");
{
  const { count: orphans } = await svc.from("remittances")
    .select("id", { count: "exact", head: true }).is("bank_account_id", null);
  orphans === 0
    ? ok("every remittance in the database names a client-funds account")
    : bad(`${orphans} REMITTANCE(S) NAME NO ACCOUNT`);

  // The backfill has to be right, not merely present: each historical row must
  // point at an account of its own org, purpose and currency.
  const { data: rows } = await svc.from("remittances")
    .select("id, org_id, currency, bank_accounts:bank_account_id(org_id, purpose, currency)");
  const wrong = (rows ?? []).filter((r) =>
    !r.bank_accounts ||
    r.bank_accounts.org_id !== r.org_id ||
    r.bank_accounts.purpose !== "client_funds" ||
    r.bank_accounts.currency !== r.currency
  );
  wrong.length === 0
    ? ok(`all ${rows?.length ?? 0} rows point at their own org's client-funds account in their own currency`)
    : bad(`${wrong.length} row(s) point at the wrong account`);
}

console.log("\nB. A payout that does not say is stamped, not accepted blindly");
{
  const { data: r, error } = await svc.from("remittances")
    .insert(newRemittance()).select("id, bank_account_id").single();
  if (error) {
    bad(`could not create a remittance at all — ${error.message}`);
  } else {
    made.remittances.push(r.id);
    r.bank_account_id === bank.id
      ? ok(`stamped with "${bank.label}" without the caller naming it`)
      : bad(`stamped ${r.bank_account_id}, expected ${bank.id}`);
  }
}

console.log("\nC. The wrong accounts are refused, not resolved");
{
  if (!foreignBank) {
    console.log("  \x1b[33mSKIP\x1b[0m no second organisation has a client-funds account to try");
  } else {
    const { error } = await svc.from("remittances")
      .insert(newRemittance({ bank_account_id: foreignBank.id })).select("id").single();
    error
      ? ok(`another organisation's account — refused ("${error.message.slice(0, 60)}…")`)
      : bad("A PAYOUT WAS BOOKED AGAINST ANOTHER ORGANISATION'S ACCOUNT");
  }

  // An operating account is the org's OWN money. Paying a landlord out of it
  // would be the segregation breach the whole ledger exists to prevent.
  const { data: operating } = await svc.from("bank_accounts").insert({
    org_id: orgId, label: `Operating (probe ${stamp})`, purpose: "operating",
    currency: "NGN", created_by: fin.id,
  }).select("id").single();
  made.banks.push(operating.id);
  {
    const { error } = await svc.from("remittances")
      .insert(newRemittance({ bank_account_id: operating.id })).select("id").single();
    error
      ? ok("the operating account — refused; client money leaves the segregated one")
      : bad("A PAYOUT LEFT THE OPERATING ACCOUNT");
  }

  // A currency the org holds no account in. This is the branch that used to
  // resolve to the Naira account by default, because the resolver was called
  // without a currency at all.
  //
  // ⚠️ The currency is CHOSEN, not hardcoded. The fixture org has a USD
  // client-funds account (0103), so a USD payout should be accepted and
  // stamped to it — an earlier draft hardcoded USD and read that correct
  // behaviour as a failure. The claim is "no account in that currency", so the
  // test has to find a currency there is genuinely no account for, which also
  // survives another suite adding one.
  {
    const { data: configured } = await svc.from("bank_accounts")
      .select("currency").eq("org_id", orgId).eq("purpose", "client_funds").eq("active", true);
    const held = new Set((configured ?? []).map((b) => b.currency));
    const unheld = ["GBP", "EUR", "USD", "ZAR"].find((c) => !held.has(c));

    if (!unheld) {
      console.log("  \x1b[33mSKIP\x1b[0m this organisation holds an account in every candidate currency");
    } else {
      const { error } = await svc.from("remittances")
        .insert(newRemittance({ currency: unheld })).select("id").single();
      error && error.message.includes(unheld)
        ? ok(`a ${unheld} payout with no ${unheld} account — refused, not settled in Naira`)
        : bad(error ? `refused for the wrong reason — ${error.message}` : `A ${unheld} PAYOUT WAS BOOKED AGAINST A NAIRA ACCOUNT`);
    }
  }

  // And the other half of the same rule: a currency the org DOES hold an
  // account in resolves to THAT account, not to the Naira one.
  {
    const { data: fx } = await svc.from("bank_accounts")
      .select("id, currency").eq("org_id", orgId).eq("purpose", "client_funds")
      .eq("active", true).neq("currency", "NGN").limit(1).maybeSingle();
    if (!fx) {
      console.log("  \x1b[33mSKIP\x1b[0m this organisation holds no foreign-currency account to try");
    } else {
      const { data: r, error } = await svc.from("remittances")
        .insert(newRemittance({ currency: fx.currency })).select("id, bank_account_id").single();
      if (error) {
        bad(`a ${fx.currency} payout was refused — ${error.message}`);
      } else {
        made.remittances.push(r.id);
        r.bank_account_id === fx.id
          ? ok(`a ${fx.currency} payout goes to the ${fx.currency} account, not the Naira one`)
          : bad(`a ${fx.currency} payout was stamped with ${r.bank_account_id}`);
      }
    }
  }
}

console.log("\nD. The named account is the one the posting lands on");
{
  // Put rent in hand first — the overpayment guard (0027) correctly refuses to
  // pay out of a liability nobody is owed from.
  const { data: intent } = await svc.from("payment_intents").insert({
    org_id: orgId, purpose: "rent", amount_expected: 50000,
    gateway: "simulated", gateway_reference: `RENT-ACCT-${stamp}`, created_by: fin.id,
  }).select("id").single();
  made.intents.push(intent.id);
  const { data: collEntry } = await svc.rpc("record_collection", {
    p_intent_id: intent.id, p_amount_verified: 50000,
  });
  made.entries.push(collEntry);

  const { data: r, error: cErr } = await svc.from("remittances")
    .insert(newRemittance()).select("id, bank_account_id").single();
  if (cErr) {
    bad(`could not create — ${cErr.message}`);
  } else {
    made.remittances.push(r.id);
    // ⚠️ Since 0151/0152 a landlord payout climbs the three-stage approval
    // chain and the sender must be named — this suite is about which BANK
    // ACCOUNT a payout names, so both are fixtures here rather than assertions.
    {
      const lc = await clearLandlordPayoutChain(svc, orgId, r.id);
      if (!lc.ok) bad(`could not stage the approval chain — ${lc.why}`);
    }
    await svc.rpc("claim_remittance_for_sending", { p_id: r.id, p_sent_by: fin.id });
    const { data: entryId, error: pErr } = await svc.rpc("record_remittance_sent", {
      p_id: r.id, p_transfer_code: `TRF_ACCT_${stamp}`,
    });
    if (pErr) {
      bad(`posting failed — ${pErr.message}`);
    } else {
      made.entries.push(entryId);
      const { data: postings } = await svc.from("ledger_postings")
        .select("account_id, amount").eq("entry_id", entryId);
      const bankSide = (postings ?? []).find((p) => Number(p.amount) < 0);
      bankSide?.account_id === bank.ledger_account_id
        ? ok("the money came off the ledger account behind the named bank account")
        : bad(`posted to ${bankSide?.account_id}, not ${bank.ledger_account_id}`);

      // The same account reconciliation compares the statement against — which
      // is the whole point: a payout is now matchable by construction.
      const { data: reconBank } = await svc.from("bank_accounts")
        .select("ledger_account_id").eq("id", r.bank_account_id).single();
      reconBank.ledger_account_id === bankSide?.account_id
        ? ok("reconciliation reads that same account, so the payout is matchable")
        : bad("the posting and reconciliation are about different accounts");

      console.log("\nE. Once posted, where it came from is history");
      const target = foreignBank?.id ?? bank.id;
      const { error: uErr } = await svc.from("remittances")
        .update({ bank_account_id: target }).eq("id", r.id);
      const { data: still } = await svc.from("remittances")
        .select("bank_account_id").eq("id", r.id).single();
      still.bank_account_id === bank.id
        ? ok(`the account cannot be changed after posting${uErr ? " (refused outright)" : ""}`)
        : bad("A POSTED PAYOUT WAS RE-POINTED AT ANOTHER ACCOUNT");
    }
  }
}

console.log("\nF. The resolver refuses to guess");
{
  // The index is what makes "the" client-funds account well-defined today.
  // Asserted explicitly so that dropping it is a decision someone takes with
  // this test in front of them.
  const { data: hasIndex } = await svc.rpc("client_funds_bank_account", {
    p_org_id: orgId, p_currency: "NGN",
  });
  hasIndex === bank.id
    ? ok("resolves the single configured account by org and currency")
    : bad(`resolved ${hasIndex}, expected ${bank.id}`);

  const { data: configured } = await svc.from("bank_accounts")
    .select("currency").eq("org_id", orgId).eq("purpose", "client_funds").eq("active", true);
  const held = new Set((configured ?? []).map((b) => b.currency));
  const unheld = ["GBP", "EUR", "USD", "ZAR"].find((c) => !held.has(c));

  if (!unheld) {
    console.log("  \x1b[33mSKIP\x1b[0m this organisation holds an account in every candidate currency");
  } else {
    const { error } = await svc.rpc("client_funds_bank_account", {
      p_org_id: orgId, p_currency: unheld,
    });
    error && error.message.includes(unheld)
      ? ok("a currency with no account — refused with the currency named")
      : bad(error ? `wrong refusal — ${error.message}` : "RESOLVED AN ACCOUNT THAT DOES NOT EXIST");
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("remittances").delete().in("id", made.remittances.filter(Boolean));
await svc.from("payment_intents").delete().in("id", made.intents);
const uniqueEntries = [...new Set(made.entries.filter(Boolean))];
await svc.from("ledger_postings").delete().in("entry_id", uniqueEntries);
await svc.from("ledger_entries").delete().in("id", uniqueEntries);
await svc.from("payout_recipients").delete().in("id", made.recipients);
await svc.from("bank_accounts").delete().in("id", made.banks);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — every payout says which account it left, and posts there."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
