// Flutterwave / FX collections (0103) — the claims that matter:
//   • enabling a currency provisions exactly client_funds + suspense in it,
//     idempotently, and nothing else (FX is collections-only, B3)
//   • a second client-funds account in the SAME currency is still refused;
//     one in a DIFFERENT currency is not — "one per org" became "one per
//     (org, currency)", not "unlimited"
//   • the resolvers never cross currencies: an NGN call cannot return the USD
//     account and vice versa
//   • record_collection posts a USD receipt into ONLY the USD accounts — the
//     org's NGN segregation position is untouched, proving isolation rather
//     than assuming it
//   • client_funds_position reports one row PER CURRENCY, never summed
//   • raising a request in a currency with no client-funds account is refused
//     BEFORE a checkout link exists, not discovered as a broken payment
//   • an opening-balance allocation cannot cross currencies
//   • the currency-format guard rejects garbage before it reaches a table
//
// Usage: npx tsx scripts/verify-fx-collections.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const naira = (n) => `₦${Number(n).toLocaleString()}`;

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
async function login(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  const { data: { user } } = await c.auth.getUser();
  return { c, id: user.id };
}

console.log("Flutterwave / FX collections\n");

const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const org = orgs.find((o) => o.slug === "oe-group-foundation-poc");
const admin = await login("oe-group-foundation-poc.admin@oegroup.test");

// A currency this org almost certainly hasn't touched, so "does it exist yet"
// is actually being tested rather than assumed from a previous run. GBP is
// used for the create/isolate tests; EUR is left deliberately UNCONFIGURED for
// the refusal tests in section E.
const S = Date.now().toString(36).toUpperCase().slice(-4);
const FX = "GBP";
const UNCONFIGURED_FX = "EUR";
const made = { bankAccounts: [], ledgerAccounts: [], intents: [], entries: [] };

// ⚠️ Sweep stray PROBEFX rows from any earlier run BEFORE this run's own
// assertions — the same lesson `scripts/lib/probe-cleanup.mjs` documents for
// hierarchy nodes and properties. This suite's own cleanup block runs at the
// end and DOES delete everything it creates, but a run that dies with an
// uncaught exception mid-script never reaches it — end-of-run cleanup cannot
// fix the run that most needs cleaning up. Found live: two orphaned
// `ledger_entries` rows (postings already gone, entry left behind) turned up
// in the Journal UI as "Collection — other (GBP) · ₦0.00" with nothing under
// them, from an early debugging run of this very suite.
{
  const { data: strayEntries } = await svc
    .from("ledger_entries").select("id").ilike("reference", "PROBEFX%");
  if (strayEntries?.length) {
    await svc.from("ledger_postings").delete().in("entry_id", strayEntries.map((e) => e.id));
    await svc.from("ledger_entries").delete().in("id", strayEntries.map((e) => e.id));
    console.log(`  (swept ${strayEntries.length} orphaned ledger entr${strayEntries.length === 1 ? "y" : "ies"} from an earlier run)`);
  }
  const { data: strayIntents } = await svc
    .from("payment_intents").select("id").ilike("gateway_reference", "PROBEFX%");
  if (strayIntents?.length) {
    await svc.from("payment_intents").delete().in("id", strayIntents.map((i) => i.id));
    console.log(`  (swept ${strayIntents.length} stray payment intent(s) from an earlier run)`);
  }
}

// Start clean: if an earlier run left a GBP account behind, this run would
// observe "already enabled" instead of "enabling", which is a different claim.
{
  const { data: stray } = await svc
    .from("bank_accounts").select("id").eq("org_id", org.id).eq("currency", FX);
  if (stray?.length) {
    await svc.from("bank_accounts").delete().eq("org_id", org.id).eq("currency", FX);
    console.log(`  (removed ${stray.length} leftover ${FX} bank account(s) from an earlier run)`);
  }
}

