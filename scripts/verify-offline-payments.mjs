// Proves the off-platform payment path (0281/0282) — a rent or service-charge
// payment made by bank transfer or over a bank counter, recorded with its proof,
// and confirmed by three desks before it becomes money.
//
// The claims that matter:
//   • proof and an amount are COMPULSORY, and the breakdown has to reconcile
//   • a claim has NO ledger effect until the chain completes
//   • the chain is auditor -> executive -> Payment Officer, in that order, and
//     the Payment Officer alone posts
//   • the person who RECORDED it can never confirm it, at any stage
//   • a returned claim has a way back; a rejected one is terminal
//   • the posting goes through record_collection, so the fee split, the
//     property's own SC fund and the charge's balance all move exactly as they
//     do for a card payment
//   • every confirmer can read the claim, its breakdown, its chain and its proof
//
// ⚠️ Every act under test runs in a REAL SESSION. The service role is used only
// to build preconditions (a lease, a demand) and to read back what the database
// actually holds. verify-vendor-self-service's own recorded lesson is that a
// suite whose fixtures all write through the service role proves the policy
// works and never once sits in the user's seat — this one sits in five.
//
// Usage: npx tsx scripts/verify-offline-payments.mjs
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
const section = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

if (!URL || !ANON || !SVCK) {
  console.error("Cannot reach Supabase — .env.local is missing URL/ANON/SERVICE_ROLE.");
  process.exit(0);
}

const svc = createClient(URL, SVCK, { auth: { persistSession: false } });

async function login(email) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  const { data: { user } } = await c.auth.getUser();
  return { c, id: user.id, email };
}

/** An RPC that is expected to fail; returns the message. */
async function refused(client, fn, args) {
  const { error } = await client.rpc(fn, args);
  return error ? error.message : null;
}

const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const made = { claims: [], charges: [], leases: [], objects: [] };

console.log(`\nOff-platform payments — 0281/0282   (fixture tag ${stamp})`);

// ── Cast ────────────────────────────────────────────────────────────────────
const tenant = await login("oea.tenant@oegroup.test");
const auditor = await login("oea.paymentauditapprover@oegroup.test");
const exec = await login("oea.executive@oegroup.test");
const officer = await login("oea.financeapprover@oegroup.test");
const officer2 = await login("oea.finance@oegroup.test");
const pm = await login("oea.pm@oegroup.test");
const otherTenant = await login("tfml.tenant@oegroup.test");

const { data: me } = await svc.from("users").select("org_id").eq("id", tenant.id).single();
const orgId = me.org_id;

// ── Preconditions (service role — these are the world, not the acts) ────────
const { data: lease } = await svc
  .from("leases")
  .select("id, property_id, unit_id, tenant_user_id")
  .eq("tenant_user_id", tenant.id)
  .in("status", ["active", "renewed"])
  .limit(1).maybeSingle();

if (!lease) {
  console.error("No active lease for oea.tenant — seed the brand demo content first.");
  process.exit(0);
}

// ⚠️ Fixture demands sit in a distinct, far-future period PER RUN, and the
// teardown removes them.
//
// `rent_charges_one_per_period` is UNIQUE (lease_id, period_start), so a fixed
// date makes the second run of this suite fail on its first line — which reads
// as a broken feature and is only a collided fixture. Spread by DAYS rather than
// years: a year offset out of ninety collides between two runs about one time in
// ninety per fixture, which duly happened, three sections into an otherwise
// green run.
//
// 📌 The far-future dates are ALSO why these have to be cleaned up rather than
// left. They ran against a real demo tenant's real lease, so every posted
// fixture stayed on that person's My Rent screen — the board saw "1 Oct 2472 –
// 30 Sept 2473 · ₦500,000 · Paid" in a screenshot of the live portal. The ledger
// postings stay (append-only, 0256); the DEMAND rows do not.
const FEE_PCT = 10;
const FIXTURE_EPOCH = Date.UTC(2200, 0, 1);
const DAY = 86400000;
const baseDay = FIXTURE_EPOCH + (Date.now() % 50000) * DAY;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const period = (n) => ({
  period_start: iso(baseDay + n * 400 * DAY),
  period_end: iso(baseDay + (n * 400 + 364) * DAY),
  due_date: iso(baseDay + n * 400 * DAY),
});

// Sweep any UNPOSTED fixture demands a previous crashed run left on this lease.
// Posted ones are left alone: they are real ledger history, even here.
await svc.from("rent_charges").delete()
  .eq("lease_id", lease.id).is("ledger_entry_id", null).gte("period_start", "2200-01-01");

/** A fixture insert that says so when it fails, instead of null-dereferencing. */
async function seedCharge(n, amount) {
  const { data, error } = await svc.from("rent_charges").insert({
    org_id: orgId, lease_id: lease.id, ...period(n),
    amount, currency: "NGN",
    management_fee_pct: FEE_PCT, management_fee_amount: amount * (FEE_PCT / 100),
    admin_fee_amount: 0, landlord_net_amount: amount * (1 - FEE_PCT / 100),
  }).select("id").single();
  if (error) {
    console.error(`\n  fixture: could not seed a rent demand (period ${n}): ${error.message}`);
    process.exit(1);
  }
  made.charges.push(data.id);
  return data;
}

const RENT = 2400000;
const FEE = RENT * (FEE_PCT / 100);
const charge = await seedCharge(0, RENT);

// ⚠️ NAIRA, and ordered. This was `.limit(1)` on purpose+active alone, which is
// non-deterministic the moment an org holds a client-funds account in more than
// one currency — and section J creates exactly that. The planner duly handed
// back the USD account on the next run and four checks in section A failed with
// "that account holds USD, and this payment is in NGN": the product refusing
// correctly, against a fixture that had quietly changed underneath it.
//
// 📌 Decision 38 recorded this same fault one table over — an unordered
// `.limit(1)` picking a probe account out of several — and the remedy is the
// same: say which row you mean.
const { data: bank } = await svc.from("bank_accounts")
  .select("id, label, currency").eq("org_id", orgId)
  .eq("purpose", "client_funds").eq("active", true).eq("currency", "NGN")
  .order("created_at", { ascending: true })
  .limit(1).single();

const { data: fundsAccountId } = await svc.rpc("collection_bank_account", {
  p_org_id: orgId, p_currency: "NGN",
});
const balanceOf = async (accountId) => {
  const { data } = await svc.rpc("ledger_account_balance", { p_account_id: accountId })
    .then((r) => r, () => ({ data: null }));
  if (data !== null && data !== undefined) return Number(data);
  const { data: rows } = await svc.from("ledger_postings").select("amount").eq("account_id", accountId);
  return (rows ?? []).reduce((t, r) => t + Number(r.amount), 0);
};

