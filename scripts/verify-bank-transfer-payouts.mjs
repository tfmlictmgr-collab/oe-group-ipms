// Verifies paying somebody by bank transfer (0289), end to end, in the seats of
// the real people who do it.
//
//   npx tsx scripts/verify-bank-transfer-payouts.mjs
//
// What it proves, in order:
//   A. The table: a bank-transfer account cannot be written straight through
//      the API, and cannot exist half-complete or with a number for a name.
//   B. The one-time link: only the desks that pay may send one for a
//      contractor, its name comes off the contractor's own record, a second
//      link kills the first, and a submission needs a real document in the
//      payee's own folder and works exactly once.
//   C. Confirming a document, and the maker-checker on it: whoever vouches for
//      an account may not pay it.
//   D. Paying: the whole B4 chain still stands in front of a bank transfer, the
//      bank's confirmation is compulsory and must really exist, the ledger says
//      "Paid by bank transfer", the invoice is marked remitted, and the record
//      cannot be edited afterwards.
//   E. Grants: the money functions answer to the server alone.
//
// Every database write happens inside ONE transaction that is rolled back —
// nothing survives but the two small files uploaded to storage, which are
// deleted at the end. Decisions are taken as REAL signed-in people
// (`set local role authenticated` with their own claims), never inserted with
// the service role: 0289's own header records what service-role fixtures did
// to the audit trail.
import { config } from "dotenv";
import pg from "pg";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });
if (!process.env.SUPABASE_DB_HOST) {
  console.error("Missing SUPABASE_DB_* in .env.local");
  process.exit(2);
}
if (/prod/i.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
  console.error("Refusing to run: target looks like production.");
  process.exit(2);
}

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const one = async (sql, p) => (await db.query(sql, p)).rows[0];
async function as(uid) {
  await db.query("set local role authenticated");
  await db.query(`set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated" })}'`);
}
/**
 * Back to the server's seat: no role AND no claims. `reset role` alone left the
 * last person's claims in place for the rest of the transaction, so a "server"
 * call still ran as them — and the payment trigger refused a correct transfer
 * because it thought the payment approver was marking the invoice remitted.
 * The server calls these functions with no signed-in person at all.
 */
async function asOwner() {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', '', true)");
}
/** Runs `sql`; returns the refusal message, or null if it succeeded. */
async function refused(sql, params) {
  await db.query("savepoint s");
  try {
    const r = await db.query(sql, params);
    await db.query("release savepoint s");
    refused.last = r;
    return null;
  } catch (e) {
    await db.query("rollback to savepoint s");
    return e.message;
  }
}

const uploaded = [];
async function upload(path) {
  // One transparent pixel. A real file, because 0289 checks the object exists.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64"
  );
  const { error } = await svc.storage.from("payout-evidence").upload(path, png, { contentType: "image/png", upsert: false });
  if (error) throw new Error(`could not upload ${path}: ${error.message}`);
  uploaded.push(path);
  return path;
}

await db.connect();

const org = await one("select id from orgs where slug = 'oea' and deleted_at is null");
const byEmail = async (email) => one("select id, role from users where email = $1", [email]);
const admin = await byEmail("oea.admin@oegroup.test");
const finance = await byEmail("oea.finance@oegroup.test");
const fm = await one(
  "select id from users where org_id = $1 and role = 'facility_manager' and deactivated_at is null and email not like 'probe%' order by created_at limit 1",
  [org.id]
);

// The chain's own deciders, one per stage, never the payment officer.
const stages = (await db.query("select stage_order, required_roles from payment_chain_stages($1) order by 1", [org.id])).rows;
const deciders = [];
for (const s of stages) {
  const roles = String(s.required_roles).replace(/[{}]/g, "").split(",");
  const u = await one(
    `select id from users where org_id = $1 and role = any($2::user_role[]) and deactivated_at is null
        and email not like 'probe%' and id <> $3 and not (id = any($4::uuid[]))
      order by coalesce(approval_tier, 0) desc, created_at limit 1`,
    [org.id, roles, finance.id, deciders.map((d) => d.id)]
  );
  if (!u) {
    console.error(`No demo login holds stage ${s.stage_order} (${roles.join(" or ")}) in OEA — run scripts/seed-org-logins.mjs`);
    process.exit(2);
  }
  deciders.push({ stage: s.stage_order, id: u.id });
}