console.log("A. Enabling a currency provisions exactly client_funds + suspense");
{
  const before = await svc.from("ledger_accounts").select("purpose").eq("org_id", org.id).eq("currency", FX);
  (before.data ?? []).length === 0
    ? ok(`${FX} has no accounts yet — the test starts from a real absence`)
    : bad(`${FX} already has ${(before.data ?? []).length} account(s) before enabling`);

  const { error } = await admin.c.rpc("ensure_currency_ledger_accounts", {
    p_org_id: org.id, p_currency: FX,
  });
  error ? bad(`enabling ${FX} failed — ${error.message.slice(0, 70)}`) : ok(`${FX} enabled`);

  const { data: after } = await svc
    .from("ledger_accounts").select("id, purpose, code, currency").eq("org_id", org.id).eq("currency", FX);
  made.ledgerAccounts.push(...(after ?? []).map((a) => a.id));

  const purposes = (after ?? []).map((a) => a.purpose).sort();
  JSON.stringify(purposes) === JSON.stringify(["client_funds", "suspense"])
    ? ok("exactly client_funds and suspense were created — nothing FX collections cannot use")
    : bad(`got purposes ${JSON.stringify(purposes)}, expected exactly [client_funds, suspense]`);

  const { error: again } = await admin.c.rpc("ensure_currency_ledger_accounts", {
    p_org_id: org.id, p_currency: FX,
  });
  const { data: afterTwice } = await svc
    .from("ledger_accounts").select("id").eq("org_id", org.id).eq("currency", FX);
  !again && (afterTwice ?? []).length === (after ?? []).length
    ? ok("calling it again is a no-op — idempotent, not duplicating")
    : bad(`second call ${again ? "errored" : "changed the count"}`);
}

console.log("\nB. A garbage currency code is refused before it reaches a table");
{
  const { error } = await admin.c.rpc("ensure_currency_ledger_accounts", {
    p_org_id: org.id, p_currency: "usd1",
  });
  error ? ok(`"usd1" refused (${error.message.slice(0, 40)})`) : bad("a non-currency code was accepted");
}

console.log("\nC. A bank account exists once per (org, currency), not once per org");
{
  const fxAccountRow = {
    org_id: org.id, label: `PROBEFX-${FX}-${S}`, purpose: "client_funds",
    currency: FX,
    ledger_account_id: (
      await svc.from("ledger_accounts").select("id")
        .eq("org_id", org.id).eq("currency", FX).eq("purpose", "client_funds").single()
    ).data.id,
    created_by: admin.id,
  };
  const { data: firstAcct, error: firstErr } = await svc
    .from("bank_accounts").insert(fxAccountRow).select("id").single();
  firstErr ? bad(`could not create the first ${FX} account — ${firstErr.message.slice(0, 60)}`) : ok(`a ${FX} client-funds account can be created`);
  if (firstAcct) made.bankAccounts.push(firstAcct.id);

  // A second one in the SAME currency: still refused (the constraint moved
  // from "one per org" to "one per (org, currency)", not "unlimited").
  const { error: dupErr } = await svc.from("bank_accounts").insert({
    ...fxAccountRow, label: `PROBEFX-${FX}-dup-${S}`,
  });
  dupErr && /one_client_funds/.test(dupErr.message ?? "")
    ? ok(`a SECOND ${FX} account is refused — one per currency, not unlimited`)
    : bad(`a duplicate ${FX} account was ${dupErr ? "refused for the wrong reason" : "ACCEPTED"}`);

  // The org's EXISTING NGN client-funds account is completely unaffected —
  // proving the constraint change didn't accidentally loosen NGN too.
  const { data: ngnAccounts } = await svc
    .from("bank_accounts").select("id").eq("org_id", org.id).eq("currency", "NGN").eq("active", true);
  (ngnAccounts ?? []).length === 1
    ? ok("the org still has exactly one active NGN client-funds account")
    : bad(`org has ${(ngnAccounts ?? []).length} active NGN client-funds accounts, expected 1`);
}

