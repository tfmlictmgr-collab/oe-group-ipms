// FM/PM ops requisitions (0170-0173): raising, the shared approval chain, a
// bank-verified one-off payee, and per-payee disbursement.
//
// ⚠️ This suite does NOT re-prove the chain mechanism itself — separation of
// duties, tier enforcement, amount re-resolution — because verify-approval-
// chain.mjs already does that at 49 checks and nothing about the chain's
// RULES changes for a third payable_type. What this proves is the seam: that
// a requisition actually REACHES the chain correctly, that its own gates
// (raise validation, the payee lock, per-payee disbursement grouping) hold,
// and — the finding that mattered most while building this — that the RLS
// visibility a signed-in session needs was not silently missing, which is
// exactly the class of gap 0157 found for the chain roles themselves.
//
// Verified by ATTEMPTING each operation with a real signed-in session where
// the claim is about who can see or do something, and by service-role calls
// only where the claim is about the mechanism (mirroring verify-approval-
// chain's own split).
//
// Usage: node scripts/verify-ops-requisitions.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

if (!URL_ || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
if (/prod/i.test(URL_)) {
  console.error("Refusing to run: target looks like production. This writes fixture rows.");
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
};

const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const poc = orgs.find((o) => o.slug === "oe-group-foundation-poc");
const oea = orgs.find((o) => o.slug === "oea");
if (!poc) { console.error("Need the POC org seeded."); process.exit(2); }

const pick = async (orgId, role, tier) => {
  let q = svc.from("users").select("id, email").eq("org_id", orgId).eq("role", role).is("deactivated_at", null);
  if (tier) q = q.eq("approval_tier", tier);
  return (await q.limit(1).maybeSingle()).data;
};

const fm = await pick(poc.id, "facility_manager");
const ops = await pick(poc.id, "fm_ops_staff");
const auditor = await pick(poc.id, "payment_audit_approver");
const approver1 = await pick(poc.id, "payment_approver", 1);
const approver3 = await pick(poc.id, "payment_approver", 3);
const finance = await pick(poc.id, "finance_approver");
const tenant = await pick(poc.id, "tenant");
if (!fm || !ops || !auditor || !approver1 || !approver3 || !finance) {
  console.error("Missing a seeded chain role in the POC org — run scripts/seed-org-logins.mjs");
  process.exit(2);
}

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeReqs = [];
const madeVendors = [];
const madeRecipients = [];

const walkChain = async (reqId, stages) => {
  for (const [stage, actorId] of stages) {
    const { error } = await svc.from("payment_approvals").insert({
      org_id: poc.id, payable_type: "ops_requisition", payable_id: reqId,
      stage_order: stage, actor_id: actorId, actor_role: "viewer", actor_tier: null,
      amount: 1, decision: "approved",
    });
    if (error) throw new Error(`stage ${stage}: ${error.message}`);
  }
};

const teardown = async (reqId) => {
  const { data: rems } = await svc.from("remittances").select("id").eq("requisition_id", reqId);
  for (const r of rems ?? []) await svc.from("remittances").delete().eq("id", r.id);
  await svc.from("ops_requisition_lines").delete().eq("requisition_id", reqId);
  await svc.from("payment_approvals").delete().eq("payable_id", reqId);
  const { data: req } = await svc.from("ops_requisitions").select("payable_entry_id").eq("id", reqId).maybeSingle();
  if (req?.payable_entry_id) {
    await svc.from("ledger_postings").delete().eq("entry_id", req.payable_entry_id);
    await svc.from("ledger_entries").delete().eq("id", req.payable_entry_id);
  }
  await svc.from("ops_requisitions").delete().eq("id", reqId);
};

console.log("\nFM/PM ops requisitions (0170-0173)\n");

// ---------------------------------------------------------------------------
console.log("1. Raising — validation, whole-or-nothing, and who may");
// ---------------------------------------------------------------------------
{
  const opsClient = await login(ops.email);

  const { error: noLines } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-A`, p_lines: [],
  });
  noLines ? ok("a requisition with no lines is refused") : bad("AN EMPTY REQUISITION WAS RAISED");

  const { error: badLine } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-B`,
    p_lines: [{ description: "Fine", amount: 500 }, { description: "x", amount: -1 }],
  });
  badLine ? ok("one bad line refuses the whole requisition") : bad("A NEGATIVE-AMOUNT LINE WAS ACCEPTED");

  // And nothing was left behind by the refused attempt.
  const { count } = await svc.from("ops_requisitions")
    .select("id", { count: "exact", head: true }).eq("reference", `REQ-${S}-B`);
  count === 0
    ? ok("the refused attempt left no partial row — whole or nothing, not three good lines and a missing fourth")
    : bad("A REFUSED REQUISITION LEFT A PARTIAL ROW");

  const { error: tenantErr } = await (await login(tenant?.email ?? ops.email)).rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-C`, p_lines: [{ description: "Should not work", amount: 100 }],
  });
  if (tenant) {
    tenantErr ? ok("a tenant cannot raise a requisition") : bad("A TENANT RAISED A REQUISITION");
  } else {
    note("no tenant seeded — skipped");
  }

  const { data: goodId, error: goodErr } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-D`,
    p_lines: [{ description: "Two light bulbs", amount: 4500 }, { description: "Cable ties", amount: 1200 }],
  });
  goodErr ? bad(`a valid requisition was refused — ${goodErr.message.slice(0, 70)}`) : ok("a valid requisition raises cleanly");
  if (goodId) {
    madeReqs.push(goodId);
    const { data: row } = await svc.from("ops_requisitions").select("total_amount, status").eq("id", goodId).single();
    Number(row.total_amount) === 5700
      ? ok("the total is the sum of its lines (₦5,700)")
      : bad(`total was ${row.total_amount}, expected 5700`);
    row.status === "pending_approval"
      ? ok("and it starts at pending_approval")
      : bad(`status was ${row.status}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n2. It actually reaches the shared chain");
// ---------------------------------------------------------------------------
{
  const opsClient = await login(ops.email);
  // Genuinely above the tier-1 ceiling (₦100,000) — the point of this section
  // is proving tier 1 CANNOT clear it, so the amount has to actually be out of
  // band, not merely large-sounding.
  const { data: reqId } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-CHAIN`, p_lines: [{ description: "Reaches the chain", amount: 150000 }],
  });
  madeReqs.push(reqId);

  const { error: skipErr } = await svc.from("payment_approvals").insert({
    org_id: poc.id, payable_type: "ops_requisition", payable_id: reqId,
    stage_order: 2, actor_id: auditor.id, actor_role: "viewer", actor_tier: null, amount: 1, decision: "approved",
  });
  skipErr ? ok("stage 2 before stage 1 is refused — the same trigger as vendor payments") : bad("STAGE 2 RECORDED WITH NO STAGE 1");

  await walkChain(reqId, [[1, fm.id]]);
  const { error: selfErr } = await svc.from("payment_approvals").insert({
    org_id: poc.id, payable_type: "ops_requisition", payable_id: reqId,
    stage_order: 2, actor_id: fm.id, actor_role: "viewer", actor_tier: null, amount: 1, decision: "approved",
  });
  selfErr ? ok("separation of duties holds — the FM cannot also audit their own requisition") : bad("ONE PERSON SATISFIED TWO STAGES");

  await walkChain(reqId, [[2, auditor.id]]);
  const { error: tierErr } = await svc.from("payment_approvals").insert({
    org_id: poc.id, payable_type: "ops_requisition", payable_id: reqId,
    stage_order: 3, actor_id: approver1.id, actor_role: "viewer", actor_tier: null, amount: 1, decision: "approved",
  });
  tierErr ? ok("₦50,000 exceeds tier 1 — refused, same ladder as a vendor invoice") : bad("TIER 1 CLEARED AN AMOUNT ABOVE ITS BAND");

  await walkChain(reqId, [[3, approver3.id]]);
  const { data: cleared } = await svc.from("ops_requisitions").select("status, approved_by, approved_at").eq("id", reqId).single();
  cleared.status === "approved" ? ok("clears to approved once stage 3 lands") : bad(`status was ${cleared.status}`);
  cleared.approved_by === approver3.id
    ? ok("and records the stage-3 approver as approved_by")
    : bad(`approved_by was ${cleared.approved_by}`);
}