// A proof object, uploaded by the tenant themselves into their org's prefix.
async function uploadProof(client, tag) {
  const objectPath = `${orgId}/${stamp}-${tag}/teller-slip.pdf`;
  const body = new Blob([`%PDF-1.4 fake teller slip ${tag}`], { type: "application/pdf" });
  // ⚠️ `upsert: false`, deliberately. There is no UPDATE policy on this bucket
  // (0281): evidence is written once and replaced by deleting the unclaimed
  // object, never overwritten in place. An upsert therefore needs a permission
  // that does not exist, and storage reports that as "The database schema is
  // invalid or incompatible" — a 503 for what is really a 403.
  const { error } = await client.storage.from("payment-proofs").upload(objectPath, body, {
    contentType: "application/pdf", upsert: false,
  });
  if (error) throw new Error(`proof upload (${tag}): ${error.message}`);
  made.objects.push(objectPath);
  return objectPath;
}

const rentLine = (amount) => [{ purpose: "rent", rent_charge_id: charge.id, amount }];

async function submitAs(client, overrides = {}) {
  const proof = overrides.proof ?? await uploadProof(client, overrides.tag ?? "a");
  return client.rpc("submit_offline_payment_claim", {
    p_method: "bank_transfer",
    p_amount: overrides.amount ?? RENT,
    p_paid_on: overrides.paidOn ?? "2026-09-05",
    p_bank_account_id: overrides.bankId ?? bank.id,
    p_proof_path: overrides.proofPath !== undefined ? overrides.proofPath : proof,
    p_allocations: overrides.allocations ?? rentLine(overrides.amount ?? RENT),
    p_currency: "NGN",
    p_payer_reference: "GTB/TRF/998877",
    p_payer_note: overrides.note ?? "Annual rent paid by transfer, receipt attached.",
    p_proof_filename: "teller-slip.pdf",
  });
}

// ════════════════════════════════════════════════════════════════════════════
section("A. The two compulsory halves, and the breakdown");

{
  const m = await refused(tenant.c, "submit_offline_payment_claim", {
    p_method: "bank_transfer", p_amount: RENT, p_paid_on: "2026-09-05",
    p_bank_account_id: bank.id, p_proof_path: "", p_allocations: rentLine(RENT),
  });
  m && /attach your payment proof/i.test(m)
    ? ok("proof is compulsory, and the refusal says what to attach")
    : bad(`no proof should be refused with usable words, got: ${m}`);
}
{
  const proof = await uploadProof(tenant.c, "noamt");
  const m = await refused(tenant.c, "submit_offline_payment_claim", {
    p_method: "bank_transfer", p_amount: 0, p_paid_on: "2026-09-05",
    p_bank_account_id: bank.id, p_proof_path: proof, p_allocations: rentLine(RENT),
  });
  m && /amount you paid/i.test(m)
    ? ok("an amount is compulsory")
    : bad(`zero amount should be refused, got: ${m}`);
}
{
  const proof = await uploadProof(tenant.c, "nolines");
  const m = await refused(tenant.c, "submit_offline_payment_claim", {
    p_method: "bank_transfer", p_amount: RENT, p_paid_on: "2026-09-05",
    p_bank_account_id: bank.id, p_proof_path: proof, p_allocations: [],
  });
  m && /what this payment is for/i.test(m)
    ? ok("a payment has to say what it pays for")
    : bad(`empty breakdown should be refused, got: ${m}`);
}
{
  const { error } = await submitAs(tenant.c, { tag: "mismatch", amount: RENT,
    allocations: rentLine(RENT - 1000) });
  error && /breakdown comes to/i.test(error.message)
    ? ok("the breakdown must reconcile to the amount paid")
    : bad(`a breakdown that does not add up should be refused, got: ${error?.message}`);
}
{
  const { error } = await submitAs(tenant.c, { tag: "future", paidOn: "2099-01-01" });
  error && /cannot be in the future/i.test(error.message)
    ? ok("a payment cannot have been made in the future")
    : bad(`future date should be refused, got: ${error?.message}`);
}
{
  const { error } = await submitAs(tenant.c, { tag: "over", amount: RENT + 50000,
    allocations: rentLine(RENT + 50000) });
  error && /outstanding/i.test(error.message)
    ? ok("a line cannot exceed what the demand actually owes")
    : bad(`overpaying one demand should be refused, got: ${error?.message}`);
}
{
  const proof = await uploadProof(tenant.c, "wrongorg");
  const m = await refused(tenant.c, "submit_offline_payment_claim", {
    p_method: "bank_transfer", p_amount: RENT, p_paid_on: "2026-09-05",
    p_bank_account_id: bank.id,
    p_proof_path: `00000000-0000-0000-0000-000000000000/${stamp}/x.pdf`,
    p_allocations: rentLine(RENT),
  });
  m && /not uploaded to this organisation/i.test(m)
    ? ok("a proof path outside the org's own prefix is refused")
    : bad(`cross-org proof path should be refused, got: ${m}`);
}

// ════════════════════════════════════════════════════════════════════════════
section("B. Standing — whose demand is it");