console.log(`\nD. The resolvers never cross currencies`);
{
  const { data: ngnBank } = await svc.rpc("collection_bank_account", { p_org_id: org.id });
  const { data: fxBank } = await svc.rpc("collection_bank_account", { p_org_id: org.id, p_currency: FX });
  ngnBank && fxBank && ngnBank !== fxBank
    ? ok("collection_bank_account(org) and collection_bank_account(org, GBP) resolve to DIFFERENT accounts")
    : bad(`NGN resolved ${ngnBank}, ${FX} resolved ${fxBank} — expected two distinct accounts`);

  const { data: ngnSuspense } = await svc.rpc("canonical_ledger_account", {
    p_org_id: org.id, p_purpose: "suspense",
  });
  const { data: fxSuspense } = await svc.rpc("canonical_ledger_account", {
    p_org_id: org.id, p_purpose: "suspense", p_currency: FX,
  });
  ngnSuspense && fxSuspense && ngnSuspense !== fxSuspense
    ? ok("canonical_ledger_account('suspense') differs between NGN and GBP")
    : bad("suspense resolved to the same account for both currencies");

  // The un-currencied 2-argument call — every remittance/rent/service-charge
  // caller in the codebase — must still resolve to NGN specifically, not
  // whichever account the planner returns first.
  const { data: legacyCall } = await svc.rpc("canonical_ledger_account", {
    p_org_id: org.id, p_purpose: "client_funds",
  });
  legacyCall === ngnBank || legacyCall === (
    await svc.from("bank_accounts").select("ledger_account_id")
      .eq("org_id", org.id).eq("currency", "NGN").eq("active", true).single()
  ).data?.ledger_account_id
    ? ok("a caller that never mentions currency still resolves to NGN, unchanged")
    : bad("the 2-argument legacy call did not resolve to the NGN account");
}

console.log("\nE. A currency with no client-funds account refuses cleanly");
{
  // EUR was deliberately never enabled. This is what an ad-hoc "Request an
  // international payment" checks BEFORE ever contacting Flutterwave.
  const { data: noAccount } = await svc.rpc("collection_bank_account", {
    p_org_id: org.id, p_currency: UNCONFIGURED_FX,
  });
  noAccount === null
    ? ok(`${UNCONFIGURED_FX} correctly resolves to no account`)
    : bad(`${UNCONFIGURED_FX} unexpectedly resolved an account — ${noAccount}`);
}

console.log("\nF. record_collection posts a foreign-currency receipt into ONLY that currency's accounts");
{
  const positionsBefore = new Map(
    ((await svc.from("client_funds_position").select("currency, funds_held").eq("org_id", org.id)).data ?? [])
      .map((p) => [p.currency, Number(p.funds_held)])
  );

  const { data: intent, error: intentErr } = await svc.from("payment_intents").insert({
    org_id: org.id, purpose: "other", amount_expected: 500, currency: FX,
    gateway: "simulated", gateway_reference: `PROBEFX-COLLECT-${S}`, created_by: admin.id,
  }).select("id").single();
  if (intentErr) bad(`could not create the ${FX} intent — ${intentErr.message.slice(0, 70)}`);
  else made.intents.push(intent.id);

  const { data: entryId, error: collectErr } = await svc.rpc("record_collection", {
    p_intent_id: intent.id, p_amount_verified: 500,
  });
  collectErr ? bad(`the ${FX} collection failed — ${collectErr.message.slice(0, 80)}`) : ok(`a ${FX} 500 collection posts`);
  if (entryId) made.entries.push(entryId);

  const positionsAfter = new Map(
    ((await svc.from("client_funds_position").select("currency, funds_held").eq("org_id", org.id)).data ?? [])
      .map((p) => [p.currency, Number(p.funds_held)])
  );

  const fxDelta = (positionsAfter.get(FX) ?? 0) - (positionsBefore.get(FX) ?? 0);
  Math.abs(fxDelta - 500) < 0.01
    ? ok(`${FX} funds held rose by exactly 500`)
    : bad(`${FX} funds held changed by ${fxDelta}, expected 500`);

  const ngnDelta = (positionsAfter.get("NGN") ?? 0) - (positionsBefore.get("NGN") ?? 0);
  Math.abs(ngnDelta) < 0.01
    ? ok("the NGN segregation position is UNTOUCHED — this is the isolation guarantee")
    : bad(`NGN funds held moved by ${ngnDelta} from a ${FX} collection — currencies are leaking into each other`);

  // And the posting itself landed on the GBP account specifically, not the
  // NGN one under a coincidentally-correct total.
  const { data: postings } = await svc
    .from("ledger_postings").select("account_id, amount, ledger_accounts(currency, purpose)")
    .eq("entry_id", entryId);
  (postings ?? []).every((p) => p.ledger_accounts?.currency === FX)
    ? ok(`every posting in the entry is on a ${FX} account`)
    : bad(`a posting landed on a non-${FX} account: ${JSON.stringify(postings)}`);
}

console.log("\nG. client_funds_position reports per currency, never summed");
{
  const { data: rows } = await svc
    .from("client_funds_position").select("currency, funds_held").eq("org_id", org.id);
  const currencies = new Set((rows ?? []).map((r) => r.currency));
  currencies.has("NGN") && currencies.has(FX) && (rows ?? []).length === currencies.size
    ? ok(`${(rows ?? []).length} distinct currency row(s), including NGN and ${FX}, no duplicates`)
    : bad(`rows: ${JSON.stringify(rows)}`);
}

