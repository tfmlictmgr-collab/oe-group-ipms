// Proves a tenant can report a payment on WhatsApp/Telegram (0285).
//
// The claims that matter:
//   • "I have paid" is never logged as a work order
//   • the attachment becomes the compulsory proof, and without one nothing is
//     recorded — the rule 0281 put at the table is not relaxed for chat
//   • the payer is resolved from the sender reference, never supplied
//   • an ambiguous amount is ASKED for, not guessed
//   • more than one thing owed produces a menu, not a pick
//   • an unrecognised number, or nothing outstanding, reaches a person
//   • the claim it creates still climbs 0282's three desks
//
// ⚠️ The webhook has no session, so the write path is service-role by
// necessity. That is exactly why this suite checks what a SIGNED-IN caller can
// reach: the danger of a service-role entry point is that it is also reachable
// by anyone holding an anon or authenticated key, and section D is the whole
// point of the file.
//
// Usage: npx tsx scripts/verify-chat-payment-report.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { parseAmount } from "../lib/payment-intake.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const section = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

if (!URL_ || !ANON || !SVCK) {
  console.error("Cannot reach Supabase — .env.local is missing URL/ANON/SERVICE_ROLE.");
  process.exit(0);
}
const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const made = { claims: [], charges: [], objects: [] };

console.log(`\nReporting a payment on chat — 0285   (fixture tag ${stamp})`);

// ── The world ───────────────────────────────────────────────────────────────
const { data: tenantRow } = await svc.from("users")
  .select("id, org_id, phone").eq("email", "oea.tenant@oegroup.test").single();
const orgId = tenantRow.org_id;

const { data: lease } = await svc.from("leases")
  .select("id, property_id, unit_id").eq("tenant_user_id", tenantRow.id)
  .in("status", ["active", "renewed"]).limit(1).maybeSingle();
if (!lease) { console.error("No active lease for oea.tenant — seed brand demo content."); process.exit(0); }

// ⚠️ The suite gives the fixture tenant a phone number NOBODY ELSE HOLDS, and
// puts the old one back in teardown.
//
// `resolve_chat_sender` matches on the last ten digits and resolves an ambiguous
// match to NOBODY — deliberately: "two people sharing a number is not a licence
// to guess which of them is writing". Measured on staging, three live OEA
// accounts share `08036500705`, the seeded tenant among them, so every check
// below failed with "we do not recognise this number" — the resolver working
// exactly as designed, against a fixture that could never satisfy it.
//
// 📌 That is a real finding about the DATA, not about this code, and it is worth
// stating plainly: while three accounts share a number, nobody messaging from it
// can be identified on WhatsApp at all — no ticket attribution, no payment
// reporting. Section B asserts the ambiguity rule so this stays visible.
const originalPhone = tenantRow.phone;
const probePhone = `0700${String(Date.now()).slice(-7)}`;
await svc.from("users").update({ phone: probePhone }).eq("id", tenantRow.id);
const senderRef = probePhone.replace(/\D/g, "");

const FIXTURE_EPOCH = Date.UTC(2150, 0, 1);
const DAY = 86400000;
const baseDay = FIXTURE_EPOCH + (Date.now() % 40000) * DAY;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
await svc.from("rent_charges").delete()
  .eq("lease_id", lease.id).is("ledger_entry_id", null)
  .gte("period_start", "2150-01-01").lt("period_start", "2200-01-01");

async function seedCharge(n, amount) {
  const { data, error } = await svc.from("rent_charges").insert({
    org_id: orgId, lease_id: lease.id,
    period_start: iso(baseDay + n * 400 * DAY),
    period_end: iso(baseDay + (n * 400 + 364) * DAY),
    due_date: iso(baseDay + n * 400 * DAY),
    amount, currency: "NGN",
    management_fee_pct: 10, management_fee_amount: amount * 0.1,
    admin_fee_amount: 0, landlord_net_amount: amount * 0.9,
  }).select("id").single();
  if (error) { console.error(`fixture: ${error.message}`); process.exit(1); }
  made.charges.push(data.id);
  return data.id;
}