// ---------------------------------------------------------------------------
console.log("\n3. Amount tampering after approval");
// ---------------------------------------------------------------------------
{
  const opsClient = await login(ops.email);
  const { data: reqId } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-TAMPER`, p_lines: [{ description: "Original amount", amount: 2000 }],
  });
  madeReqs.push(reqId);
  await walkChain(reqId, [[1, fm.id], [2, auditor.id], [3, approver3.id]]);

  const { data: line } = await svc.from("ops_requisition_lines").select("id").eq("requisition_id", reqId).single();
  await svc.from("ops_requisition_lines").insert({
    requisition_id: reqId, org_id: poc.id, line_order: 2, description: "Added after approval", amount: 900000,
  });

  const { data: cleared } = await svc.rpc("is_cleared_for_disbursement", {
    p_payable_type: "ops_requisition", p_payable_id: reqId, p_amount: 902000,
  });
  cleared === false
    ? ok("adding a line after approval invalidates the chain — the total no longer matches what was approved")
    : bad("A LINE ADDED AFTER APPROVAL WAS NOT CAUGHT");
}

// ---------------------------------------------------------------------------
console.log("\n4. A one-off payee — verified, and locked once the chain starts");
// ---------------------------------------------------------------------------
{
  const opsClient = await login(ops.email);
  const { data: reqId } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-PAYEE`, p_lines: [{ description: "Reimburse fuel", amount: 3000 }],
  });
  madeReqs.push(reqId);
  const { data: line } = await svc.from("ops_requisition_lines").select("id").eq("requisition_id", reqId).single();

  const { error: badGateway } = await svc.rpc("save_requisition_line_payee", {
    p_line_id: line.id, p_display_name: "x", p_account_name: "x",
    p_account_number_last4: "0000", p_recipient_code: "",
  });
  badGateway ? ok("an empty recipient code is refused — nothing the gateway didn't actually verify") : bad("AN EMPTY RECIPIENT CODE WAS ACCEPTED");

  const { data: payeeId, error: payeeErr } = await opsClient.rpc("save_requisition_line_payee", {
    p_line_id: line.id, p_display_name: "J. Bello", p_account_name: "J. Bello",
    p_account_number_last4: "5678", p_recipient_code: `RCP_${S}`,
  });
  payeeErr ? bad(`a valid payee was refused — ${payeeErr.message.slice(0, 70)}`) : ok("a valid payee is recorded");
  if (payeeId) madeRecipients.push(payeeId);

  await walkChain(reqId, [[1, fm.id]]);
  const { error: lockedErr } = await opsClient.rpc("save_requisition_line_payee", {
    p_line_id: line.id, p_display_name: "y", p_account_name: "y",
    p_account_number_last4: "1111", p_recipient_code: `RCP2_${S}`,
  });
  lockedErr ? ok("the payee cannot be swapped once the chain has started") : bad("!!! A PAYEE WAS SWAPPED AFTER STAGE 1 APPROVED");
}

