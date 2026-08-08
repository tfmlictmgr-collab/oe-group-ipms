// Money going OUT. The claims that matter:
//   • the B4 gate is enforced by the DATABASE — unverified, unscored or
//     unapproved payments cannot become a remittance at all
//   • an instruction can be claimed for sending exactly ONCE, even concurrently
//   • fees are deducted from rent and land in fee income; the vendor gets the
//     full invoice
//   • the ledger stays balanced, and we cannot pay out more than we hold
//   • a sent remittance cannot be restated or walked back to be sent again
//   • an `unknown` outcome stays unknown — nothing auto-retries it
//
// Usage: npx tsx scripts/verify-remittance.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

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
const made = { remittances: [], entries: [], recipients: [], payments: [], intents: [] };

const { data: fin } = await svc.from("users").select("id, org_id")
  .eq("email", "oe-group-foundation-poc.financeapprover@oegroup.test").single();
const orgId = fin.org_id;

// ⚠️ TWO people, deliberately. Since 0142 the approver of a payment may not
// also release it, and only a finance approver may release anything — so a
// fixture where one account did both no longer models a payment that can
// legally be sent. The administrator approves; finance disburses. That is the
// real workflow, and the suite now has to walk it to get a single naira out.
const { data: adminUser } = await svc.from("users").select("id")
  .eq("org_id", orgId).eq("role", "admin").is("deactivated_at", null).limit(1).single();
const { data: execUser } = await svc.from("users").select("id")
  .eq("org_id", orgId).eq("role", "executive").is("deactivated_at", null).limit(1).maybeSingle();
await svc.rpc("ensure_default_ledger_accounts", { p_org_id: orgId });

const { data: bankAcctId } = await svc.rpc("collection_bank_account", { p_org_id: orgId });
const held = async () => {
  const { data } = await svc.from("ledger_account_balances")
    .select("natural_balance").eq("account_id", bankAcctId).single();
  return Number(data.natural_balance);
};
const balanceOf = async (purpose) => {
  const { data: acct } = await svc.from("ledger_accounts").select("id")
    .eq("org_id", orgId).eq("purpose", purpose).eq("active", true)
    .order("created_at").limit(1).single();
  const { data } = await svc.from("ledger_account_balances")
    .select("natural_balance").eq("account_id", acct.id).single();
  return Number(data.natural_balance);
};

console.log("Remittance — money going out\n");

// ── Fixtures ───────────────────────────────────────────────────────────────
const { data: vendor } = await svc.from("vendors").select("id")
  .eq("org_id", orgId).limit(1).single();
const { data: landlord } = await svc.from("users").select("id")
  .eq("email", "oe-group-foundation-poc.propertyowner@oegroup.test").single();

// One ACTIVE recipient per vendor is enforced by payout_recipients_vendor_uidx,
// so a previous run that died before cleanup blocks this one. Clear the fixture's
// own rows first rather than assuming a clean database.
{
  const { data: stale } = await svc.from("payout_recipients")
    .select("id").like("display_name", "Test % Payouts");
  const ids = (stale ?? []).map((r) => r.id);
  if (ids.length > 0) {
    await svc.from("remittances").delete().in("recipient_id", ids);
    await svc.from("payout_recipients").delete().in("id", ids);
  }
}

const { data: vRec } = await svc.from("payout_recipients").insert({
  org_id: orgId, party: "vendor", vendor_id: vendor.id,
  display_name: "Test Vendor Payouts", bank_name: "Test Bank",
  account_number_last4: "0001", recipient_code: `RCP_TEST_${stamp}_V`,
  verified_at: new Date().toISOString(), created_by: fin.id,
}).select("id").single();
const { data: lRec } = await svc.from("payout_recipients").insert({
  org_id: orgId, party: "landlord", user_id: landlord.id,
  display_name: "Test Landlord Payouts", bank_name: "Test Bank",
  account_number_last4: "0002", recipient_code: `RCP_TEST_${stamp}_L`,
  verified_at: new Date().toISOString(), created_by: fin.id,
}).select("id").single();
made.recipients.push(vRec.id, lRec.id);