console.log("\nH. An opening-balance allocation cannot cross currencies");
{
  const { data: fxBankRow } = await svc
    .from("bank_accounts").select("id, currency, opening_entry_id")
    .eq("org_id", org.id).eq("currency", FX).eq("active", true).single();

  // An NGN liability account, deliberately fed to the GBP bank's opening
  // balance — must be refused by the FUNCTION, not merely by the UI that
  // (correctly) would never offer it.
  const { data: ngnLiability } = await svc
    .from("ledger_accounts").select("id")
    .eq("org_id", org.id).eq("currency", "NGN").eq("purpose", "suspense").single();

  if (!fxBankRow?.opening_entry_id) {
    const { error } = await svc.rpc("record_opening_balance", {
      p_bank_account_id: fxBankRow.id, p_as_of: "2026-08-01",
      p_allocations: [{ accountId: ngnLiability.id, amount: 500 }],
    });
    // The function's own wording ("allocation account is in NGN but this bank
    // account is GBP") never says the word "currency" — matched on what it
    // actually says, not a paraphrase of it.
    error && /allocation account is in/i.test(error.message)
      ? ok(`a ${FX} account's opening balance refuses an NGN allocation (${error.message.slice(0, 60)})`)
      : bad(`cross-currency allocation was ${error ? `refused for the wrong reason — ${error.message.slice(0, 80)}` : "ACCEPTED"}`);
  } else {
    console.log("  (skipped — this account already has an opening balance from a prior run)");
  }
}

console.log("\nI. Flutterwave's own gateway mode reads its key's own prefix");
{
  const { gatewayMode } = await import("../lib/gateway/index.ts");
  const prevPaystack = process.env.PAYSTACK_SECRET_KEY;
  const prevFlutter = process.env.FLUTTERWAVE_SECRET_KEY;
  try {
    delete process.env.FLUTTERWAVE_SECRET_KEY;
    gatewayMode("USD") === "simulated"
      ? ok("no Flutterwave key -> simulated")
      : bad(`no key -> ${gatewayMode("USD")}, expected simulated`);

    process.env.FLUTTERWAVE_SECRET_KEY = "FLWSECK_TEST-abc123";
    gatewayMode("USD") === "test"
      ? ok("a FLWSECK_TEST- key -> test mode")
      : bad(`test key -> ${gatewayMode("USD")}, expected test`);

    process.env.FLUTTERWAVE_SECRET_KEY = "FLWSECK-abc123";
    gatewayMode("USD") === "live"
      ? ok("a live FLWSECK- key -> live mode")
      : bad(`live-shaped key -> ${gatewayMode("USD")}, expected live`);
  } finally {
    if (prevFlutter === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = prevFlutter;
    if (prevPaystack === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = prevPaystack;
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
//
// ⚠️ Order found wrong by running it: `payment_intents.ledger_entry_id` has NO
// FK delete rule (`confdeltype = 'a'`, not cascade) — deleting `ledger_entries`
// while a payment_intents row still points at it is REFUSED by Postgres, and
// this call's error was never checked. The delete silently did nothing, and an
// orphaned entry — "Collection — other (GBP) · ₦0.00", no postings under it —
// surfaced in the Journal UI from this suite's own first run. Same species of
// bug as the FK-ordering lesson in `scripts/lib/probe-cleanup.mjs`, just on a
// different table pair: the referencing row (`payment_intents`) must be
// cleared before the row it references (`ledger_entries`), not after.
await svc.from("ledger_postings").delete().in("entry_id", made.entries);
await svc.from("payment_intents").delete().in("id", made.intents);
await svc.from("ledger_entries").delete().in("id", made.entries);
await svc.from("bank_accounts").delete().in("id", made.bankAccounts);
// Ledger accounts last — postings/bank rows must be gone first, or the
// foreign keys refuse and the sweep silently fails in the way it exists to
// prevent (same lesson as scripts/lib/probe-cleanup.mjs).
await svc.from("ledger_accounts").delete().in("id", made.ledgerAccounts);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a foreign currency is a genuinely separate, segregated balance, never summed with Naira."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exitCode = failures === 0 ? 0 : 1;