// ---------------------------------------------------------------------------
console.log("\n5. Disbursement — per distinct payee, the ledger once, no double-send");
// ---------------------------------------------------------------------------
{
  const { data: vendor } = await svc.from("vendors").insert({ org_id: poc.id, name: `Probe Req Vendor ${S}` }).select("id").single();
  madeVendors.push(vendor.id);
  await svc.from("payout_recipients").insert({
    org_id: poc.id, party: "vendor", vendor_id: vendor.id, display_name: "Probe Req Vendor",
    account_name: "Probe Req Vendor", account_number_last4: "2222", gateway: "paystack",
    recipient_code: `RCPV_${S}`, currency: "NGN", active: true, verified_at: new Date().toISOString(),
  });

  const opsClient = await login(ops.email);
  const { data: reqId } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-DISBURSE`,
    p_lines: [
      { description: "Part A from vendor", amount: 4000, vendorId: vendor.id },
      { description: "Part B from vendor", amount: 2000, vendorId: vendor.id },
      { description: "Reimburse staff", amount: 1500 },
    ],
  });
  madeReqs.push(reqId);
  const { data: lines } = await svc.from("ops_requisition_lines").select("*").eq("requisition_id", reqId);
  const payeeLine = lines.find((l) => !l.vendor_id);
  const { data: payeeId } = await opsClient.rpc("save_requisition_line_payee", {
    p_line_id: payeeLine.id, p_display_name: "Staff Reimbursement", p_account_name: "Staff Reimbursement",
    p_account_number_last4: "3333", p_recipient_code: `RCPP_${S}`,
  });
  madeRecipients.push(payeeId);

  await walkChain(reqId, [[1, fm.id], [2, auditor.id], [3, approver3.id]]);

  const { data: rem1, error: e1 } = await svc.rpc("create_requisition_vendor_remittance", {
    p_requisition_id: reqId, p_vendor_id: vendor.id, p_reference: `REM1-${S}`, p_executed_by: finance.id,
  });
  e1 ? bad(`vendor disbursement refused — ${e1.message.slice(0, 70)}`) : ok("both vendor-tagged lines settle in ONE remittance");
  if (rem1) {
    const { data: r } = await svc.from("remittances").select("net_amount").eq("id", rem1).single();
    Number(r.net_amount) === 6000
      ? ok("for the combined amount of both lines (₦6,000)")
      : bad(`combined remittance was ${r.net_amount}, expected 6000`);
  }

  const { data: rem2, error: e2 } = await svc.rpc("create_requisition_payee_remittance", {
    p_requisition_id: reqId, p_payee_recipient_id: payeeId, p_reference: `REM2-${S}`, p_executed_by: finance.id,
  });
  e2 ? bad(`payee disbursement refused — ${e2.message.slice(0, 70)}`) : ok("the one-off payee settles separately");

  const { data: req } = await svc.from("ops_requisitions").select("payable_entry_id").eq("id", reqId).single();
  const { data: postings } = await svc.from("ledger_postings").select("amount, ledger_accounts(purpose)").eq("entry_id", req.payable_entry_id);
  const fund = postings?.find((p) => p.ledger_accounts?.purpose === "service_charge_fund");
  const payable = postings?.find((p) => p.ledger_accounts?.purpose === "requisition_payable");
  Number(fund?.amount) === 7500 && Number(payable?.amount) === -7500
    ? ok("the accrual posts exactly once, for the FULL ₦7,500 requisition total — not per remittance")
    : bad(`postings were ${JSON.stringify(postings)}`);

  const { error: doubleErr } = await svc.rpc("create_requisition_vendor_remittance", {
    p_requisition_id: reqId, p_vendor_id: vendor.id, p_reference: `REM3-${S}`, p_executed_by: finance.id,
  });
  doubleErr ? ok("a second attempt on already-settled lines is refused") : bad("!!! THE SAME LINES WERE DISBURSED TWICE");

  // Maker-checker: the stage-3 approver cannot also be the one who sends.
  const { data: reqId2 } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-MAKER`, p_lines: [{ description: "Maker-checker probe", amount: 1000, vendorId: vendor.id }],
  });
  madeReqs.push(reqId2);
  await walkChain(reqId2, [[1, fm.id], [2, auditor.id], [3, approver3.id]]);
  const { error: makerErr } = await svc.rpc("create_requisition_vendor_remittance", {
    p_requisition_id: reqId2, p_vendor_id: vendor.id, p_reference: `REM4-${S}`, p_executed_by: approver3.id,
  });
  makerErr
    ? ok("the stage-3 approver cannot also disburse — the widened maker-checker (0152's shape) applies here too")
    : bad("!!! THE APPROVER DISBURSED THEIR OWN APPROVAL");
}