// Fund the service-charge account before anything is committed against it.
//
// Recognising a vendor payable DEBITS the service charge fund (0042): vendor
// costs are met from what was collected for the property. On an empty fund the
// overpayment guard correctly refuses — "account 2000 would be overpaid" — and
// this suite was reading that refusal as a broken gate rather than as the
// control doing its job. A test that starts from an impossible state proves
// nothing about the possible one.
const { data: seedEntry } = await svc.from("ledger_entries").insert({
  org_id: orgId, entry_date: new Date().toISOString().slice(0, 10),
  description: `Fixture funding ${stamp}`, source: "opening_balance",
  created_by: fin.id,
}).select("id").single();
made.entries.push(seedEntry.id);
{
  const { data: fundAcct } = await svc.rpc("canonical_ledger_account",
    { p_org_id: orgId, p_purpose: "service_charge_fund" });
  const { error } = await svc.from("ledger_postings").insert([
    { org_id: orgId, entry_id: seedEntry.id, account_id: bankAcctId, amount: 2_000_000,
      memo: "fixture: funds collected" },
    { org_id: orgId, entry_id: seedEntry.id, account_id: fundAcct, amount: -2_000_000,
      memo: "fixture: held for the service charge fund" },
  ]);
  if (error) { bad(`could not fund the fixture — ${error.message}`); process.exit(1); }
}