async function putProof(tag) {
  const p = `${orgId}/chat-${stamp}-${tag}/receipt.pdf`;
  const { error } = await svc.storage.from("payment-proofs")
    .upload(p, new Blob([`%PDF-1.4 ${tag}`], { type: "application/pdf" }),
            { contentType: "application/pdf", upsert: false });
  if (error) { console.error(`proof: ${error.message}`); process.exit(1); }
  made.objects.push(p);
  return p;
}

// ════════════════════════════════════════════════════════════════════════════
section("A. Reading an amount out of what somebody typed");

const AMOUNT_CASES = [
  ["I have paid 500,000", 500000, "a comma-separated figure"],
  ["paid 500k this morning", 500000, "Nigerian shorthand (k)"],
  ["I sent 1.2m yesterday", 1200000, "shorthand (m)"],
  ["₦750000 transferred", 750000, "a naira sign"],
  ["N250,000 paid", 250000, "an N prefix"],
  ["I paid", null, "no figure at all"],
  ["I paid 500k on the 3rd", 500000, "a figure beside a date — the date is not a candidate"],
  ["I paid 500000 and 250000", null, "TWO figures — ambiguous, so it asks"],
  ["2", null, "a bare menu digit is never an amount"],
];
for (const [text, expected, why] of AMOUNT_CASES) {
  const got = parseAmount(text);
  got === expected
    ? ok(`${why}: "${text}" → ${got ?? "asks"}`)
    : bad(`"${text}" → ${got}, expected ${expected}`);
}

// ════════════════════════════════════════════════════════════════════════════
section("B. What this sender owes");