{
  const proof = await uploadProof(otherTenant.c, "cross").catch((e) => e.message);
  if (typeof proof === "string" && proof.includes("row-level security")) {
    ok("a tenant cannot upload proof into another organisation's prefix");
  } else {
    const m = await refused(otherTenant.c, "submit_offline_payment_claim", {
      p_method: "bank_transfer", p_amount: RENT, p_paid_on: "2026-09-05",
      p_bank_account_id: bank.id, p_proof_path: proof, p_allocations: rentLine(RENT),
    });
    m ? ok(`a tenant in another org cannot pay this demand — "${m.slice(0, 60)}"`)
      : bad("a tenant in another org was able to record a payment against this demand");
  }
}
{
  const { data } = await tenant.c.rpc("offline_allocatable_charges");
  const mine = (data ?? []).find((r) => r.charge_id === charge.id);
  mine && mine.is_own
    ? ok("the tenant is offered their own demand, marked as their own")
    : bad("the tenant's own outstanding demand was not offered to them");
  (data ?? []).every((r) => r.is_own)
    ? ok("a tenant is offered nothing but their own charges")
    : bad("a tenant was offered a charge that is not theirs");
}
{
  // ⚠️ The scope is MOVED rather than assumed. 0265 records why: a check that
  // relies on the seed having staked a manager to the right building passes or
  // fails for reasons that have nothing to do with the rule, and reads as a
  // product fault either way. Stake them and the row appears; un-stake them and
  // it is gone — that is the scoping doing the deciding, proven in both
  // directions.
  await svc.from("property_stakeholders").delete()
    .eq("user_id", pm.id).eq("property_id", lease.property_id);

  const { data: before } = await pm.c.rpc("offline_allocatable_charges");
  (before ?? []).every((r) => r.charge_id !== charge.id)
    ? ok("un-staked, the PM is offered nothing on that building")
    : bad("a PM who manages no property was still offered its demand");

  const { error: stakeErr } = await svc.from("property_stakeholders").insert({
    org_id: orgId, user_id: pm.id, property_id: lease.property_id, relation: "manager",
  });
  if (stakeErr) { bad(`could not stake the PM: ${stakeErr.message}`); }
  else {
    const { data: after } = await pm.c.rpc("offline_allocatable_charges");
    (after ?? []).some((r) => r.charge_id === charge.id)
      ? ok("staked to the property, the identical demand is offered to the PM")
      : bad("a PM staked to the property was still not offered its demand");
    const mine = (after ?? []).find((r) => r.charge_id === charge.id);
    mine && mine.is_own === false
      ? ok("…and it is marked as somebody else's, not their own")
      : bad("the PM's view of a tenant's demand claims it is their own");
    made.staked = { user_id: pm.id, property_id: lease.property_id };
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("C. A recorded claim is not money");

const { data: claimId, error: submitErr } = await submitAs(tenant.c, { tag: "main" });
if (submitErr) { bad(`the tenant could not record their payment: ${submitErr.message}`); }
else {
  made.claims.push(claimId);
  ok("the tenant recorded their bank transfer with proof, amount and breakdown");
}

const fundsBefore = await balanceOf(fundsAccountId);
{
  const { data: c } = await svc.from("offline_payment_claims")
    .select("status, posted_at, claimed_amount, payer_user_id, recorded_by, payer_note")
    .eq("id", claimId).single();
  c.status === "submitted" && c.posted_at === null
    ? ok("it lands as submitted, with nothing posted")
    : bad(`expected submitted/unposted, got ${c.status}/${c.posted_at}`);
  c.payer_user_id === tenant.id && c.recorded_by === tenant.id
    ? ok("payer and recorder are both resolved")
    : bad("payer/recorder were not resolved correctly");
  c.payer_note?.includes("receipt attached")
    ? ok("the payer's own note is kept")
    : bad("the payer's note was lost");

  const { data: rc } = await svc.from("rent_charges")
    .select("amount_paid, status").eq("id", charge.id).single();
  Number(rc.amount_paid) === 0
    ? ok("the demand's balance has NOT moved — a claim is not a payment")
    : bad(`arrears moved on an unconfirmed claim: amount_paid = ${rc.amount_paid}`);

  const { count } = await svc.from("payment_intents")
    .select("id", { count: "exact", head: true })
    .like("gateway_reference", `%${stamp}%`);
  ok(`no ledger entry and no intent exists yet (${count ?? 0} intents)`);
}

// ════════════════════════════════════════════════════════════════════════════
section("D. Every confirmer sees the whole record");

for (const [who, s] of [["auditor", auditor], ["executive", exec], ["Payment Officer", officer]]) {
  const { data: rows } = await s.c.from("offline_payment_claims")
    .select("id, reference, claimed_amount, payer_note, proof_path").eq("id", claimId);
  const { data: lines } = await s.c.rpc("offline_claim_lines", { p_claim_id: claimId });
  const { data: chain } = await s.c.rpc("offline_claim_chain", { p_claim_id: claimId });
  const seesProof = rows?.[0]?.proof_path?.startsWith(orgId);
  const okAll = rows?.length === 1 && (lines ?? []).length === 1 && (chain ?? []).length === 3 && seesProof;
  okAll
    ? ok(`the ${who} reads the claim, its breakdown, its chain and the proof`)
    : bad(`the ${who} could not read the whole record (claim ${rows?.length}, lines ${lines?.length}, chain ${chain?.length}, proof ${seesProof})`);

  const { data: signed } = await s.c.storage.from("payment-proofs")
    .createSignedUrl(rows?.[0]?.proof_path ?? "x", 60);
  signed?.signedUrl
    ? ok(`the ${who} can open the uploaded proof itself`)
    : bad(`the ${who} cannot open the proof — 0217 all over again`);
}
{
  const { data: rows } = await otherTenant.c.from("offline_payment_claims").select("id").eq("id", claimId);
  (rows ?? []).length === 0
    ? ok("an unrelated tenant in another org sees nothing")
    : bad("a tenant in another organisation could read this claim");
}
{
  const { data: mine } = await tenant.c.rpc("my_offline_payment_claims");
  const row = (mine ?? []).find((r) => r.claim_id === claimId);
  row && row.stages_total === 3 && row.stages_done === 0
    ? ok(`the tenant sees their own claim and where it is (0 of 3 — "${row.current_stage_label}")`)
    : bad("the tenant could not see their own claim's progress");
}

// ════════════════════════════════════════════════════════════════════════════
section("E. The chain: order, roles, and one pair of hands per desk");

{
  const m = await refused(officer.c, "confirm_offline_payment",
    { p_claim_id: claimId, p_stage: 3, p_decision: "confirmed" });
  m && /earlier stage/i.test(m)
    ? ok("the Payment Officer cannot post before the desks below have signed")
    : bad(`stage 3 before stages 1-2 should be refused, got: ${m}`);
}
{
  const m = await refused(exec.c, "confirm_offline_payment",
    { p_claim_id: claimId, p_stage: 1, p_decision: "confirmed" });
  m && /actioned by/i.test(m)
    ? ok("the executive cannot stand at the auditor's desk")
    : bad(`wrong role at stage 1 should be refused, got: ${m}`);
}
{
  const m = await refused(tenant.c, "confirm_offline_payment",
    { p_claim_id: claimId, p_stage: 1, p_decision: "confirmed" });
  m ? ok(`the tenant cannot confirm their own payment — "${m.slice(0, 70)}"`)
    : bad("the tenant confirmed their own payment");
}
{
  const { error } = await auditor.c.rpc("confirm_offline_payment",
    { p_claim_id: claimId, p_stage: 1, p_decision: "confirmed" });
  error ? bad(`the auditor could not confirm stage 1: ${error.message}`)
        : ok("stage 1 — the auditor verifies the evidence");
}
{
  const m = await refused(auditor.c, "confirm_offline_payment",
    { p_claim_id: claimId, p_stage: 2, p_decision: "confirmed" });
  m && /(actioned by|second pair of hands)/i.test(m)
    ? ok("the auditor cannot also take the executive's stage")
    : bad(`one human, one stage — got: ${m}`);
}
{
  const { error } = await exec.c.rpc("confirm_offline_payment",
    { p_claim_id: claimId, p_stage: 2, p_decision: "confirmed" });
  error ? bad(`the executive could not confirm stage 2: ${error.message}`)
        : ok("stage 2 — the executive authorises");
}
{
  const { data: rc } = await svc.from("rent_charges").select("amount_paid").eq("id", charge.id).single();
  Number(rc.amount_paid) === 0
    ? ok("two desks in, and the demand's balance still has not moved")
    : bad("money moved before the Payment Officer confirmed");
}

// ════════════════════════════════════════════════════════════════════════════
section("F. The terminal desk posts it, and the arithmetic is right");

{
  const { error } = await officer.c.rpc("confirm_offline_payment",
    { p_claim_id: claimId, p_stage: 3, p_decision: "confirmed" });
  error ? bad(`the Payment Officer could not post: ${error.message}`)
        : ok("stage 3 — the Payment Officer confirms, and it becomes money");
}
{
  const { data: c } = await svc.from("offline_payment_claims")
    .select("status, posted_at, confirmed_amount, confirmed_by").eq("id", claimId).single();
  c.status === "confirmed" && c.posted_at && Number(c.confirmed_amount) === RENT
    ? ok(`the claim is confirmed at ${RENT.toLocaleString()} and stamped as posted`)
    : bad(`expected confirmed/posted, got ${c.status}/${c.posted_at}/${c.confirmed_amount}`);
  c.confirmed_by === officer.id
    ? ok("who authorised the posting is recorded — decision 23's missing actor is not repeated")
    : bad("the posting names no confirmer");
}
{
  const { data: rc } = await svc.from("rent_charges")
    .select("amount_paid, status, ledger_entry_id").eq("id", charge.id).single();
  Number(rc.amount_paid) === RENT && rc.status === "paid"
    ? ok("the rent demand is settled in full and marked paid")
    : bad(`demand did not settle: paid ${rc.amount_paid}, status ${rc.status}`);
  rc.ledger_entry_id ? ok("the demand names the ledger entry that settled it")
                     : bad("the demand carries no ledger entry");
}
{
  const { data: alloc } = await svc.from("offline_payment_allocations")
    .select("intent_id, ledger_entry_id, amount").eq("claim_id", claimId);
  alloc?.every((a) => a.intent_id && a.ledger_entry_id)
    ? ok("every breakdown line carries the intent and ledger entry it produced")
    : bad("a breakdown line posted nothing");

  const { data: intent } = await svc.from("payment_intents")
    .select("gateway, status, amount_paid, created_by").eq("id", alloc[0].intent_id).single();
  intent.gateway === "manual"
    ? ok("it posted through a `manual` intent — the enum value 0032 reserved for exactly this")
    : bad(`expected gateway manual, got ${intent.gateway}`);
  intent.created_by === officer.id
    ? ok("the ledger entry is attributed to the officer who authorised it")
    : bad("the posting is attributed to nobody, or to the wrong person");

  // The fee split — record_collection's own arithmetic, reached unchanged.
  const { data: postings } = await svc.from("ledger_postings")
    .select("amount, account_id, memo").eq("entry_id", alloc[0].ledger_entry_id);
  const total = postings.reduce((t, p) => t + Number(p.amount), 0);
  Math.abs(total) < 0.01 ? ok("the entry balances")
                         : bad(`the entry does not balance: ${total}`);
  // ⚠️ Matched on the whole phrase. `/fee/i` also matches the landlord line's
  // "Held for the landlord, net of fees", so the loose regex found the wrong
  // posting and reported the landlord's figure as a broken fee split.
  const feeRow = postings.find((p) => /management and admin fee/i.test(p.memo ?? ""));
  feeRow && Math.abs(Number(feeRow.amount) + FEE) < 0.01
    ? ok(`the management fee came out at the snapshotted ${FEE_PCT}% (₦${FEE.toLocaleString()})`)
    : bad(`fee posting wrong: ${feeRow?.amount}`);
  const landlordRow = postings.find((p) => /landlord/i.test(p.memo ?? ""));
  landlordRow && Math.abs(Number(landlordRow.amount) + (RENT - FEE)) < 0.01
    ? ok(`the landlord is credited net of fees (₦${(RENT - FEE).toLocaleString()})`)
    : bad(`landlord posting wrong: ${landlordRow?.amount}`);
}
{
  const after = await balanceOf(fundsAccountId);
  Math.abs(after - fundsBefore - RENT) < 0.01
    ? ok(`client funds held rose by exactly the payment (₦${RENT.toLocaleString()})`)
    : bad(`funds moved by ${after - fundsBefore}, expected ${RENT}`);
}
{
  const m = await refused(officer.c, "confirm_offline_payment",
    { p_claim_id: claimId, p_stage: 3, p_decision: "confirmed" });
  m && /already/i.test(m)
    ? ok("a posted claim cannot be actioned again — no double posting")
    : bad(`re-confirming should be refused, got: ${m}`);
}
{
  const { data: chain } = await officer.c.rpc("offline_claim_chain", { p_claim_id: claimId });
  const done = (chain ?? []).filter((s) => s.decision === "confirmed");
  done.length === 3 && done.every((s) => s.decided_by)
    ? ok("the trail names all three desks, each with a person and a time")
    : bad(`the chain does not name its signatories: ${JSON.stringify(chain?.map((s) => s.decided_by))}`);
}
{
  const { data: mine } = await tenant.c.rpc("my_offline_payment_claims");
  const row = (mine ?? []).find((r) => r.claim_id === claimId);
  row?.status === "confirmed" && row.stages_done === 3
    ? ok("the tenant sees their payment confirmed, 3 of 3")
    : bad("the tenant was not shown the completed confirmation");
}

// ════════════════════════════════════════════════════════════════════════════
section("G. Maker-checker: the recorder can never confirm");

{
  const rc2 = await seedCharge(2, 500000);

  // The Payment Officer takes a walk-in payment themselves.
  const proof = await uploadProof(officer.c, "walkin");
  const { data: walkIn, error } = await officer.c.rpc("submit_offline_payment_claim", {
    p_method: "bank_deposit", p_amount: 500000, p_paid_on: "2026-09-06",
    p_bank_account_id: bank.id, p_proof_path: proof,
    p_allocations: [{ purpose: "rent", rent_charge_id: rc2.id, amount: 500000 }],
    p_payer_note: "Paid in cash at the counter.",
  });
  if (error) { bad(`the Payment Officer could not record a walk-in: ${error.message}`); }
  else {
    made.claims.push(walkIn);
    ok("the Payment Officer records a walk-in cash deposit on the tenant's behalf");

    await auditor.c.rpc("confirm_offline_payment",
      { p_claim_id: walkIn, p_stage: 1, p_decision: "confirmed" });
    await exec.c.rpc("confirm_offline_payment",
      { p_claim_id: walkIn, p_stage: 2, p_decision: "confirmed" });

    const m = await refused(officer.c, "confirm_offline_payment",
      { p_claim_id: walkIn, p_stage: 3, p_decision: "confirmed" });
    m && /recorded this payment/i.test(m)
      ? ok("…and is then refused their own stage 3 — it needs a second pair of hands")
      : bad(`the recorder was able to confirm their own claim: ${m}`);

    const { error: e2 } = await officer2.c.rpc("confirm_offline_payment",
      { p_claim_id: walkIn, p_stage: 3, p_decision: "confirmed" });
    e2 ? bad(`a second Payment Officer could not close it: ${e2.message}`)
       : ok("a second Payment Officer closes it — the control is a second person, not a dead end");
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("H. A refusal has a way back, and a rejection is terminal");

{
  const rc3 = await seedCharge(4, 300000);

  const proof = await uploadProof(tenant.c, "returnable");
  const { data: id } = await tenant.c.rpc("submit_offline_payment_claim", {
    p_method: "bank_transfer", p_amount: 300000, p_paid_on: "2026-09-07",
    p_bank_account_id: bank.id, p_proof_path: proof,
    p_allocations: [{ purpose: "rent", rent_charge_id: rc3.id, amount: 300000 }],
  });
  made.claims.push(id);

  const m = await refused(auditor.c, "confirm_offline_payment",
    { p_claim_id: id, p_stage: 1, p_decision: "returned", p_reason: "short" });
  m && /10 characters/i.test(m)
    ? ok("a return without a usable reason is refused")
    : bad(`short reason should be refused, got: ${m}`);

  await auditor.c.rpc("confirm_offline_payment", {
    p_claim_id: id, p_stage: 1, p_decision: "returned",
    p_reason: "The slip is unreadable — please attach a clearer photograph of the teller receipt.",
  });
  const { data: c1 } = await svc.from("offline_payment_claims")
    .select("status, decision_reason").eq("id", id).single();
  c1.status === "returned_for_correction" && /clearer photograph/.test(c1.decision_reason)
    ? ok("a stage-1 return sends it back to the payer, with the reason attached")
    : bad(`expected returned_for_correction, got ${c1.status}`);

  const { data: mine } = await tenant.c.rpc("my_offline_payment_claims");
  const row = (mine ?? []).find((r) => r.claim_id === id);
  row?.decision_reason?.includes("clearer photograph")
    ? ok("the tenant is told exactly what to fix")
    : bad("the tenant cannot see why it came back");

  const newProof = await uploadProof(tenant.c, "corrected");
  const { error: corrErr } = await tenant.c.rpc("correct_offline_payment_claim", {
    p_claim_id: id, p_amount: 300000,
    p_allocations: [{ purpose: "rent", rent_charge_id: rc3.id, amount: 300000 }],
    p_proof_path: newProof, p_proof_filename: "clearer-slip.pdf",
  });
  corrErr ? bad(`the tenant could not correct their claim: ${corrErr.message}`)
          : ok("the tenant corrects it and it goes back up the chain");

  const { data: c2 } = await svc.from("offline_payment_claims")
    .select("status, decision_reason, proof_path").eq("id", id).single();
  c2.status === "submitted" && c2.decision_reason === null && c2.proof_path === newProof
    ? ok("it is moving again, with the new evidence and the old refusal cleared")
    : bad(`correction did not reset the claim: ${c2.status}`);

  const { data: chain } = await auditor.c.rpc("offline_claim_chain", { p_claim_id: id });
  (chain ?? []).some((s) => s.superseded)
    ? ok("the superseded round is still shown — decision 30's 'view the movement'")
    : bad("the retired round vanished from the trail");

  // Now refuse it outright.
  await auditor.c.rpc("confirm_offline_payment", {
    p_claim_id: id, p_stage: 1, p_decision: "rejected",
    p_reason: "No credit for this amount appears on the account for the date stated.",
  });
  const { data: c3 } = await svc.from("offline_payment_claims").select("status").eq("id", id).single();
  c3.status === "rejected" ? ok("a rejection is recorded on the claim")
                           : bad(`expected rejected, got ${c3.status}`);
  const m2 = await refused(exec.c, "confirm_offline_payment",
    { p_claim_id: id, p_stage: 2, p_decision: "confirmed" });
  m2 && /already refused/i.test(m2)
    ? ok("a rejected claim cannot be walked any further")
    : bad(`rejected claim should be terminal, got: ${m2}`);
  const { data: rcAfter } = await svc.from("rent_charges").select("amount_paid").eq("id", rc3.id).single();
  Number(rcAfter.amount_paid) === 0
    ? ok("a rejected claim moved no money at all")
    : bad("a rejected claim changed the demand's balance");
}

// ════════════════════════════════════════════════════════════════════════════
section("I. Grants — what anonymous and internal callers can reach");

{
  const anonClient = createClient(URL, ANON, { auth: { persistSession: false } });
  for (const fn of ["submit_offline_payment_claim", "confirm_offline_payment",
                    "offline_claim_queue", "my_offline_payment_claims",
                    "correct_offline_payment_claim", "offline_allocatable_charges"]) {
    const { error } = await anonClient.rpc(fn, {});
    error && !/does not exist/i.test(error.message) && /permission|denied|not find|schema/i.test(error.message)
      ? ok(`anon cannot call ${fn}`)
      : bad(`anon reached ${fn}: ${error?.message ?? "no error at all"}`);
  }
  const { error: pe } = await anonClient.rpc("post_offline_payment_claim",
    { p_claim_id: claimId, p_confirmed_by: officer.id });
  pe ? ok("anon cannot call the ledger poster")
     : bad("anon posted to the ledger");
}
{
  const { error } = await svc.rpc("post_offline_payment_claim",
    { p_claim_id: claimId, p_confirmed_by: officer.id });
  error ? ok("even the service role cannot call the ledger poster directly")
        : bad("the service role posted a collection with no chain behind it");
}
{
  const { error } = await svc.rpc("write_offline_claim_allocations",
    { p_claim_id: claimId, p_allocations: rentLine(1), p_amount: 1 });
  error ? ok("even the service role cannot rewrite a claim's breakdown directly")
        : bad("the service role rewrote a breakdown outside its two callers");
}
{
  // ⚠️ Against a claim that is NOT already confirmed. An update refused by RLS
  // affects zero rows and raises nothing (decision 38's own finding), so the
  // only honest test reads the state afterwards — and reading it on a row that
  // was ALREADY `confirmed` by section F cannot tell a refusal from a success.
  // The first draft did exactly that and reported a false red.
  const rcT = await seedCharge(6, 120000);
  const proof = await uploadProof(tenant.c, "tamper");
  const { data: tamperId } = await tenant.c.rpc("submit_offline_payment_claim", {
    p_method: "bank_transfer", p_amount: 120000, p_paid_on: "2026-09-08",
    p_bank_account_id: bank.id, p_proof_path: proof,
    p_allocations: [{ purpose: "rent", rent_charge_id: rcT.id, amount: 120000 }],
  });
  made.claims.push(tamperId);

  await tenant.c.from("offline_payment_claims")
    .update({ status: "confirmed", confirmed_amount: 120000 }).eq("id", tamperId);
  const { data: after } = await svc.from("offline_payment_claims")
    .select("status, posted_at").eq("id", tamperId).single();
  after.status === "submitted" && after.posted_at === null
    ? ok("a tenant cannot PATCH their claim to confirmed — there is no update policy at all")
    : bad(`a tenant PATCHed their own claim's status to ${after.status}`);

  const { data: pt } = await svc.from("rent_charges")
    .select("amount_paid").eq("id", rcT.id).single();
  Number(pt.amount_paid) === 0
    ? ok("…and forging the status moved no money, because posting is a function, not a column")
    : bad("a forged status moved money");
}
{
  // 0216's D6b lesson: test the INSERT, not only the UPDATE.
  const { error } = await tenant.c.from("offline_payment_claims").insert({
    org_id: orgId, reference: `FORGED-${stamp}`, recorded_by: tenant.id,
    method: "bank_transfer", claimed_amount: 1, paid_on: "2026-09-01",
    destination_bank_account_id: bank.id, proof_path: `${orgId}/x/y.pdf`,
    status: "confirmed",
  });
  error ? ok("a tenant cannot INSERT a claim directly, let alone a confirmed one")
        : bad("a tenant inserted a pre-confirmed claim straight into the table");
}
{
  const { error } = await tenant.c.from("offline_payment_confirmations").insert({
    org_id: orgId, claim_id: claimId, stage_order: 3, actor_id: tenant.id,
    actor_role: "finance_approver", amount: 1, decision: "confirmed",
  });
  error ? ok("a tenant cannot forge a confirmation row")
        : bad("a tenant forged a signature on the chain");
}


// ════════════════════════════════════════════════════════════════════════════
section("J. A payment in a foreign currency");

{
  const FX = "USD";
  // Enabling a currency is an administrator's act; the suite does it through
  // the same function an administrator would (service role passes the guard).
  await svc.rpc("ensure_currency_ledger_accounts", { p_org_id: orgId, p_currency: FX });

  // ⚠️ The five accounts an inbound FX collection can need. Before 0284 only
  // two of these existed, so a USD rent payment climbed all three desks and
  // then failed at the ledger with "no fee income account" — after three
  // signatures, which is the worst possible moment to find a config gap.
  const { data: accts } = await svc.from("ledger_accounts")
    .select("purpose").eq("org_id", orgId).eq("currency", FX).is("property_id", null);
  const have = new Set((accts ?? []).map((a) => a.purpose));
  const need = ["client_funds", "suspense", "landlord_payable", "tenant_deposit", "fee_income"];
  const missing = need.filter((p) => !have.has(p));
  missing.length === 0
    ? ok(`enabling ${FX} opens all five accounts an inbound collection needs`)
    : bad(`${FX} is missing: ${missing.join(", ")}`);

  // A USD client-funds bank account for the payer to name.
  const { data: fxLedger } = await svc.from("ledger_accounts").select("id")
    .eq("org_id", orgId).eq("currency", FX).eq("purpose", "client_funds")
    .is("property_id", null).maybeSingle();
  let { data: fxBank } = await svc.from("bank_accounts").select("id")
    .eq("org_id", orgId).eq("currency", FX).eq("purpose", "client_funds")
    .eq("active", true).maybeSingle();
  if (!fxBank) {
    const { data: made_, error } = await svc.from("bank_accounts").insert({
      org_id: orgId, label: `Client funds (${FX})`, purpose: "client_funds",
      bank_name: "Fidelity Bank", account_name: "Ora Egbunike & Associates",
      account_number_last4: "7781", currency: FX,
      ledger_account_id: fxLedger?.id ?? null, active: true,
    }).select("id").single();
    if (error) { bad(`could not open a ${FX} bank account: ${error.message}`); }
    fxBank = made_;
    made.fxBank = made_?.id ?? null;
  }

  if (fxBank) {
    const FXRENT = 4000;
    const { data: fxCharge } = await svc.from("rent_charges").insert({
      org_id: orgId, lease_id: lease.id, ...period(8),
      amount: FXRENT, currency: FX,
      management_fee_pct: FEE_PCT, management_fee_amount: 400,
      admin_fee_amount: 0, landlord_net_amount: 3600,
    }).select("id").single();
    if (fxCharge) made.charges.push(fxCharge.id);

    // The form filters the picker by the selected account's currency; prove the
    // source it filters ON reports the demand in its own currency.
    const { data: offered } = await tenant.c.rpc("offline_allocatable_charges");
    const fxRow = (offered ?? []).find((r) => r.charge_id === fxCharge?.id);
    fxRow?.currency === FX
      ? ok(`the ${FX} demand is offered in ${FX}, so the form can filter it correctly`)
      : bad(`the FX demand reported ${fxRow?.currency}`);
    (offered ?? []).every((r) => r.kind !== "service_charge" || r.currency === "NGN")
      ? ok("every service charge is still reported as naira")
      : bad("a service charge was offered in a foreign currency");

    const fxProof = await uploadProof(tenant.c, "fx");
    const { data: fxClaim, error: fxErr } = await tenant.c.rpc("submit_offline_payment_claim", {
      p_method: "bank_transfer", p_amount: FXRENT, p_paid_on: "2026-09-08",
      p_bank_account_id: fxBank.id, p_proof_path: fxProof,
      p_allocations: [{ purpose: "rent", rent_charge_id: fxCharge.id, amount: FXRENT }],
      p_currency: FX,
      p_payer_note: "Rent paid from abroad by SWIFT transfer.",
    });
    if (fxErr) { bad(`a ${FX} payment could not be recorded: ${fxErr.message}`); }
    else {
      made.claims.push(fxClaim);
      ok(`the tenant records a ${FX} bank transfer against a ${FX} demand`);

      // Currency has to be consistent end to end: an NGN demand cannot be paid
      // on a USD claim, and vice versa.
      const mixed = await refused(tenant.c, "submit_offline_payment_claim", {
        p_method: "bank_transfer", p_amount: 1000, p_paid_on: "2026-09-08",
        p_bank_account_id: fxBank.id, p_proof_path: fxProof,
        p_allocations: [{ purpose: "rent", rent_charge_id: charge.id, amount: 1000 }],
        p_currency: FX,
      });
      mixed && /is in NGN and this payment is in USD/i.test(mixed)
        ? ok("a naira demand cannot be settled on a foreign-currency payment")
        : bad(`cross-currency allocation should be refused, got: ${mixed}`);

      // The whole chain, in USD.
      await auditor.c.rpc("confirm_offline_payment",
        { p_claim_id: fxClaim, p_stage: 1, p_decision: "confirmed" });
      await exec.c.rpc("confirm_offline_payment",
        { p_claim_id: fxClaim, p_stage: 2, p_decision: "confirmed" });
      const { error: postErr } = await officer.c.rpc("confirm_offline_payment",
        { p_claim_id: fxClaim, p_stage: 3, p_decision: "confirmed" });
      postErr
        ? bad(`the ${FX} payment could not be posted: ${postErr.message}`)
        : ok(`the three desks confirm it and it posts in ${FX}`);

      const { data: fxRc } = await svc.from("rent_charges")
        .select("amount_paid, status").eq("id", fxCharge.id).single();
      Number(fxRc.amount_paid) === FXRENT && fxRc.status === "paid"
        ? ok(`the ${FX} demand is settled in full`)
        : bad(`FX demand did not settle: ${fxRc.amount_paid}/${fxRc.status}`);

      // The fee split, in the foreign currency's own accounts — the thing that
      // was impossible before 0284.
      const { data: fxAlloc } = await svc.from("offline_payment_allocations")
        .select("ledger_entry_id").eq("claim_id", fxClaim).limit(1).single();
      const { data: fxPost } = await svc.from("ledger_postings")
        .select("amount, memo, account_id").eq("entry_id", fxAlloc.ledger_entry_id);
      const { data: fxAccts } = await svc.from("ledger_accounts")
        .select("id, currency, purpose")
        .in("id", (fxPost ?? []).map((p) => p.account_id));
      (fxAccts ?? []).length > 0 && (fxAccts ?? []).every((a) => a.currency === FX)
        ? ok(`every posting landed in a ${FX} account — no cross-currency mixing`)
        : bad(`an FX collection posted into ${(fxAccts ?? []).map((a) => a.currency).join("/")}`);
      const fxFee = (fxPost ?? []).find((p) => /management and admin fee/i.test(p.memo ?? ""));
      fxFee && Math.abs(Number(fxFee.amount) + 400) < 0.01
        ? ok(`the fee came out at ${FX} 400 — the snapshotted 10%`)
        : bad(`FX fee posting wrong: ${fxFee?.amount}`);
    }

    // ⚠️ A service charge is a naira obligation (0123/decision 15). It is
    // refused in a foreign currency rather than silently posted into an FX fund
    // that does not exist.
    const { data: anySc } = await svc.from("service_charges")
      .select("id").eq("org_id", orgId).is("deleted_at", null)
      .gt("amount", 0).limit(1).maybeSingle();
    if (anySc) {
      const scFx = await refused(tenant.c, "submit_offline_payment_claim", {
        p_method: "bank_transfer", p_amount: 100, p_paid_on: "2026-09-08",
        p_bank_account_id: fxBank.id, p_proof_path: fxProof,
        p_allocations: [{ purpose: "service_charge", service_charge_id: anySc.id, amount: 100 }],
        p_currency: FX,
      });
      scFx && /billed in naira/i.test(scFx)
        ? ok("a service charge cannot be paid in a foreign currency, and the refusal says why")
        : bad(`FX service charge should be refused with usable words, got: ${scFx}`);
    } else {
      console.log("  \x1b[33mSKIP\x1b[0m no service charge to test the naira-only rule against");
    }
  }
}


// ════════════════════════════════════════════════════════════════════════════
section("K. Where to pay, and where it came from");

{
  // ⚠️ The account a payer is TOLD to pay into. Before 0286 the product held
  // only the last four, so it could not answer the one question somebody about
  // to make a transfer actually has.
  //
  // ⚠️ ON ITS OWN ACCOUNT, never OEA's real one.
  //
  // The first draft overwrote the live client-funds account's number and last
  // four and restored them in teardown. That is wrong twice: a crashed run
  // leaves a REAL bank account showing a fabricated number — which on this
  // screen is what a tenant is told to pay into — and worse, the next run then
  // CAPTURES the fabricated value as the thing to restore, so one interrupted
  // run poisons every run after it. Measured: OEA's account sat at last-four
  // "6789" instead of its actual "9039" across several runs, and the restore
  // faithfully put the wrong value back each time.
  //
  // 📌 A fixture that mutates production-shaped data and relies on its own
  // teardown to undo it has made cleanup a correctness requirement. Owning the
  // row instead removes the requirement.
  //
  // GBP because `bank_accounts_one_client_funds_per_currency_uidx` allows only
  // one ACTIVE client-funds account per currency, and NGN's is taken.
  await svc.rpc("ensure_currency_ledger_accounts", { p_org_id: orgId, p_currency: "GBP" });
  const { data: gbpLedger } = await svc.from("ledger_accounts").select("id")
    .eq("org_id", orgId).eq("currency", "GBP").eq("purpose", "client_funds")
    .is("property_id", null).maybeSingle();

  // ⚠️ Sweep first. `bank_accounts_one_client_funds_per_currency_uidx` allows one
  // ACTIVE client-funds account per currency, so a probe left behind by a run
  // that died mid-flight blocks every run after it — and the insert failing
  // silently is what turned that into three FAILs reading as product defects.
  await svc.from("bank_accounts").delete()
    .eq("org_id", orgId).like("label", "Probe collection %");

  const { data: probeBank, error: probeErr } = await svc.from("bank_accounts").insert({
    org_id: orgId, label: `Probe collection ${stamp}`, purpose: "client_funds",
    bank_name: "Fidelity Bank", account_name: "OEA Probe Collections",
    account_number_last4: "6789", published_account_number: "0123456789",
    currency: "GBP", ledger_account_id: gbpLedger?.id ?? null, active: true,
  }).select("id").single();
  // Said out loud rather than left to surface as "the payer cannot see where to
  // pay: undefined" three checks later.
  if (probeErr) bad(`fixture: could not open a probe collection account — ${probeErr.message}`);
  made.probeBank = probeBank?.id ?? null;

  const { data: shown } = await tenant.c.rpc("org_client_funds_accounts");
  const dest = (shown ?? []).find((a) => a.id === probeBank?.id);
  dest?.published_account_number === "0123456789"
    ? ok("a tenant is shown the full account number to transfer into")
    : bad(`the payer cannot see where to pay: ${dest?.published_account_number}`);
  dest?.account_name
    ? ok("…and the account NAME beside it, which is the anti-fraud control")
    : bad("the destination account has no name to check against");

  // The REAL account is never touched, so this is also an assertion that the
  // suite left it alone.
  const { data: realBank } = await svc.from("bank_accounts")
    .select("account_number_last4").eq("id", bank.id).single();
  realBank.account_number_last4 !== "6789"
    ? ok("the organisation's real account was not touched by this test")
    : bad("the suite overwrote a live bank account's identity");

  // Only collection accounts may carry one. A payout account with a publishable
  // number would be decision 17 undone.
  const { data: operating } = await svc.from("bank_accounts")
    .select("id").eq("org_id", orgId).neq("purpose", "client_funds").limit(1).maybeSingle();
  if (operating) {
    const { error } = await svc.from("bank_accounts")
      .update({ published_account_number: "0123456789" }).eq("id", operating.id);
    error
      ? ok("a non-collection account is refused a published number")
      : bad("a payout account accepted a published account number");
  } else {
    console.log("  \x1b[33mSKIP\x1b[0m no non-collection account to test the constraint against");
  }

  const { data: strangers } = await otherTenant.c.rpc("org_client_funds_accounts");
  (strangers ?? []).every((a) => a.id !== probeBank?.id)
    ? ok("a tenant in another organisation is not shown this org's account")
    : bad("an account number leaked across organisations");

  // ── Where the money came FROM ────────────────────────────────────────────
  const rentK = (await seedCharge(10, 150000)).id;
  const proofK = await uploadProof(tenant.c, "payer");
  const { data: claimK, error: errK } = await tenant.c.rpc("submit_offline_payment_claim", {
    p_method: "bank_transfer", p_amount: 150000, p_paid_on: "2026-09-09",
    p_bank_account_id: bank.id, p_proof_path: proofK,
    p_allocations: [{ purpose: "rent", rent_charge_id: rentK, amount: 150000 }],
    p_payer_bank_name: "Guaranty Trust Bank",
    p_payer_account_name: "ADAEZE O TENANT",
    p_payer_account_last4: "4417",
  });
  if (errK) {
    bad(`a payment naming its source account was refused: ${errK.message}`);
  } else {
    made.claims.push(claimK);
    const { data: c } = await svc.from("offline_payment_claims")
      .select("payer_bank_name, payer_account_name, payer_account_last4")
      .eq("id", claimK).single();
    c.payer_bank_name === "Guaranty Trust Bank" && c.payer_account_last4 === "4417"
      ? ok("the paying account's bank and last four are kept, for statement matching")
      : bad("the payer's account details were not stored");
    // The column is four characters wide by constraint; there is nowhere for a
    // full number to be, which is the point of storing it this way.
    (c.payer_account_last4 ?? "").length === 4
      ? ok("…and only four digits of the number exist anywhere on the row")
      : bad("more than the last four was stored");
  }

  // 0262's mistake — a number in the name box — refused rather than displayed.
  const badName = await refused(tenant.c, "submit_offline_payment_claim", {
    p_method: "bank_transfer", p_amount: 1000, p_paid_on: "2026-09-09",
    p_bank_account_id: bank.id, p_proof_path: proofK,
    p_allocations: [{ purpose: "rent", rent_charge_id: rentK, amount: 1000 }],
    p_payer_account_name: "0123456789",
  });
  badName && /account number rather than an account name/i.test(badName)
    ? ok("an account NUMBER typed into the account-NAME box is refused (0262)")
    : bad(`a number in the name box should be refused, got: ${badName}`);

  const badLast4 = await refused(tenant.c, "submit_offline_payment_claim", {
    p_method: "bank_transfer", p_amount: 1000, p_paid_on: "2026-09-09",
    p_bank_account_id: bank.id, p_proof_path: proofK,
    p_allocations: [{ purpose: "rent", rent_charge_id: rentK, amount: 1000 }],
    p_payer_account_last4: "0123456789",
  });
  badLast4 && /four digits/i.test(badLast4)
    ? ok("a full number pasted into the last-four box is refused")
    : bad(`full number in last4 should be refused, got: ${badLast4}`);
}

// ── Teardown ────────────────────────────────────────────────────────────────
section("Teardown");
for (const id of made.claims) {
  await svc.from("offline_payment_confirmations").delete().eq("claim_id", id);
  await svc.from("offline_payment_allocations").delete().eq("claim_id", id);
}
const { data: spent } = await svc.from("offline_payment_allocations")
  .select("intent_id").in("claim_id", made.claims);
await svc.from("offline_payment_claims").delete().in("id", made.claims);
for (const p of made.objects) await svc.storage.from("payment-proofs").remove([p]);
if (made.fxBank) await svc.from("bank_accounts").delete().eq("id", made.fxBank);
if (made.probeBank) {
  const r = await svc.from("bank_accounts").delete().eq("id", made.probeBank).select("id");
  // Said out loud. A cleanup that fails silently is how a leftover probe
  // account came to block three checks on the following run and read as a
  // product defect — the start-of-run sweep recovers from it either way, but
  // nobody should have to work that out from the symptom.
  if (r.error) console.log(`  note: probe collection account kept — ${r.error.message}`);
}

// ⚠️ The fixture DEMANDS go too, posted ones included — and that is a change of
// mind worth recording. They were originally left in place on the reasoning
// that the ledger is append-only (0256), which is true of the POSTINGS and not
// of the demand rows. Leaving them meant `oea.tenant@`'s real My Rent screen
// accumulated rent demands dated 2219-2472, and the board saw them: "1 Oct 2472
// – 30 Sept 2473 · ₦500,000 · Paid", on a demo account, in a screenshot.
//
// The ledger entries STAY — they are real postings and deleting one to tidy a
// test is the fault verify-reconciliation recorded. `payment_intents.rent_charge_id`
// is `on delete set null` (0092), so the entry keeps its intent and stays
// balanced; only the fixture demand goes.
if (made.charges.length > 0) {
  await svc.from("payment_intents").update({ rent_charge_id: null }).in("rent_charge_id", made.charges);
  await svc.from("rent_charges").delete().in("id", made.charges);
}

if (made.staked) {
  // A fixture that holds a role is not litter, it is an access grant nobody
  // decided to make (decision 38). The same is true of a property stake.
  await svc.from("property_stakeholders").delete()
    .eq("user_id", made.staked.user_id).eq("property_id", made.staked.property_id);
}
console.log(`  removed ${made.claims.length} claim(s) and ${made.objects.length} proof object(s)`);
console.log("  ledger ENTRIES from this run stay — they are real postings, and deleting one to");
console.log("  tidy a test is the fixture fault verify-reconciliation recorded. The fixture rent");
console.log("  DEMANDS are removed, so they stop appearing on a real tenant's My Rent screen.");

console.log("");
if (failures === 0) {
  console.log("\x1b[32mALL CHECKS PASSED — an off-platform payment is recorded with compulsory proof, moves no money until the auditor, the executive and the Payment Officer have each signed, and then posts through record_collection with the fee split intact.\x1b[0m");
} else {
  console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
}
process.exit(failures === 0 ? 0 : 1);
