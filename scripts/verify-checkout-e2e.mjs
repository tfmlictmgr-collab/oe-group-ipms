// End-to-end checkout: a payment presented at checkout, notified by a signed
// webhook over real HTTP, verified server-to-server, posted to the ledger, and
// receipted.
//
// The claim under test is the one that protects the money:
//   the amount that reaches the ledger comes from the gateway's own record,
//   NEVER from the webhook body — even when the body screams otherwise.
// So the payload here deliberately claims ₦999,999,999. If that figure ever
// appears in the ledger, this script fails.
//
// Requires the dev server: npm run dev
// Usage: node scripts/verify-checkout-e2e.mjs
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.SIMULATED_GATEWAY_SECRET ?? "dev-simulated-secret";
const SITE = process.env.VERIFY_SITE_URL ?? "http://localhost:3000";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

// The dev server must actually be up, or every check below "passes" vacuously.
try {
  const ping = await fetch(`${SITE}/api/webhooks/payments/evilgateway`, { method: "POST", body: "{}" });
  if (ping.status !== 404) throw new Error(`unexpected ${ping.status}`);
} catch (e) {
  console.error(`\nCannot reach ${SITE} — start the dev server first (npm run dev).\n${e.message}`);
  process.exit(1);
}

const { data: fin } = await svc.from("users").select("id, org_id")
  .eq("email", "oe-group-foundation-poc.financeapprover@oegroup.test").single();
const orgId = fin.org_id;
await svc.rpc("ensure_default_ledger_accounts", { p_org_id: orgId });

// Resolved the same way record_collection resolves it, so the balance watched
// here is the balance the posting actually moves.
const { data: bankAcctId } = await svc.rpc("collection_bank_account", { p_org_id: orgId });
const held = async () => {
  const { data } = await svc.from("ledger_account_balances")
    .select("natural_balance").eq("account_id", bankAcctId).single();
  return Number(data.natural_balance);
};

const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const REF = `OE-SC-E2E-${stamp}`;
const EXPECTED = 400000;
const ACTUALLY_PAID = 250000;      // deliberately short
const LIE = 999_999_999;           // what the payload claims

const { data: intent } = await svc.from("payment_intents").insert({
  org_id: orgId, purpose: "service_charge", amount_expected: EXPECTED,
  gateway: "simulated", gateway_reference: REF, created_by: fin.id,
  payer_user_id: (await svc.from("users").select("id").eq("email", "oe-group-foundation-poc.tenant@oegroup.test").single()).data.id,
}).select("id").single();

function signed(body) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-simulated-signature": crypto.createHmac("sha256", SECRET).update(body).digest("hex"),
    },
    body,
  };
}
const payload = JSON.stringify({
  event: "charge.success", event_id: `SIM-${REF}`, reference: REF, amount: LIE,
});

console.log(`Checkout end to end — against ${SITE}\n`);

console.log("A. An unsigned notification is refused");
{
  const r = await fetch(`${SITE}/api/webhooks/payments/simulated`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
  });
  r.status === 403 ? ok("403 without a signature") : bad(`got ${r.status}, expected 403`);
}

console.log("\nB. A forged signature is refused");
{
  const r = await fetch(`${SITE}/api/webhooks/payments/simulated`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-simulated-signature": "f".repeat(64) },
    body: payload,
  });
  r.status === 403 ? ok("403 with a wrong signature") : bad(`got ${r.status}, expected 403`);
}

console.log("\nC. Nothing was presented at checkout — a valid notification posts nothing");
{
  const r = await fetch(`${SITE}/api/webhooks/payments/simulated`, signed(payload));
  const { data: i } = await svc.from("payment_intents")
    .select("status, ledger_entry_id").eq("id", intent.id).single();
  r.status === 200 ? ok("accepted (200) — signature was valid") : bad(`got ${r.status}`);
  i.ledger_entry_id === null
    ? ok("no ledger entry: verification found no charge, so nothing posted")
    : bad("POSTED without any charge existing");
}