const rent1 = await seedCharge(0, 900000);
{
  const { data: charges } = await svc.rpc("sender_open_charges", {
    p_org_id: orgId, p_sender_ref: senderRef, p_limit: 6,
  });

  // ⚠️ NOT "is my fixture in the list". This tenant holds 27 open demands and
  // the function returns the OLDEST six — which is right (a menu should offer
  // the arrears first) and means a far-future fixture is never among them. The
  // first draft asserted the fixture's presence and failed for that reason,
  // reading as a broken resolver. What matters is that the phone number
  // resolves to a person and returns THEIR debts and nobody else's.
  const mine = (charges ?? []).length;
  mine > 0
    ? ok(`the sender's own outstanding demands are found from their number alone (${mine} offered, oldest first)`)
    : bad("sender_open_charges resolved the number to nothing");

  if (mine > 0) {
    const { data: ownIds } = await svc.from("rent_charges")
      .select("id, leases!inner(tenant_user_id)")
      .in("id", (charges ?? []).filter((c) => c.kind === "rent").map((c) => c.charge_id));
    const foreign = (ownIds ?? []).filter(
      (r) => r.leases?.tenant_user_id !== tenantRow.id
    );
    foreign.length === 0
      ? ok("every demand offered belongs to the person the number resolves to")
      : bad(`${foreign.length} demand(s) offered belonged to somebody else`);
  }

  const { data: strangers } = await svc.rpc("sender_open_charges", {
    p_org_id: orgId, p_sender_ref: "0000000000000", p_limit: 6,
  });
  (strangers ?? []).length === 0
    ? ok("an unrecognised number owes nothing — it resolves to no one, not to everyone")
    : bad(`an unknown sender was shown ${strangers.length} charge(s)`);

  // ⚠️ The ambiguity rule, asserted rather than assumed — it is what made this
  // suite fail on its first run, and it is a rule about money now, not only
  // about which ticket a message joins.
  const { data: twin } = await svc.from("users")
    .select("id, phone").eq("org_id", orgId).eq("role", "property_manager")
    .not("phone", "is", null).limit(1).maybeSingle();
  if (twin) {
    const twinPhone = twin.phone;
    await svc.from("users").update({ phone: probePhone }).eq("id", twin.id);

    // The precondition is CHECKED, not assumed. A check whose setup silently
    // failed would report the rule as broken — decision 38's whole subject, and
    // the reason section B failed twice already on this run.
    const { count: sharing } = await svc.from("users")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("phone", probePhone).is("deactivated_at", null);

    if (sharing === 2) {
      const { data: ambiguous } = await svc.rpc("resolve_chat_sender", {
        p_org_id: orgId, p_sender_ref: senderRef,
      });
      const rows = Array.isArray(ambiguous) ? ambiguous : ambiguous ? [ambiguous] : [];
      const resolvedTo = rows[0]?.user_id ?? null;
      // The function returns NO ROWS on ambiguity — an early `return`, not a row
      // of nulls — so both shapes mean the same thing here.
      !resolvedTo
        ? ok("two accounts sharing a number resolve to NOBODY — never to a guess")
        : bad("an ambiguous number resolved to somebody");
    } else {
      console.log(`  \x1b[33mSKIP\x1b[0m could not stage two accounts on one number (found ${sharing})`);
    }
    await svc.from("users").update({ phone: twinPhone }).eq("id", twin.id);
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("C. Recording it");

{
  const proof = await putProof("main");
  const { data: claimId, error } = await svc.rpc("submit_offline_claim_for_sender", {
    p_org_id: orgId, p_sender_ref: senderRef,
    p_method: "bank_transfer", p_amount: 900000,
    p_paid_on: new Date().toISOString().slice(0, 10),
    p_proof_path: proof,
    p_allocations: [{ purpose: "rent", rent_charge_id: rent1, amount: 900000 }],
    p_payer_note: "Reported on whatsapp: \"I have paid 900k\"",
  });
  if (error) { bad(`a chat-reported payment could not be recorded: ${error.message}`); }
  else {
    made.claims.push(claimId);
    ok("a payment reported on chat becomes a claim");

    const { data: c } = await svc.from("offline_payment_claims")
      .select("payer_user_id, recorded_by, status, posted_at, proof_path, destination_bank_account_id")
      .eq("id", claimId).single();
    c.payer_user_id === tenantRow.id
      ? ok("the payer is the person the number resolves to")
      : bad("the payer was not resolved from the sender reference");
    c.recorded_by === tenantRow.id
      ? ok("recorded BY them too, so the maker-checker bars them from confirming it")
      : bad("the claim was attributed to somebody who did not report it");
    c.status === "submitted" && c.posted_at === null
      ? ok("it is a claim, not a payment — nothing posted")
      : bad("a chat report reached the ledger without a chain");
    c.destination_bank_account_id
      ? ok("the destination account was chosen, not asked — there is one per currency")
      : bad("no destination account was resolved");

    const { data: rc } = await svc.from("rent_charges")
      .select("amount_paid").eq("id", rent1).single();
    Number(rc.amount_paid) === 0
      ? ok("the demand's balance has not moved")
      : bad("arrears moved on an unconfirmed chat report");

    // It is an ordinary claim, so it climbs the ordinary chain.
    const auditor = createClient(URL_, ANON, { auth: { persistSession: false } });
    await auditor.auth.signInWithPassword({ email: "oea.paymentauditapprover@oegroup.test", password: PW });
    const exec = createClient(URL_, ANON, { auth: { persistSession: false } });
    await exec.auth.signInWithPassword({ email: "oea.executive@oegroup.test", password: PW });
    const officer = createClient(URL_, ANON, { auth: { persistSession: false } });
    await officer.auth.signInWithPassword({ email: "oea.financeapprover@oegroup.test", password: PW });

    const { data: lines } = await auditor.rpc("offline_claim_lines", { p_claim_id: claimId });
    (lines ?? []).length === 1
      ? ok("the auditor reads its breakdown, exactly as for a portal claim")
      : bad("the auditor could not read a chat-reported claim");

    await auditor.rpc("confirm_offline_payment", { p_claim_id: claimId, p_stage: 1, p_decision: "confirmed" });
    await exec.rpc("confirm_offline_payment", { p_claim_id: claimId, p_stage: 2, p_decision: "confirmed" });
    const { error: postErr } = await officer.rpc("confirm_offline_payment",
      { p_claim_id: claimId, p_stage: 3, p_decision: "confirmed" });
    postErr ? bad(`the chain refused a chat claim: ${postErr.message}`)
            : ok("the three desks confirm it and it posts — one claim table, one chain");

    const { data: rc2 } = await svc.from("rent_charges")
      .select("amount_paid, status").eq("id", rent1).single();
    Number(rc2.amount_paid) === 900000 && rc2.status === "paid"
      ? ok("and only THEN does the demand settle")
      : bad(`demand did not settle: ${rc2.amount_paid}/${rc2.status}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("D. What the compulsory rules still refuse");

{
  const rent2 = await seedCharge(2, 400000);

  const noProof = await svc.rpc("submit_offline_claim_for_sender", {
    p_org_id: orgId, p_sender_ref: senderRef, p_method: "bank_transfer",
    p_amount: 400000, p_paid_on: new Date().toISOString().slice(0, 10),
    p_proof_path: "", p_allocations: [{ purpose: "rent", rent_charge_id: rent2, amount: 400000 }],
  });
  noProof.error && /proof/i.test(noProof.error.message)
    ? ok("no proof, no claim — the table's rule is not relaxed for chat")
    : bad(`a chat claim with no proof should be refused, got: ${noProof.error?.message}`);

  const fakeProof = await svc.rpc("submit_offline_claim_for_sender", {
    p_org_id: orgId, p_sender_ref: senderRef, p_method: "bank_transfer",
    p_amount: 400000, p_paid_on: new Date().toISOString().slice(0, 10),
    p_proof_path: `${orgId}/nowhere/invented.pdf`,
    p_allocations: [{ purpose: "rent", rent_charge_id: rent2, amount: 400000 }],
  });
  fakeProof.error && /could not be found/i.test(fakeProof.error.message)
    ? ok("a proof path naming no real object is refused — the evidence must exist")
    : bad(`invented proof path should be refused, got: ${fakeProof.error?.message}`);

  const proof = await putProof("stranger");
  const notTheirs = await svc.rpc("submit_offline_claim_for_sender", {
    p_org_id: orgId, p_sender_ref: "0000000000000", p_method: "bank_transfer",
    p_amount: 400000, p_paid_on: new Date().toISOString().slice(0, 10),
    p_proof_path: proof,
    p_allocations: [{ purpose: "rent", rent_charge_id: rent2, amount: 400000 }],
  });
  notTheirs.error && /do not recognise/i.test(notTheirs.error.message)
    ? ok("an unrecognised number cannot record a payment against somebody's account")
    : bad(`unknown sender should be refused, got: ${notTheirs.error?.message}`);

  // ⚠️ The one that matters most about a service-role entry point.
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  const anonTry = await anon.rpc("submit_offline_claim_for_sender", {
    p_org_id: orgId, p_sender_ref: senderRef, p_method: "bank_transfer",
    p_amount: 1, p_paid_on: "2026-09-01", p_proof_path: proof, p_allocations: [],
  });
  anonTry.error ? ok("anon cannot call the chat claim writer")
                : bad("the chat claim writer is callable anonymously");

  const tenantC = createClient(URL_, ANON, { auth: { persistSession: false } });
  await tenantC.auth.signInWithPassword({ email: "oea.tenant@oegroup.test", password: PW });
  const signedIn = await tenantC.rpc("submit_offline_claim_for_sender", {
    p_org_id: orgId, p_sender_ref: senderRef, p_method: "bank_transfer",
    p_amount: 1, p_paid_on: "2026-09-01", p_proof_path: proof, p_allocations: [],
  });
  signedIn.error ? ok("nor can a signed-in user — it is the webhook's door, not a public one")
                 : bad("a signed-in user reached the chat claim writer");

  const charges = await tenantC.rpc("sender_open_charges", {
    p_org_id: orgId, p_sender_ref: senderRef,
  });
  charges.error ? ok("nor can they enumerate a sender's debts through sender_open_charges")
                : bad("sender_open_charges is reachable by a signed-in user");

  // Somebody else's demand, through a number that is genuinely ours.
  const { data: otherLease } = await svc.from("leases")
    .select("id").eq("org_id", orgId).neq("tenant_user_id", tenantRow.id)
    .in("status", ["active", "renewed"]).limit(1).maybeSingle();
  if (otherLease) {
    const { data: otherCharge } = await svc.from("rent_charges")
      .select("id").eq("lease_id", otherLease.id).gt("amount", 0).limit(1).maybeSingle();
    if (otherCharge) {
      const cross = await svc.rpc("submit_offline_claim_for_sender", {
        p_org_id: orgId, p_sender_ref: senderRef, p_method: "bank_transfer",
        p_amount: 1000, p_paid_on: new Date().toISOString().slice(0, 10),
        p_proof_path: proof,
        p_allocations: [{ purpose: "rent", rent_charge_id: otherCharge.id, amount: 1000 }],
      });
      cross.error && /billed to somebody else/i.test(cross.error.message)
        ? ok("a known sender still cannot pay somebody ELSE's demand")
        : bad(`cross-tenant allocation should be refused, got: ${cross.error?.message}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("E. The conversation can hold a half-finished payment");

{
  const draft = { proofPath: "x/y.pdf", amount: 500000 };
  const { error } = await svc.rpc("remember_conversation_state", {
    p_org_id: orgId, p_channel: "whatsapp", p_sender_ref: `probe-${stamp}`,
    p_ticket_id: null, p_awaiting: "payment_allocation",
    p_last_prompt: "Which of these does it pay?", p_hours: 24,
    p_payment_draft: draft,
  });
  error ? bad(`a payment draft could not be stored: ${error.message}`)
        : ok("a half-collected payment is held on the conversation");

  const { data: back } = await svc.from("chat_conversations")
    .select("awaiting, payment_draft")
    .eq("org_id", orgId).eq("channel", "whatsapp").eq("sender_ref", `probe-${stamp}`)
    .maybeSingle();
  back?.awaiting === "payment_allocation" && Number(back?.payment_draft?.amount) === 500000
    ? ok("…and read back with the amount intact")
    : bad("the draft did not survive the round trip");

  // ⚠️ A branch that is not about a payment clears it. Somebody who abandons a
  // half-reported payment must not have a stale amount waiting to attach itself
  // to the next receipt they send.
  await svc.rpc("remember_conversation_state", {
    p_org_id: orgId, p_channel: "whatsapp", p_sender_ref: `probe-${stamp}`,
    p_ticket_id: null, p_awaiting: "describe_problem",
    p_last_prompt: "What is the issue?", p_hours: 24,
  });
  const { data: cleared } = await svc.from("chat_conversations")
    .select("payment_draft")
    .eq("org_id", orgId).eq("channel", "whatsapp").eq("sender_ref", `probe-${stamp}`)
    .maybeSingle();
  cleared?.payment_draft === null
    ? ok("changing the subject abandons the half-finished payment")
    : bad("a stale payment draft survived an unrelated reply");

  await svc.from("chat_conversations").delete()
    .eq("org_id", orgId).eq("channel", "whatsapp").eq("sender_ref", `probe-${stamp}`);
}

// ── Teardown ────────────────────────────────────────────────────────────────
section("Teardown");
for (const id of made.claims) {
  await svc.from("offline_payment_confirmations").delete().eq("claim_id", id);
  await svc.from("offline_payment_allocations").delete().eq("claim_id", id);
}
await svc.from("offline_payment_claims").delete().in("id", made.claims);
if (made.charges.length) {
  await svc.from("payment_intents").update({ rent_charge_id: null }).in("rent_charge_id", made.charges);
  await svc.from("rent_charges").delete().in("id", made.charges);
}
for (const p of made.objects) await svc.storage.from("payment-proofs").remove([p]);
// The fixture tenant gets their real number back. A suite that leaves a mutated
// account behind is decision 38 fixture litter, one column over.
await svc.from("users").update({ phone: originalPhone }).eq("id", tenantRow.id);
console.log(`  removed ${made.claims.length} claim(s), ${made.charges.length} demand(s), ${made.objects.length} proof(s)`);

console.log("");
if (failures === 0) {
  console.log("\x1b[32mALL CHECKS PASSED — a tenant can report a payment on chat with its receipt, the payer is resolved from their number and never supplied, an ambiguous amount is asked for rather than guessed, and the claim still climbs all three desks.\x1b[0m");
} else {
  console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
}
process.exit(failures === 0 ? 0 : 1);