// ---------------------------------------------------------------------------
console.log("\n6. Who can see a requisition — the RLS visibility 0157 taught this suite to check");
// ---------------------------------------------------------------------------
{
  const opsClient = await login(ops.email);
  const { data: reqId } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-VIS`, p_lines: [{ description: "Visibility probe", amount: 1000 }],
  });
  madeReqs.push(reqId);

  const { data: selfRead } = await opsClient.from("ops_requisitions").select("id").eq("id", reqId).maybeSingle();
  selfRead ? ok("the raiser can read their own requisition") : bad("THE RAISER CANNOT SEE WHAT THEY RAISED");

  const { data: fmRead } = await (await login(fm.email)).from("ops_requisitions").select("id").eq("id", reqId).maybeSingle();
  fmRead ? ok("dispatch authority (facility_manager) can see it") : bad("AN FM CANNOT SEE A REQUISITION AWAITING THEIR SIGN-OFF");

  const { data: auditRead } = await (await login(auditor.email)).from("ops_requisitions").select("id").eq("id", reqId).maybeSingle();
  auditRead ? ok("the audit approver can see it — the exact gap 0157 found for vendor payments") : bad("!!! THE AUDIT APPROVER CANNOT SEE A REQUISITION EITHER");

  const { data: approverRead } = await (await login(approver3.email)).from("ops_requisitions").select("id").eq("id", reqId).maybeSingle();
  approverRead ? ok("the tiered approver can see it") : bad("THE APPROVER CANNOT SEE THE REQUISITION THEY ARE ASKED TO CLEAR");

  const { data: financeRead } = await (await login(finance.email)).from("ops_requisitions").select("id").eq("id", reqId).maybeSingle();
  financeRead ? ok("finance can see it (disburses it once cleared)") : bad("FINANCE CANNOT SEE A REQUISITION IT WILL BE ASKED TO SEND");

  if (tenant) {
    const { data: tenantRead } = await (await login(tenant.email)).from("ops_requisitions").select("id").eq("id", reqId).maybeSingle();
    tenantRead === null ? ok("a tenant cannot see it — no operational or financial standing") : bad("!!! A TENANT READ A REQUISITION");
  }

  // Lines follow the parent, same pattern as ticket_attachments (Day 11, 0106).
  const { data: linesRead } = await (await login(auditor.email)).from("ops_requisition_lines").select("id").eq("requisition_id", reqId);
  (linesRead ?? []).length > 0
    ? ok("lines are visible to whoever can see the parent requisition")
    : bad("LINES DID NOT FOLLOW THE PARENT'S VISIBILITY");
}

// ---------------------------------------------------------------------------
console.log("\n7. Cross-org isolation");
// ---------------------------------------------------------------------------
{
  if (!oea) {
    note("no second org seeded — skipped");
  } else {
    const opsClient = await login(ops.email);
    const { data: reqId } = await opsClient.rpc("raise_ops_requisition", {
      p_reference: `REQ-${S}-XORG`, p_lines: [{ description: "Cross-org probe", amount: 1000 }],
    });
    madeReqs.push(reqId);

    const oeaApprover = await pick(oea.id, "payment_approver", 3);
    if (!oeaApprover) {
      note("no tier-3 approver seeded on OEA — skipped");
    } else {
      const { error } = await svc.from("payment_approvals").insert({
        org_id: poc.id, payable_type: "ops_requisition", payable_id: reqId,
        stage_order: 1, actor_id: oeaApprover.id, actor_role: "viewer", actor_tier: null, amount: 1, decision: "approved",
      });
      error ? ok("an approver from another org cannot action this requisition") : bad("!!! A CROSS-ORG APPROVER ACTIONED A REQUISITION");
    }

    const oeaAdmin = await pick(oea.id, "admin");
    if (oeaAdmin) {
      const { data: xread } = await (await login(oeaAdmin.email)).from("ops_requisitions").select("id").eq("id", reqId).maybeSingle();
      xread === null ? ok("and cannot even see it") : bad("!!! A DIFFERENT ORG'S ADMIN READ THIS REQUISITION");
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n8. Append-only");
// ---------------------------------------------------------------------------
{
  const opsClient = await login(ops.email);
  const { data: reqId } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-APPEND`, p_lines: [{ description: "Append-only probe", amount: 1000 }],
  });
  madeReqs.push(reqId);
  await walkChain(reqId, [[1, fm.id]]);

  const { error: updErr } = await svc.from("payment_approvals")
    .update({ decision: "rejected" }).eq("payable_id", reqId).eq("stage_order", 1);
  updErr ? ok("an approval cannot be edited") : bad("A REQUISITION APPROVAL WAS EDITED AFTER THE FACT");

  const { error: delErr } = await svc.from("payment_approvals")
    .delete().eq("payable_id", reqId).eq("stage_order", 1);
  delErr ? ok("an approval cannot be deleted") : bad("A REQUISITION APPROVAL WAS DELETED");
}