const stamp = Date.now().toString(36).toUpperCase();
const hash = () => crypto.createHash("sha256").update(crypto.randomBytes(16)).digest("hex");

try {
  await db.query("begin");

  // Fixtures, as the owner, inside the transaction.
  const vendorA = await one(
    "insert into vendors (org_id, name, status, approval_status) values ($1, $2, 'active', 'approved') returning id, name",
    [org.id, `PROBEPAY Plumbing ${stamp}`]
  );
  const vendorB = await one(
    "insert into vendors (org_id, name, status, approval_status) values ($1, $2, 'active', 'approved') returning id, name",
    [org.id, `PROBEPAY Electrical ${stamp}`]
  );

  // ══════════════════════════════════════════════════════════════════════════
  section("A. A bank-transfer account is written only by the functions that vet it");

  await as(admin.id);
  const direct = await refused(
    `insert into payout_recipients (org_id, party, vendor_id, display_name, bank_name, account_name,
       account_number_last4, gateway, evidence_bucket, evidence_path, details_source, verified_at)
     values ($1, 'vendor', $2, 'x', 'GTBank', 'Anyone At All', '1234', 'manual', 'payout-evidence', 'x', 'payee_link', now())`,
    [org.id, vendorA.id]
  );
  direct
    ? ok("an administrator cannot write a bank-transfer account straight through the API")
    : bad("a bank-transfer account was inserted directly — payroll diversion with our audit trail on it");

  await asOwner();
  const half = await refused(
    `insert into payout_recipients (org_id, party, vendor_id, display_name, gateway, currency)
     values ($1, 'vendor', $2, 'x', 'manual', 'NGN')`,
    [org.id, vendorA.id]
  );
  half && /manual_is_evidenced/.test(half)
    ? ok("a bank-transfer account cannot exist without its bank, name, last four and document")
    : bad(`a half-complete bank-transfer account was accepted: ${half}`);

  const digits = await refused(
    `insert into payout_recipients (org_id, party, vendor_id, display_name, bank_name, account_name,
       account_number_last4, gateway, evidence_bucket, evidence_path, details_source)
     values ($1, 'vendor', $2, 'x', 'GTBank', '0123456789', '6789', 'manual', 'payout-evidence', 'x', 'payee_link')`,
    [org.id, vendorA.id]
  );
  digits && /name_is_a_name/.test(digits)
    ? ok("an account number in the account-NAME box is refused (0262's lesson, at the table)")
    : bad(`a number was accepted as an account name: ${digits}`);

  // ══════════════════════════════════════════════════════════════════════════
  section("B. The one-time link");

  await as(fm.id);
  const fmAsk = await refused(
    "select request_payout_details('vendor', $1, null, null, null, 'a@example.com', null, 'work', $2)",
    [vendorA.id, hash()]
  );
  fmAsk
    ? ok("a facilities manager cannot ask a contractor for bank details — the paying desks do")
    : bad("a facilities manager sent a contractor a bank-details link");

  await as(finance.id);
  const tokenA1 = hash();
  const first = await one(
    "select request_payout_details('vendor', $1, null, null, 'Somebody Else Entirely', 'plumber@example.com', null, 'the work you do for us', $2) as id",
    [vendorA.id, tokenA1]
  );
  const reqRow = await one("select payee_name, withdrawn_at from payout_detail_requests where id = $1", [first.id]);
  reqRow.payee_name === vendorA.name
    ? ok("the link names the contractor from their own record, not from what was typed")
    : bad(`the link was addressed to a typed name: ${reqRow.payee_name}`);

  const tokenA = hash();
  const second = await one(
    "select request_payout_details('vendor', $1, null, null, null, 'plumber@example.com', null, 'the work you do for us', $2) as id",
    [vendorA.id, tokenA]
  );
  const firstAfter = await one("select withdrawn_at from payout_detail_requests where id = $1", [first.id]);
  firstAfter.withdrawn_at && second.id !== first.id
    ? ok("a second link kills the first — an old message in somebody's inbox stops working")
    : bad("two live links exist for one contractor");

  await asOwner();
  const noDoc = await refused(
    "select submit_payout_details($1, 'Guaranty Trust Bank', '058', 'PROBEPAY PLUMBING LTD', '4417', false, $2, 'letter.png')",
    [tokenA, `${org.id}/requests/${second.id}/never-uploaded.png`]
  );
  noDoc && /did not finish uploading/.test(noDoc)
    ? ok("a submission naming a document that is not in storage is refused")
    : bad(`a submission with no real document was accepted: ${noDoc}`);

  const elsewhere = await upload(`${org.id}/requests/${first.id}/wrong-folder-${stamp}.png`);
  const wrongFolder = await refused(
    "select submit_payout_details($1, 'Guaranty Trust Bank', '058', 'PROBEPAY PLUMBING LTD', '4417', false, $2, 'letter.png')",
    [tokenA, elsewhere]
  );
  wrongFolder && /attach a document/.test(wrongFolder)
    ? ok("a document from another link's folder is refused")
    : bad(`a document outside this link's folder was accepted: ${wrongFolder}`);

  const docA = await upload(`${org.id}/requests/${second.id}/letter-${stamp}.png`);
  const acctA = await one(
    "select submit_payout_details($1, 'Guaranty Trust Bank', '058', 'PROBEPAY PLUMBING LTD', '4417', false, $2, 'letter.png') as id",
    [tokenA, docA]
  );
  const acctRow = await one(
    "select gateway, active, verified_at, account_number_last4, name_confirmed_by_bank, details_source from payout_recipients where id = $1",
    [acctA.id]
  );
  acctRow.gateway === "manual" && acctRow.active && !acctRow.verified_at && acctRow.account_number_last4 === "4417"
    ? ok("the payee's submission becomes an account — last four only, waiting for its document to be checked")
    : bad(`the submitted account is wrong: ${JSON.stringify(acctRow)}`);

  const again = await refused(
    "select submit_payout_details($1, 'Guaranty Trust Bank', '058', 'PROBEPAY PLUMBING LTD', '4417', false, $2, 'letter.png')",
    [tokenA, docA]
  );
  again && /already been sent/.test(again)
    ? ok("the link works exactly once")
    : bad(`a spent link was accepted again: ${again}`);

  const lapsedToken = hash();
  await as(finance.id);
  const lapsedReq = await one(
    "select request_payout_details('vendor', $1, null, null, null, 'sparky@example.com', null, 'work', $2) as id",
    [vendorB.id, lapsedToken]
  );
  await asOwner();
  await db.query("update payout_detail_requests set expires_at = now() - interval '1 minute', requested_at = now() - interval '15 days' where id = $1", [lapsedReq.id]);
  const lapsed = await refused(
    "select submit_payout_details($1, 'Zenith Bank', '057', 'PROBEPAY ELECTRICAL', '9001', false, $2, 'x.png')",
    [lapsedToken, `${org.id}/requests/${lapsedReq.id}/x.png`]
  );
  lapsed && /expired/.test(lapsed)
    ? ok("an expired link is refused")
    : bad(`an expired link was accepted: ${lapsed}`);

  // ══════════════════════════════════════════════════════════════════════════
  section("C. Confirming the document — and who may then pay");

  await as(fm.id);
  const fmConfirm = await refused("select confirm_payout_account_evidence($1)", [acctA.id]);
  fmConfirm ? ok("a facilities manager cannot confirm a payee's bank details") : bad("a facilities manager confirmed bank details");

  await as(admin.id);
  const conf = await refused("select confirm_payout_account_evidence($1)", [acctA.id]);
  const confirmed = await one("select verified_at, verified_by from payout_recipients where id = $1", [acctA.id]);
  !conf && confirmed.verified_at && confirmed.verified_by === admin.id
    ? ok("an administrator confirms the document, and is recorded as the person who did")
    : bad(`confirming the document failed: ${conf}`);

  // Vendor B: an account the PAYMENT OFFICER confirms — so they may not pay it.
  const tokenB = hash();
  await as(finance.id);
  const reqB = await one(
    "select request_payout_details('vendor', $1, null, null, null, 'sparky@example.com', null, 'work', $2) as id",
    [vendorB.id, tokenB]
  );
  await asOwner();
  const docB = await upload(`${org.id}/requests/${reqB.id}/letter-${stamp}.png`);
  const acctB = await one(
    "select submit_payout_details($1, 'Zenith Bank', '057', 'PROBEPAY ELECTRICAL', '9001', false, $2, 'letter.png') as id",
    [tokenB, docB]
  );
  await as(finance.id);
  await db.query("select confirm_payout_account_evidence($1)", [acctB.id]);

  // ══════════════════════════════════════════════════════════════════════════
  section("D. Paying by bank transfer — the whole gate still stands");

  // An invoice at the chain, then the chain decided by its own people.
  await asOwner();
  const mkPayment = async (vendorId) =>
    one(
      `insert into payments (org_id, vendor_id, amount, status, invoice_reference, service_verified_at, performance_validated)
       values ($1, $2, 5000, 'recommended', $3, now(), true) returning id`,
      [org.id, vendorId, `PROBEPAY-INV-${stamp}-${vendorId.slice(0, 4)}`]
    );
  const payA = await mkPayment(vendorA.id);
  const payB = await mkPayment(vendorB.id);

  const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
  const pay = (payment, proof, opts = {}) =>
    refused(
      "select pay_by_bank_transfer('vendor_payment', $1, null, $2, $3, $4::date, $5, $6, 'receipt.png', null) as id",
      [payment, `PROBEPAY-REM-${stamp}-${Math.random().toString(36).slice(2, 7)}`, opts.sentBy ?? finance.id,
       opts.date ?? today, opts.ref ?? "TRF-000123456789", proof]
    );

  // Before the chain: refused, however perfect the evidence.
  const proofEarly = await upload(`${org.id}/transfers/${payA.id}/early-${stamp}.png`);
  const early = await pay(payA.id, proofEarly);
  early && /cannot be remitted|not been approved/.test(early)
    ? ok("a bank transfer is refused before the approval chain is complete")
    : bad(`a bank transfer skipped the approval chain, or was refused for another reason: ${early}`);

  for (const p of [payA.id, payB.id]) {
    for (const d of deciders) {
      await as(d.id);
      const r = await refused("select record_payment_approval('vendor_payment', $1, $2::smallint, 'approved')", [p, d.stage]);
      if (r) bad(`stage ${d.stage} could not be recorded: ${r}`);
    }
  }
  await asOwner();
  const approvedA = await one("select status from payments where id = $1", [payA.id]);
  approvedA.status === "approved"
    ? ok("the chain, decided by its own signed-in people, approves the invoice")
    : bad(`the invoice did not reach approved: ${approvedA.status}`);

  // Refusals, each on its own.
  const noProof = await pay(payA.id, `${org.id}/transfers/${payA.id}/not-there.png`);
  noProof && /did not finish uploading/.test(noProof)
    ? ok("a confirmation that is not in storage is refused")
    : bad(`a missing confirmation was accepted: ${noProof}`);

  const proofA = await upload(`${org.id}/transfers/${payA.id}/receipt-${stamp}.png`);
  const future = await pay(payA.id, proofA, { date: "2099-01-01" });
  future && /future/.test(future) ? ok("a transfer dated in the future is refused") : bad(`a future-dated transfer was accepted: ${future}`);

  const noRef = await pay(payA.id, proofA, { ref: "" });
  noRef && /reference/.test(noRef) ? ok("a transfer without the bank's reference is refused") : bad(`a transfer with no reference was accepted: ${noRef}`);

  const byAdmin = await pay(payA.id, proofA, { sentBy: admin.id });
  // The DISBURSEMENT gate's own words — not the payment trigger's, which says
  // something similar and would let this pass for the wrong reason.
  byAdmin && /only a finance approver may send a payment/i.test(byAdmin)
    ? ok("an administrator cannot record a transfer — finance disburses (decision 16)")
    : bad(`an administrator recorded a transfer: ${byAdmin}`);

  const approverSends = await pay(payA.id, proofA, { sentBy: deciders[deciders.length - 1].id });
  approverSends ? ok("the person who approved the payment cannot record its transfer") : bad("an approver recorded the transfer of a payment they approved");

  const proofB = await upload(`${org.id}/transfers/${payB.id}/receipt-${stamp}.png`);
  const selfConfirmed = await pay(payB.id, proofB);
  selfConfirmed && /confirmed this payee/.test(selfConfirmed)
    ? ok("whoever confirmed a payee's bank details cannot also pay them")
    : bad(`the payment officer paid an account they confirmed themselves: ${selfConfirmed}`);

  // And the one that goes through. A property fund may be short on staging — if
  // so the officer authorises this one payment, exactly as the screen offers.
  let paid = await pay(payA.id, proofA);
  if (paid && /fund cannot cover this|would be left short by/i.test(paid)) {
    await as(finance.id);
    const st = await one("select account_id from payable_fund_override_state('vendor_payment', $1)", [payA.id]);
    await db.query("select authorise_fund_override($1, $2)", [st.account_id, "Verification suite: covered for one test payment only."]);
    await asOwner();
    paid = await pay(payA.id, proofA);
  }
  if (paid) {
    bad(`a correctly evidenced bank transfer was refused: ${paid}`);
  } else {
    const rem = await one(
      `select r.id, r.status, r.gateway, r.sent_by, p.status as payment_status
         from remittances r join payments p on p.id = r.payment_id where r.payment_id = $1`,
      [payA.id]
    );
    rem.status === "sent" && rem.gateway === "manual" && rem.sent_by === finance.id && rem.payment_status === "remitted"
      ? ok("the payout is sent, marked as a bank transfer, attributed to the officer, and the invoice is remitted")
      : bad(`the payout is not in the expected state: ${JSON.stringify(rem)}`);

    const rec = await one(
      "select bank_reference, payee_account_last4, amount, recorded_by from manual_remittance_records where remittance_id = $1",
      [rem.id]
    );
    rec?.bank_reference === "TRF-000123456789" && rec.payee_account_last4 === "4417" && Number(rec.amount) === 5000
      ? ok("the record keeps the bank's reference, the last four digits and the amount — never the whole number")
      : bad(`the transfer record is wrong: ${JSON.stringify(rec)}`);

    const memo = await one(
      `select string_agg(lp.memo, ' | ') m from ledger_postings lp
         join ledger_entries le on le.id = lp.entry_id where le.entity_id = $1`,
      [rem.id]
    );
    /Paid by bank transfer from/.test(memo?.m ?? "")
      ? ok("the ledger says the money left by bank transfer, in words")
      : bad(`the ledger memo does not say how it left: ${memo?.m}`);

    const edit = await refused("update manual_remittance_records set bank_reference = 'CHANGED' where remittance_id = $1", [rem.id]);
    edit ? ok("a recorded transfer cannot be edited afterwards") : bad("a recorded bank transfer was edited");

    // Named for the rule that actually refuses it: the confirmation is filed
    // under ANOTHER payment's folder. (The unique-path rule behind it matters
    // for a requisition, whose payees share one folder; asserting it here would
    // be a check that passes for a reason other than the one it names.)
    const reuse = await pay(payB.id, proofA);
    reuse && /attach your bank's confirmation/.test(reuse)
      ? ok("a confirmation filed under another payment is refused as this one's evidence")
      : bad(`another payment's confirmation was accepted: ${reuse}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section("E. The money functions answer to the server alone");

  await as(finance.id);
  const direct2 = await refused(
    "select pay_by_bank_transfer('vendor_payment', $1, null, 'x', $2, current_date, 'TRF-1', 'x', null, null)",
    [payB.id, finance.id]
  );
  direct2 && /permission denied/.test(direct2)
    ? ok("a signed-in payment officer cannot call the recording function directly — it takes the sender as a parameter")
    : bad(`pay_by_bank_transfer is callable by a signed-in user: ${direct2}`);

  const inner = await refused(
    "select record_manual_remittance(gen_random_uuid(), $1, current_date, 'x', 'x', null, null, gen_random_uuid())",
    [finance.id]
  );
  inner && /permission denied/.test(inner)
    ? ok("the inner recorder is reachable from nowhere but its one caller")
    : bad(`record_manual_remittance is callable: ${inner}`);
} finally {
  await db.query("rollback").catch(() => {});
  if (uploaded.length) {
    const { error } = await svc.storage.from("payout-evidence").remove(uploaded);
    if (error) console.log(`  (could not remove ${uploaded.length} test file(s): ${error.message})`);
  }
  await db.end();
}

console.log(
  failures
    ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
    : "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a bank transfer is paid against the payee's own evidence, through the whole gate, by the payment officer alone, and recorded for good."
);
process.exit(failures ? 1 : 0);