console.log("\nD. The payer pays — short — and the ledger takes the VERIFIED amount");
const before = await held();
{
  // What the checkout page writes: the gateway's own record of the charge.
  await svc.from("simulated_charges").upsert({
    reference: REF, amount: ACTUALLY_PAID, currency: "NGN",
    status: "success", paid_at: new Date().toISOString(),
  });
  // A fresh event id, since the previous delivery is already recorded.
  const body = JSON.stringify({
    event: "charge.success", event_id: `SIM-${REF}-2`, reference: REF, amount: LIE,
  });
  const r = await fetch(`${SITE}/api/webhooks/payments/simulated`, signed(body));
  r.status === 200 ? ok("notification accepted") : bad(`got ${r.status}`);

  const { data: i } = await svc.from("payment_intents")
    .select("status, amount_paid, amount_mismatch, ledger_entry_id").eq("id", intent.id).single();

  i.ledger_entry_id ? ok("posted to the ledger") : bad("nothing posted");
  Number(i.amount_paid) === ACTUALLY_PAID
    ? ok(`recorded ₦${ACTUALLY_PAID.toLocaleString()} — the verified amount`)
    : bad(`recorded ${i.amount_paid}, expected ${ACTUALLY_PAID}`);
  Number(i.amount_paid) !== LIE
    ? ok("the ₦999,999,999 claimed in the payload was ignored")
    : bad("THE PAYLOAD AMOUNT REACHED THE LEDGER");
  i.status === "part_paid" ? ok("status part_paid, not paid") : bad(`status ${i.status}`);
  i.amount_mismatch === true ? ok("shortfall flagged") : bad("shortfall not flagged");

  const after = await held();
  after - before === ACTUALLY_PAID
    ? ok(`client funds rose by exactly ₦${ACTUALLY_PAID.toLocaleString()}`)
    : bad(`funds moved by ${after - before}`);

  // Regression guard. This was found live: the debit was landing in whichever
  // client-funds account the planner returned first. Money in an account
  // reconciliation does not compare is money that can never be matched to the
  // bank statement.
  const { data: postings } = await svc.from("ledger_postings")
    .select("account_id, amount").eq("entry_id", i.ledger_entry_id);
  const debit = (postings ?? []).find((p) => Number(p.amount) > 0);
  const { data: expectedAcct } = await svc.rpc("collection_bank_account", { p_org_id: orgId });
  debit?.account_id === expectedAcct
    ? ok("debited the account reconciliation compares against")
    : bad(`debited ${debit?.account_id}, expected ${expectedAcct}`);
}

console.log("\nE. The invoice is NOT closed by a part payment");
{
  const { data: i } = await svc.from("payment_intents")
    .select("service_charge_id").eq("id", intent.id).single();
  i.service_charge_id === null
    ? ok("no invoice attached to this test intent (nothing to close)")
    : await (async () => {
        const { data: sc } = await svc.from("service_charges")
          .select("status").eq("id", i.service_charge_id).single();
        sc.status !== "paid" ? ok("invoice still open") : bad("invoice marked paid on a part payment");
      })();
}

console.log("\nF. Redelivery over HTTP cannot double-post");
{
  const mid = await held();
  const same = JSON.stringify({
    event: "charge.success", event_id: `SIM-${REF}-2`, reference: REF, amount: LIE,
  });
  const r = await fetch(`${SITE}/api/webhooks/payments/simulated`, signed(same));
  const after = await held();
  r.status === 200 ? ok("redelivery answered 200, as a gateway expects") : bad(`got ${r.status}`);
  after === mid ? ok("funds unchanged — no double post") : bad(`funds moved by ${after - mid}`);

  const { count } = await svc.from("ledger_entries")
    .select("*", { count: "exact", head: true })
    .eq("entity_type", "payment_intent").eq("entity_id", intent.id);
  count === 1 ? ok("exactly one ledger entry for the intent") : bad(`${count} entries`);
}

console.log("\nG. The receipt is not public");
{
  const r = await fetch(`${SITE}/api/receipts/${intent.id}`, { redirect: "manual" });
  [401, 302, 307].includes(r.status)
    ? ok(`a signed-out request cannot fetch a receipt (${r.status})`)
    : bad(`got ${r.status} — a receipt was served without a session`);
}

console.log("\nH. A receipt renders, and carries the verified figures");
{
  const { renderToBuffer } = await import("@react-pdf/renderer");
  const React = (await import("react")).default;
  const { ReceiptDocument } = await import("../lib/pdf/receipt.tsx");

  const { data: i } = await svc.from("payment_intents")
    .select("amount_paid, ledger_entry_id, paid_at, currency").eq("id", intent.id).single();

  const buf = await renderToBuffer(
    React.createElement(ReceiptDocument, {
      d: {
        org: { name: "TFML", logoUrl: null, primary: "#003366",
               supportEmail: "info@tfmlconsultant.com", supportPhone: null, tagline: null },
        reference: REF, ledgerEntryId: i.ledger_entry_id, purpose: "service_charge",
        description: "Collection — service charge", payerName: "Test Resident",
        payerEmail: "oe-group-foundation-poc.tenant@oegroup.test", amountExpected: EXPECTED,
        amountPaid: Number(i.amount_paid), currency: i.currency, paidAt: i.paid_at,
        gateway: "simulated", partial: Number(i.amount_paid) < EXPECTED,
      },
    })
  );
  buf.subarray(0, 5).toString() === "%PDF-"
    ? ok(`receipt rendered (${(buf.length / 1024).toFixed(1)} kB PDF)`)
    : bad("output is not a PDF");

  const text = buf.toString("latin1");
  !text.includes(String(LIE)) ? ok("the receipt does not carry the payload figure") : bad("receipt shows the forged amount");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
const { data: fin2 } = await svc.from("payment_intents")
  .select("ledger_entry_id").eq("id", intent.id).single();
await svc.from("gateway_events").delete().like("event_id", `SIM-${REF}%`);
await svc.from("payment_intents").delete().eq("id", intent.id);
if (fin2?.ledger_entry_id) {
  await svc.from("ledger_postings").delete().eq("entry_id", fin2.ledger_entry_id);
  await svc.from("ledger_entries").delete().eq("id", fin2.ledger_entry_id);
}
await svc.from("simulated_charges").delete().eq("reference", REF);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — checkout → signed webhook → verification → ledger → receipt."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