// ---------------------------------------------------------------------------
console.log("\n9. Rejection");
// ---------------------------------------------------------------------------
{
  const opsClient = await login(ops.email);
  const { data: reqId } = await opsClient.rpc("raise_ops_requisition", {
    p_reference: `REQ-${S}-REJECT`, p_lines: [{ description: "Will be rejected", amount: 1000 }],
  });
  madeReqs.push(reqId);
  await walkChain(reqId, [[1, fm.id]]);

  const { error: noReason } = await svc.from("payment_approvals").insert({
    org_id: poc.id, payable_type: "ops_requisition", payable_id: reqId,
    stage_order: 2, actor_id: auditor.id, actor_role: "viewer", actor_tier: null, amount: 1,
    decision: "rejected", reason: null,
  });
  noReason ? ok("rejection without a reason is refused") : bad("AN UNEXPLAINED REJECTION WAS ACCEPTED");

  const { error: goodReject } = await svc.from("payment_approvals").insert({
    org_id: poc.id, payable_type: "ops_requisition", payable_id: reqId,
    stage_order: 2, actor_id: auditor.id, actor_role: "viewer", actor_tier: null, amount: 1,
    decision: "rejected", reason: "Receipt does not match the amount claimed",
  });
  goodReject ? bad(`a proper rejection was refused — ${goodReject.message?.slice(0, 60)}`) : ok("rejection with a reason is accepted");

  const { data: rejected } = await svc.from("ops_requisitions").select("status, rejected_reason").eq("id", reqId).single();
  rejected.status === "rejected" ? ok("the requisition itself is marked rejected") : bad(`status was ${rejected.status}`);
  rejected.rejected_reason ? ok("carrying the stated reason") : bad("the reason did not reach the requisition");

  const { error: pastReject } = await svc.from("payment_approvals").insert({
    org_id: poc.id, payable_type: "ops_requisition", payable_id: reqId,
    stage_order: 3, actor_id: approver3.id, actor_role: "viewer", actor_tier: null, amount: 1, decision: "approved",
  });
  pastReject ? ok("cannot proceed past a rejection") : bad("A REJECTED REQUISITION ADVANCED A STAGE");
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
for (const id of madeReqs) await teardown(id).catch(() => {});
for (const id of madeVendors) await svc.from("vendors").delete().eq("id", id);
for (const id of madeRecipients) await svc.from("payout_recipients").delete().eq("id", id);
await svc.from("payout_recipients").delete().like("recipient_code", `RCP%${S}`);

console.log(failures === 0
  ? "\n\x1b[32mAll ops requisition checks passed.\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