async function newPayment(status, opts = {}) {
  const { data } = await svc.from("payments").insert({
    org_id: orgId, vendor_id: vendor.id, amount: 180000, status,
    invoice_reference: `INV-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
    service_verified_at: opts.verified ? new Date().toISOString() : null,
    service_verified_by: opts.verified ? fin.id : null,
    performance_validated: opts.scored ?? false,
    approved_at: opts.approved ? new Date().toISOString() : null,
    // The ADMINISTRATOR approves (0142) — approving and releasing are now two
    // pairs of hands, so a payment approved by `fin` is one `fin` can never send.
    approved_by: opts.approved ? adminUser.id : null,
  }).select("id").single();
  made.payments.push(data.id);
  return data.id;
}

console.log("A. The B4 gate refuses everything that has not passed it");
{
  const cases = [
    ["not verified", await newPayment("approved", { scored: true, approved: true })],
    ["failed the performance check", await newPayment("approved", { verified: true, approved: true })],
    ["not approved", await newPayment("verified", { verified: true, scored: true })],
  ];
  for (const [label, id] of cases) {
    const { error } = await svc.rpc("create_vendor_remittance", {
      p_payment_id: id, p_reference: `REM-${stamp}-X`, p_executed_by: fin.id,
    });
    error ? ok(`${label}: refused (${error.message.slice(0, 46)})`)
          : bad(`${label}: A REMITTANCE WAS CREATED`);
  }
}

console.log("\nB. A fully gated payment remits, and the vendor gets the invoice in full");
const heldBefore = await held();
let vendorRemId;
{
  const payId = await newPayment("approved", { verified: true, scored: true, approved: true });
  const { data, error } = await svc.rpc("create_vendor_remittance", {
    p_payment_id: payId, p_reference: `REM-${stamp}-V`, p_executed_by: fin.id,
  });
  if (error) { bad(`gated payment refused — ${error.message}`); }
  else {
    vendorRemId = data;
    made.remittances.push(data);
    const { data: r } = await svc.from("remittances")
      .select("status, gross_amount, net_amount, management_fee, created_by, approved_by").eq("id", data).single();
    r.status === "queued" ? ok("created as queued — nothing sent yet") : bad(`status ${r.status}`);
    Number(r.net_amount) === 180000 && Number(r.management_fee) === 0
      ? ok("vendor receives the full ₦180,000 — no fee taken from an invoice")
      : bad(`net ${r.net_amount}, fee ${r.management_fee}`);
    // Was NULL on every row in production before 0142 — the one action that
    // moves real money was the one with no attributable actor.
    r.created_by === fin.id
      ? ok("the person who released the money is recorded (created_by)")
      : bad(`created_by is ${r.created_by ?? "NULL"} — the executor was not recorded`);
    r.approved_by !== r.created_by
      ? ok("and is a different person from the approver")
      : bad("approver and executor are the same person");
  }
}

console.log("\nB2. Disbursement is finance's, and never the approver's (0142)");
{
  // An administrator may approve beneath their threshold and configure it.
  // Releasing the funds is not theirs — that is the whole of decision 9's
  // "oversight authorises; finance disburses".
  const payId = await newPayment("approved", { verified: true, scored: true, approved: true });
  const { error: adminErr } = await svc.rpc("create_vendor_remittance", {
    p_payment_id: payId, p_reference: `REM-${stamp}-ADM`, p_executed_by: adminUser.id,
  });
  adminErr
    ? ok(`an administrator cannot send a payment (${adminErr.message.slice(0, 52)})`)
    : bad("AN ADMINISTRATOR RELEASED MONEY");

  if (execUser) {
    const { error: execErr } = await svc.rpc("create_vendor_remittance", {
      p_payment_id: payId, p_reference: `REM-${stamp}-EXE`, p_executed_by: execUser.id,
    });
    execErr
      ? ok("nor an executive — oversight authorises, it does not disburse")
      : bad("AN EXECUTIVE RELEASED MONEY");
  }

  // The control that actually stops one person paying themselves out: even a
  // finance approver is refused on a payment they approved.
  const selfPayId = await newPayment("approved", { verified: true, scored: true });
  await svc.from("payments")
    .update({ approved_at: new Date().toISOString(), approved_by: fin.id, status: "approved" })
    .eq("id", selfPayId);
  const { error: selfErr } = await svc.rpc("create_vendor_remittance", {
    p_payment_id: selfPayId, p_reference: `REM-${stamp}-SELF`, p_executed_by: fin.id,
  });
  selfErr && /cannot also send it/.test(selfErr.message)
    ? ok("the approver cannot also release it, even holding finance — maker-checker")
    : bad(`SELF-APPROVED PAYMENT WAS RELEASABLE BY ITS OWN APPROVER (${selfErr?.message ?? "no error"})`);

  // A deactivated finance approver is not a disburser either.
  await svc.from("users").update({ deactivated_at: new Date().toISOString() }).eq("id", fin.id);
  const { error: deadErr } = await svc.rpc("create_vendor_remittance", {
    p_payment_id: payId, p_reference: `REM-${stamp}-DEAD`, p_executed_by: fin.id,
  });
  await svc.from("users").update({ deactivated_at: null }).eq("id", fin.id);
  deadErr
    ? ok("a deactivated finance approver cannot send a payment")
    : bad("A DEACTIVATED ACCOUNT RELEASED MONEY");
}

console.log("\nC. One live remittance per payment");
{
  const { data: r } = await svc.from("remittances").select("payment_id").eq("id", vendorRemId).single();
  const { error } = await svc.rpc("create_vendor_remittance", {
    p_payment_id: r.payment_id, p_reference: `REM-${stamp}-V2`, p_executed_by: fin.id,
  });
  error ? ok("a second remittance for the same invoice is refused")
        : bad("A SECOND REMITTANCE WAS CREATED FOR THE SAME INVOICE");
}

console.log("\nD. An instruction can be claimed for sending exactly once");
{
  const results = await Promise.all([
    svc.rpc("claim_remittance_for_sending", { p_id: vendorRemId }),
    svc.rpc("claim_remittance_for_sending", { p_id: vendorRemId }),
    svc.rpc("claim_remittance_for_sending", { p_id: vendorRemId }),
  ]);
  const won = results.filter((r) => !r.error).length;
  won === 1
    ? ok("3 concurrent claims → exactly 1 winner; the others were refused")
    : bad(`${won} callers each believed they were sending`);
}

// Held by name. This was `made.entries[0]`, which silently became the wrong
// entry the moment a fixture pushed something ahead of it — an index into a
// shared cleanup list is not an identity.
let vendorRemEntryId = null;

console.log("\nE. Posting the send moves the money and settles the obligation");
{
  const { data: entry, error } = await svc.rpc("record_remittance_sent", {
    p_id: vendorRemId, p_transfer_code: `TRF_TEST_${stamp}`,
  });
  if (error) { bad(`posting failed — ${error.message}`); }
  else {
    made.entries.push(entry);
    vendorRemEntryId = entry;
    const after = await held();
    heldBefore - after === 180000
      ? ok(`client funds fell by exactly ₦180,000 (${heldBefore} → ${after})`)
      : bad(`funds moved by ${heldBefore - after}, expected -180000`);

    const { data: r } = await svc.from("remittances")
      .select("status, ledger_entry_id, payment_id").eq("id", vendorRemId).single();
    r.status === "sent" ? ok("remittance marked sent") : bad(`status ${r.status}`);

    const { data: p } = await svc.from("payments").select("status")
      .eq("id", r.payment_id).single();
    p.status === "remitted"
      ? ok("the payment is 'remitted' only now the money has gone")
      : bad(`payment status ${p.status}`);
  }
}

console.log("\nF. Re-confirming does not post a second time");
{
  const before = await held();
  const { data: again } = await svc.rpc("record_remittance_sent", {
    p_id: vendorRemId, p_transfer_code: `TRF_TEST_${stamp}`,
  });
  const after = await held();
  again === vendorRemEntryId
    ? ok("the same ledger entry is returned")
    : bad(`different entry ${again} (expected ${vendorRemEntryId})`);
  before === after ? ok("funds unchanged — no double posting") : bad(`DOUBLE POSTED: ${before - after}`);
}

console.log("\nG. A sent remittance cannot be restated or re-sent");
{
  const { error: amtErr } = await svc.from("remittances")
    .update({ net_amount: 1 }).eq("id", vendorRemId);
  const { data: check } = await svc.from("remittances")
    .select("net_amount, status").eq("id", vendorRemId).single();
  Number(check.net_amount) === 180000
    ? ok(`the amount is unchanged${amtErr ? " (refused outright)" : ""}`)
    : bad("A SENT REMITTANCE WAS RESTATED");

  await svc.from("remittances").update({ status: "queued" }).eq("id", vendorRemId);
  const { data: after } = await svc.from("remittances")
    .select("status").eq("id", vendorRemId).single();
  after.status === "sent"
    ? ok("cannot be walked back to queued to be sent again")
    : bad(`STATUS WAS RESET TO ${after.status}`);
}

console.log("\nH. Rent: fees are deducted and land in fee income");
{
  await svc.from("payment_settings").upsert({
    org_id: orgId, management_fee_percent: 10, admin_fee_percent: 2.5,
  });

  // Put rent in hand first — you cannot remit what you are not holding.
  const { data: intent } = await svc.from("payment_intents").insert({
    org_id: orgId, purpose: "rent", amount_expected: 1000000,
    gateway: "simulated", gateway_reference: `RENT-${stamp}`, created_by: fin.id,
  }).select("id").single();
  made.intents.push(intent.id);
  const { data: collEntry } = await svc.rpc("record_collection", {
    p_intent_id: intent.id, p_amount_verified: 1000000,
  });
  made.entries.push(collEntry);

  const feeBefore = await balanceOf("fee_income");
  const bankBefore = await held();

  const { data: remId, error } = await svc.rpc("create_landlord_remittance", {
    p_org_id: orgId, p_landlord_user_id: landlord.id, p_property_id: null,
    p_period: `${stamp}`, p_gross: 1000000, p_reference: `REM-${stamp}-L`,
  });
  if (error) { bad(`could not create — ${error.message}`); }
  else {
    made.remittances.push(remId);
    const { data: r } = await svc.from("remittances")
      .select("gross_amount, management_fee, admin_fee, net_amount").eq("id", remId).single();
    Number(r.management_fee) === 100000 && Number(r.admin_fee) === 25000
      ? ok("10% management + 2.5% admin = ₦125,000 retained")
      : bad(`fees were ${r.management_fee} / ${r.admin_fee}`);
    Number(r.net_amount) === 875000
      ? ok("landlord receives ₦875,000")
      : bad(`net ${r.net_amount}`);

    await svc.rpc("claim_remittance_for_sending", { p_id: remId });
    const { data: e2, error: postErr } = await svc.rpc("record_remittance_sent", {
      p_id: remId, p_transfer_code: `TRF_TEST_${stamp}_L`,
    });
    if (postErr) { bad(`posting failed — ${postErr.message}`); }
    else {
      made.entries.push(e2);
      const bankAfter = await held();
      bankBefore - bankAfter === 875000
        ? ok("the bank gave up ₦875,000 — the net, not the gross")
        : bad(`bank moved by ${bankBefore - bankAfter}`);
      const feeAfter = await balanceOf("fee_income");
      Math.abs(Math.abs(feeAfter - feeBefore) - 125000) < 0.01
        ? ok("₦125,000 recognised as fee income")
        : bad(`fee income moved by ${feeAfter - feeBefore}`);
    }
  }
}

console.log("\nI. Cannot pay out more than is held for a counterparty");
{
  const { data: remId, error } = await svc.rpc("create_landlord_remittance", {
    p_org_id: orgId, p_landlord_user_id: landlord.id, p_property_id: null,
    p_period: `${stamp}-OVER`, p_gross: 50000000, p_reference: `REM-${stamp}-OVER`,
  });
  if (error) { ok(`refused at creation — ${error.message.slice(0, 44)}`); }
  else {
    made.remittances.push(remId);
    await svc.rpc("claim_remittance_for_sending", { p_id: remId });
    const { error: postErr } = await svc.rpc("record_remittance_sent", {
      p_id: remId, p_transfer_code: "TRF_OVERDRAW",
    });
    postErr
      ? ok(`the ledger refused the overpayment (${postErr.message.slice(0, 44)})`)
      : bad("PAID OUT MORE THAN WAS HELD");
  }
}

console.log("\nJ. An unknown outcome stays unknown");
{
  const payId = await newPayment("approved", { verified: true, scored: true, approved: true });
  const { data: remId } = await svc.rpc("create_vendor_remittance", {
    p_payment_id: payId, p_reference: `REM-${stamp}-U`, p_executed_by: fin.id,
  });
  made.remittances.push(remId);
  await svc.rpc("claim_remittance_for_sending", { p_id: remId });
  await svc.rpc("record_remittance_outcome", {
    p_id: remId, p_status: "unknown", p_message: "gateway timed out",
  });

  const { data: r } = await svc.from("remittances")
    .select("status, ledger_entry_id").eq("id", remId).single();
  r.status === "unknown" && r.ledger_entry_id === null
    ? ok("held at unknown with nothing posted — a human must resolve it")
    : bad(`status ${r.status}, entry ${r.ledger_entry_id}`);

  // The dangerous move: re-claiming it as if it were fresh.
  const { error } = await svc.rpc("claim_remittance_for_sending", { p_id: remId });
  error ? ok("cannot be re-claimed for sending — no blind retry") : bad("RE-CLAIMED AND WOULD SEND AGAIN");
}

console.log("\nK. Segregation still holds");
{
  // Scoped to NGN — client_funds_position is one row per currency an org has
  // enabled (0103), and remittance is NGN-only (Flutterwave is collections-only).
  const { data: pos } = await svc.from("client_funds_position")
    .select("funds_held, funds_owed").eq("org_id", orgId).eq("currency", "NGN").single();
  Number(pos.funds_held) >= 0
    ? ok(`held ₦${Number(pos.funds_held).toLocaleString()}, owed ₦${Number(pos.funds_owed).toLocaleString()}`)
    : bad("client funds went negative");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("payment_settings").upsert({
  org_id: orgId, management_fee_percent: 0, admin_fee_percent: 0,
});
await svc.from("remittances").delete().in("id", made.remittances.filter(Boolean));
await svc.from("payment_intents").delete().in("id", made.intents);
await svc.from("payments").delete().in("id", made.payments);
const uniqueEntries = [...new Set(made.entries.filter(Boolean))];
await svc.from("ledger_postings").delete().in("entry_id", uniqueEntries);
await svc.from("ledger_entries").delete().in("id", uniqueEntries);
await svc.from("payout_recipients").delete().in("id", made.recipients);
console.log("\n(cleaned up; fees reset to 0)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — nothing leaves without the gate, and nothing leaves twice."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
