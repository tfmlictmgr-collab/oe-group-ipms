// The tiered, multi-stage approval chain (0151/0152).
//
// ⚠️ What this suite is really for. Before it, there were two ways money left
// this system and only one of them had a gate: a vendor invoice for a light
// fitting climbed verification, a KPI check, approval and a threshold
// escalation, while a landlord's entire collected rent for a property could be
// released by one finance approver acting alone. Section 9 is that gap.
//
// Verified by ATTEMPTING each refused operation, never by reading a policy or a
// grant table — reading grants is what produced the "68 tables writable by
// anon" false alarm on this project.
//
// The tier boundaries (section 1) are six cases and not one: an off-by-one at a
// band edge routes a ₦1,000,000 payment to the wrong approver, and inclusive
// bounds are exactly where that error lives.
//
// Usage: node scripts/verify-approval-chain.mjs
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "ProbePassw0rd!";

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
const eq = (m, actual, expected) =>
  String(actual) === String(expected) ? ok(m) : bad(`${m} — expected ${expected}, got ${actual}`);

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Tier bands, in NAIRA. Every money column in this schema is numeric(14,2);
// a second unit at a financial boundary is how a x100 error gets written.
const T1 = 100000;    // tier 1 ceiling
const T2 = 1000000;   // tier 2 ceiling

const { data: orgs, error: orgErr } = await svc
  .from("orgs").select("id, slug").is("deleted_at", null);
if (orgErr) { console.error("db unreachable:", orgErr.message); process.exit(1); }

const org = orgs.find((o) => o.slug === "oe-group-foundation-poc");
const otherOrg = orgs.find((o) => o.slug === "tfml") ?? orgs.find((o) => o.id !== org?.id);
if (!org) { console.error("POC org not seeded."); process.exit(2); }

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeUsers = [];
const madePayments = [];
const madeVendors = [];

// Start-of-run sweep — end-of-run cleanup cannot repair end-of-run cleanup.
//
// ⚠️ Does NOT attempt to delete `payment_approvals`. It cannot be done by
// anyone (`trg_approvals_append_only`, 0151) and the attempt is what made both
// this sweep and the teardown below no-ops for every run before this one: the
// delete failed, the user delete then failed on the foreign key, supabase-js
// returned both errors rather than throwing, and nothing read either. An
// account that authored an approval is deactivated instead — see the teardown.
{
  const { data: stale } = await svc.from("users").select("id").like("email", "probechain.%@oegroup.test");
  for (const u of stale ?? []) {
    const { error } = await svc.from("users").delete().eq("id", u.id);
    if (!error) {
      await svc.auth.admin.deleteUser(u.id).catch(() => {});
    } else {
      await svc.from("users")
        .update({ deactivated_at: new Date().toISOString() })
        .eq("id", u.id)
        .is("deactivated_at", null);
    }
  }
  const { data: staleV } = await svc.from("vendors").select("id").like("name", "Probe Chain%");
  for (const v of staleV ?? []) {
    await svc.from("payments").delete().eq("vendor_id", v.id);
    await svc.from("vendors").delete().eq("id", v.id);
  }

  // ⚠️ Section 9's fixture was never swept, by this block or by the teardown.
  //
  // It creates a `Probe Chain Property <S>` and a `Probe Landlord <S>` payout
  // recipient on every run and removes neither, so they accumulate — seven of
  // each had built up on staging by 27 Aug. Two suites away, that turned into
  // failures nobody would connect to this file:
  //
  //   * `seed-org-logins.mjs` picks which property to withhold from the demo
  //     manager out of the org's property list; seven phantom properties made
  //     it pick one of those, the manager kept Victoria Court, and
  //     `verify-access-matrix` reported three money-scoping failures.
  //   * `verify-asset-import-e2e` looks for a property the manager does NOT
  //     manage and found none.
  //
  // A remittance points at both, and `remittances` is a record of money
  // moving, so nothing here deletes a row a remittance names — the recipient
  // is DEACTIVATED instead, which frees the partial unique index on
  // (org_id, user_id) while the payout keeps the destination it named.
  const { data: staleR } = await svc.from("payout_recipients")
    .select("id, active").like("recipient_code", "RCP_PROBE_%");
  for (const r of staleR ?? []) {
    const { count } = await svc.from("remittances")
      .select("id", { count: "exact", head: true }).eq("recipient_id", r.id);
    if ((count ?? 0) > 0) {
      if (r.active) await svc.from("payout_recipients").update({ active: false }).eq("id", r.id);
    } else {
      await svc.from("payout_recipients").delete().eq("id", r.id);
    }
  }

  const { data: staleP } = await svc.from("properties")
    .select("id").like("name", "Probe Chain Property%");
  for (const p of staleP ?? []) {
    await svc.from("property_stakeholders").delete().eq("property_id", p.id);
    const { error } = await svc.from("properties").delete().eq("id", p.id);
    // A property a remittance names cannot go; soft-delete keeps it out of
    // every picker and every list, which is all the sweep needs.
    if (error) {
      await svc.from("properties")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", p.id).is("deleted_at", null);
    }
  }
}

async function makeUser(orgId, role, tag, tier = null) {
  const email = `probechain.${tag}.${S}@oegroup.test`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message}`);
  const { error: uErr } = await svc.from("users").upsert({
    id: created.user.id, org_id: orgId, email, full_name: `Probe ${tag}`, role, approval_tier: tier,
  });
  if (uErr) throw new Error(`${tag}: ${uErr.message}`);
  madeUsers.push(created.user.id);
  return { id: created.user.id, email, role, tier };
}

const { data: vendor, error: vErr } = await svc.from("vendors")
  .insert({ org_id: org.id, name: `Probe Chain Vendor ${S}`, service_category: "cleaning" })
  .select("id").single();
if (vErr) { console.error("vendor fixture:", vErr.message); process.exit(1); }
madeVendors.push(vendor.id);

const mkPayment = async (amount, status = "recommended") => {
  const { data, error } = await svc.from("payments").insert({
    org_id: org.id, vendor_id: vendor.id, amount, status,
    invoice_reference: `PROBE-${S}-${Math.random().toString(36).slice(2, 7)}`,
    service_verified_at: new Date().toISOString(), performance_validated: true,
  }).select("id, amount").single();
  if (error) throw new Error(`payment ${amount}: ${error.message}`);
  madePayments.push(data.id);
  return data.id;
};

/** Record a stage decision AS a given person. Returns the error, or null. */
const decide = async (payableId, actor, stage, decision = "approved", reason = null, type = "vendor_payment") => {
  const { error } = await svc.from("payment_approvals").insert({
    org_id: org.id, payable_type: type, payable_id: payableId, stage_order: stage,
    actor_id: actor.id, actor_role: actor.role, actor_tier: actor.tier,
    amount: 1, decision, reason,
  });
  return error;
};

const cleared = async (payableId, amount, type = "vendor_payment") => {
  const { data } = await svc.rpc("is_cleared_for_disbursement", {
    p_payable_type: type, p_payable_id: payableId, p_amount: amount,
  });
  return data;
};

// ── Cast ───────────────────────────────────────────────────────────────────
const fm        = await makeUser(org.id, "facility_manager", "fm");
const fm2       = await makeUser(org.id, "facility_manager", "fm2");
const auditor   = await makeUser(org.id, "payment_audit_approver", "auditor");
const auditor2  = await makeUser(org.id, "payment_audit_approver", "auditor2");
const tier1     = await makeUser(org.id, "payment_approver", "tier1", 1);
const tier2     = await makeUser(org.id, "payment_approver", "tier2", 2);
const tier3     = await makeUser(org.id, "payment_approver", "tier3", 3);
const md        = await makeUser(org.id, "executive", "md");
const admin     = await makeUser(org.id, "admin", "admin");
const finance   = await makeUser(org.id, "finance_approver", "finance");
const crossOrg  = otherOrg ? await makeUser(otherOrg.id, "payment_approver", "crossorg", 3) : null;

console.log("\nApproval chain (0151/0152)\n");

// ---------------------------------------------------------------------------
console.log("1. Tier ladder — the six boundary cases");
// ---------------------------------------------------------------------------
{
  const tierFor = async (amount) => {
    const { data, error } = await svc.rpc("resolve_required_tier", { p_org_id: org.id, p_amount: amount });
    if (error) throw new Error(error.message);
    return data;
  };
  eq("₦99,999.99 → tier 1", await tierFor(T1 - 0.01), 1);
  eq("₦100,000.00 → tier 1 (inclusive)", await tierFor(T1), 1);
  eq("₦100,000.01 → tier 2", await tierFor(T1 + 0.01), 2);
  eq("₦999,999.99 → tier 2", await tierFor(T2 - 0.01), 2);
  eq("₦1,000,000.00 → tier 2 (inclusive)", await tierFor(T2), 2);
  eq("₦1,000,000.01 → tier 3", await tierFor(T2 + 0.01), 3);
}

// ---------------------------------------------------------------------------
console.log("\n2. Stage ordering");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(T1);
  (await decide(p, auditor, 2)) ? ok("stage 2 before stage 1 is refused") : bad("STAGE 2 RECORDED WITH NO STAGE 1");
  (await decide(p, tier1, 3)) ? ok("stage 3 before stages 1–2 is refused") : bad("STAGE 3 RECORDED WITH NO EARLIER STAGES");

  const e1 = await decide(p, fm, 1);
  e1 ? bad(`stage 1 by the FM was refused — ${e1.message.slice(0, 60)}`) : ok("stage 1 by the FM is accepted");
  const e2 = await decide(p, auditor, 2);
  e2 ? bad(`stage 2 by the auditor was refused — ${e2.message.slice(0, 60)}`) : ok("stage 2 by the auditor is accepted");

  // One decision per stage, ever.
  (await decide(p, auditor2, 2)) ? ok("a stage cannot be decided twice") : bad("A STAGE WAS DECIDED TWICE");
}

// ---------------------------------------------------------------------------
console.log("\n3. Who may action which stage");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(T1);
  (await decide(p, auditor, 1)) ? ok("the auditor cannot sign off the job (stage 1)") : bad("AUDITOR ACTIONED STAGE 1");
  (await decide(p, finance, 1)) ? ok("finance cannot record stage 1") : bad("FINANCE RECORDED AN APPROVAL STAGE");
  await decide(p, fm, 1);
  (await decide(p, finance, 2)) ? ok("finance cannot record stage 2") : bad("FINANCE RECORDED AN APPROVAL STAGE");
  await decide(p, auditor, 2);
  (await decide(p, finance, 3)) ? ok("finance cannot give final approval") : bad("FINANCE GAVE FINAL APPROVAL");
  (await decide(p, fm2, 3)) ? ok("an FM cannot give final approval") : bad("AN FM GAVE FINAL APPROVAL");
}

// ---------------------------------------------------------------------------
console.log("\n4. Tier enforcement at final approval");
// ---------------------------------------------------------------------------
{
  // At the bound — tier 1 may approve exactly ₦100,000.
  const a = await mkPayment(T1);
  await decide(a, fm, 1); await decide(a, auditor, 2);
  const e = await decide(a, tier1, 3);
  e ? bad(`tier 1 refused at the bound — ${e.message.slice(0, 60)}`) : ok("tier 1 approves exactly ₦100,000");

  // One kobo over — tier 1 must not.
  const b = await mkPayment(T1 + 0.01);
  await decide(b, fm, 1); await decide(b, auditor, 2);
  (await decide(b, tier1, 3)) ? ok("tier 1 CANNOT approve ₦100,000.01") : bad("TIER 1 APPROVED ABOVE ITS BAND");
  const e2 = await decide(b, tier2, 3);
  e2 ? bad(`tier 2 refused — ${e2.message.slice(0, 60)}`) : ok("tier 2 approves ₦100,000.01");

  // Above the top band.
  const c = await mkPayment(T2 + 0.01);
  await decide(c, fm, 1); await decide(c, auditor, 2);
  (await decide(c, tier2, 3)) ? ok("tier 2 CANNOT approve above ₦1,000,000") : bad("TIER 2 APPROVED ABOVE ITS BAND");
  (await decide(c, admin, 3)) ? ok("an administrator CANNOT approve above the threshold (decision 16)") : bad("ADMIN APPROVED ABOVE THE THRESHOLD");
  const e3 = await decide(c, md, 3);
  e3 ? bad(`the MD was refused — ${e3.message.slice(0, 60)}`) : ok("the MD approves above ₦1,000,000 (decision 9)");

  // A ladder that blocks the MD from a small payment is broken: >= not =.
  const d = await mkPayment(50000);
  await decide(d, fm, 1); await decide(d, auditor, 2);
  const e4 = await decide(d, md, 3);
  e4 ? bad(`the MD could not approve a small amount — ${e4.message.slice(0, 60)}`)
     : ok("the MD may approve a small amount (>= not =)");

  // An administrator within the threshold — decision 16, the other half.
  const f = await mkPayment(500000);
  await decide(f, fm, 1); await decide(f, auditor, 2);
  const e5 = await decide(f, admin, 3);
  e5 ? bad(`an admin was refused within the threshold — ${e5.message.slice(0, 60)}`)
     : ok("an administrator approves within the threshold");
}

// ---------------------------------------------------------------------------
console.log("\n5. The amount cannot be chosen by the caller");
// ---------------------------------------------------------------------------
{
  // The attack on a tiered ladder: claim a small amount to select a low tier.
  const p = await mkPayment(T2 + 0.01);   // genuinely needs tier 3
  await decide(p, fm, 1); await decide(p, auditor, 2);

  const { error } = await svc.from("payment_approvals").insert({
    org_id: org.id, payable_type: "vendor_payment", payable_id: p, stage_order: 3,
    actor_id: tier1.id, actor_role: "payment_approver", actor_tier: 1,
    amount: 1000,           // a lie, chosen to fall in tier 1
    decision: "approved",
  });
  error ? ok("a client-supplied amount cannot select a lower tier") : bad("A FORGED AMOUNT SELECTED A LOWER TIER");

  // And the role/tier on the row are read from the actor, not the insert.
  const q = await mkPayment(T1);
  await decide(q, fm, 1); await decide(q, auditor, 2);
  await svc.from("payment_approvals").insert({
    org_id: org.id, payable_type: "vendor_payment", payable_id: q, stage_order: 3,
    actor_id: tier1.id, actor_role: "executive", actor_tier: 3,   // both lies
    amount: 999999, decision: "approved",
  });
  const { data: row } = await svc.from("payment_approvals")
    .select("actor_role, actor_tier, amount").eq("payable_id", q).eq("stage_order", 3).maybeSingle();
  row?.actor_role === "payment_approver" && Number(row?.actor_tier) === 1
    ? ok("the actor's role and tier are read from their record, not the insert")
    : bad(`role/tier were taken from the insert: ${row?.actor_role}/${row?.actor_tier}`);
  Number(row?.amount) === T1
    ? ok("the amount is re-read from the payable")
    : bad(`amount was taken from the insert: ${row?.amount}`);
}

// ---------------------------------------------------------------------------
console.log("\n6. Separation of duties");
// ---------------------------------------------------------------------------
{
  // The admin holds stage-3 authority; give them stage 1 first and they must
  // not also close stage 3. Holding two roles does not make you two people.
  const p = await mkPayment(T1);
  await decide(p, fm, 1);
  await decide(p, auditor, 2);
  const e = await decide(p, fm, 3);
  e ? ok("the same human cannot satisfy two stages") : bad("ONE HUMAN SATISFIED TWO STAGES");

  // Even where the role would otherwise fit.
  const q = await mkPayment(500000);
  await decide(q, fm, 1);
  await decide(q, auditor, 2);
  await decide(q, admin, 3);
  const { data: n } = await svc.from("payment_approvals")
    .select("actor_id").eq("payable_id", q);
  new Set((n ?? []).map((r) => r.actor_id)).size === (n ?? []).length
    ? ok("every stage on a payable has a distinct actor")
    : bad("A PAYABLE HAS TWO STAGES BY THE SAME PERSON");
}

// ---------------------------------------------------------------------------
console.log("\n7. Amount tampering after approval");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(T1);
  await decide(p, fm, 1); await decide(p, auditor, 2); await decide(p, tier1, 3);
  eq("cleared for disbursement at the approved amount", await cleared(p, T1), true);

  // Raise it across two band boundaries after the fact.
  await svc.from("payments").update({ amount: T2 + 0.01 }).eq("id", p);
  eq("NOT cleared after an upward amount edit", await cleared(p, T2 + 0.01), false);

  const { error } = await svc.rpc("assert_chain_cleared", {
    p_type: "vendor_payment", p_id: p, p_amount: T2 + 0.01,
  });
  /changed after it was approved/i.test(error?.message ?? "")
    ? ok("and the refusal says the amount changed, not merely 'not cleared'")
    : bad(`unhelpful or missing refusal: ${error?.message ?? "none"}`);

  // Putting it back restores the chain — the approvals were never invalid, the
  // amount was.
  await svc.from("payments").update({ amount: T1 }).eq("id", p);
  eq("cleared again once the amount is restored", await cleared(p, T1), true);
}

// ---------------------------------------------------------------------------
console.log("\n7b. Climbing the chain a second time (0175)");
// ---------------------------------------------------------------------------
//
// ⚠️ Section 7 proves an amount edit INVALIDATES the chain. This proves the
// other half, which was missing until 0175 and is the half that decides whether
// a payment can ever be paid: that the chain can then be climbed AGAIN.
//
// Before 0175 it could not. `unique (payable_type, payable_id, stage_order)`
// allowed one row per stage for all time, the append-only trigger refused every
// UPDATE, and the UI's `nextStage` was null because every stage already held a
// decision. The payable sat announcing "every stage has to be approved again"
// with nothing in the product or the database able to do it — permanently
// unapprovable and, for a landlord payout or requisition, with the money already
// claimed.
{
  const p = await mkPayment(T1);
  await decide(p, fm, 1); await decide(p, auditor, 2); await decide(p, tier1, 3);
  eq("round one clears", await cleared(p, T1), true);

  // Across two band boundaries, so the new figure needs a more senior approver
  // than the tier-1 who signed the old one.
  const raised = T2 + 0.01;
  await svc.from("payments").update({ amount: raised }).eq("id", p);

  const e1 = await decide(p, fm, 1);
  e1 ? bad(`stage 1 could not be re-approved — ${e1.message.slice(0, 80)}`)
     : ok("stage 1 can be re-approved at the new amount");

  // The whole previous round is retired, not merely the stage just re-signed:
  // otherwise a re-signed stage 1 would carry two stale signatures to
  // disbursement.
  const { data: rows } = await svc.from("payment_approvals")
    .select("stage_order, amount, superseded_at").eq("payable_id", p);
  const live = (rows ?? []).filter((r) => r.superseded_at === null);
  const dead = (rows ?? []).filter((r) => r.superseded_at !== null);
  eq("only the new stage 1 is live", live.length, 1);
  eq("and the previous round is retained, not deleted", dead.length, 3);

  // No standing on retired signatures to reach the top.
  const skip = await decide(p, tier3, 3);
  skip ? ok("stage 3 is refused while stage 2 of the new round is unsigned")
       : bad("STAGE 3 RECORDED OVER A RETIRED STAGE 2");

  // The new figure is above the tier-1 ceiling, so the tier-1 who cleared round
  // one may not clear round two.
  await decide(p, auditor2, 2);
  const tooSmall = await decide(p, tier1, 3);
  tooSmall ? ok("the tier-1 who cleared round one cannot clear the raised amount")
           : bad("A TIER-1 APPROVED ABOVE THEIR CEILING ON A SECOND ROUND");

  const e3 = await decide(p, tier3, 3);
  e3 ? bad(`stage 3 by tier 3 was refused — ${e3.message.slice(0, 80)}`)
     : ok("a tier-3 approver completes the second round");

  eq("cleared at the NEW amount", await cleared(p, raised), true);
  eq("and NOT cleared at the old one", await cleared(p, T1), false);

  // ⚠️ The reason `is_cleared_for_disbursement` also tests `superseded_at`.
  // Round one's rows match T1 on amount; if staleness were judged by amount
  // alone, restoring the figure would resurrect a round that was invalidated.
  await svc.from("payments").update({ amount: T1 }).eq("id", p);
  eq("a RETIRED round is not revived by restoring its amount", await cleared(p, T1), false);
  await svc.from("payments").update({ amount: raised }).eq("id", p);

  // Append-only still means append-only: supersession is one permitted shape,
  // not a general licence to write to this table.
  const { error: edit } = await svc.from("payment_approvals")
    .update({ reason: "tampered" }).eq("payable_id", p).is("superseded_at", null);
  edit ? ok("an approval record still cannot be edited")
       : bad("AN APPROVAL RECORD WAS EDITED");

  const { error: del } = await svc.from("payment_approvals")
    .delete().eq("payable_id", p);
  del ? ok("an approval record still cannot be deleted")
      : bad("AN APPROVAL RECORD WAS DELETED");

  const { error: smuggle } = await svc.from("payment_approvals")
    .update({ superseded_at: new Date().toISOString(), amount: 1 })
    .eq("payable_id", p).is("superseded_at", null).eq("stage_order", 1);
  smuggle ? ok("superseding cannot smuggle in another change")
          : bad("SUPERSEDING ALTERED THE RECORD OF A DECISION");
}

// ---------------------------------------------------------------------------
console.log("\n7c. A refusal is terminal, and an amount edit does not clear it");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(T1);
  await decide(p, fm, 1, "rejected", "the invoice total does not match the job card");

  await svc.from("payments").update({ amount: T1 + 1 }).eq("id", p);

  const { error: sup } = await svc.from("payment_approvals")
    .update({ superseded_at: new Date().toISOString() })
    .eq("payable_id", p).eq("decision", "rejected");
  sup ? ok("a refusal cannot be superseded")
      : bad("A REFUSAL WAS SUPERSEDED");

  const again = await decide(p, fm2, 1);
  again ? ok("and the payable cannot be re-approved by nudging the amount")
        : bad("A REFUSAL WAS ESCAPED BY CHANGING THE AMOUNT");
}

// ---------------------------------------------------------------------------
console.log("\n8. Rejection");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(T1);
  await decide(p, fm, 1);
  (await decide(p, auditor, 2, "rejected", null)) ? ok("rejection without a reason is refused") : bad("AN UNEXPLAINED REJECTION WAS ACCEPTED");
  (await decide(p, auditor, 2, "rejected", "too short")) ? ok("a token reason is refused") : bad("A TOKEN REJECTION REASON WAS ACCEPTED");

  const e = await decide(p, auditor, 2, "rejected", "Invoice does not match the job card");
  e ? bad(`a proper rejection was refused — ${e.message.slice(0, 60)}`) : ok("rejection with a reason is accepted");

  (await decide(p, tier1, 3)) ? ok("cannot proceed past a rejection") : bad("A REJECTED PAYMENT ADVANCED A STAGE");
  eq("a rejected payable is not cleared", await cleared(p, T1), false);

  const { data: pay } = await svc.from("payments").select("status, rejected_reason").eq("id", p).single();
  eq("the payment itself is marked rejected", pay?.status, "rejected");
  pay?.rejected_reason ? ok("with the reason carried onto the payment") : bad("the reason did not reach the payment");
}

// ---------------------------------------------------------------------------
console.log("\n9. Landlord payouts climb the same ladder (the gap 0151 closed)");
// ---------------------------------------------------------------------------
{
  const { data: prop } = await svc.from("properties")
    .insert({ org_id: org.id, name: `Probe Chain Property ${S}` }).select("id").single();
  const { data: recip } = await svc.from("payout_recipients").insert({
    org_id: org.id, party: "landlord", user_id: finance.id,
    display_name: `Probe Landlord ${S}`, recipient_code: `RCP_PROBE_${S}`, active: true,
  }).select("id").single();

  if (!prop || !recip) {
    bad("could not build the landlord payout fixture");
  } else {
    const { data: rem, error: remErr } = await svc.from("remittances").insert({
      org_id: org.id, party: "landlord", recipient_id: recip.id, property_id: prop.id,
      period: "2026-08", reference: `PROBE-REM-${S}`,
      gross_amount: 750000, management_fee: 0, admin_fee: 0, net_amount: 750000,
      status: "queued", created_by: finance.id,
    }).select("id, net_amount").single();

    // ⚠️ The error is REPORTED, not discarded. This read `const { data: rem }`
    // and then failed with a bare "could not create the probe remittance",
    // which says a remittance was not made and nothing about why -- the same
    // class of finding 0180 recorded against sweepProbeVendors ("a routine
    // that reports a count it never verified"). A suite that cannot say what
    // refused it costs an hour every time it goes red.
    if (!rem) { bad(`could not create the probe remittance: ${remErr?.message ?? "no error returned"}`); }
    else {
      eq("a freshly raised payout is NOT cleared to send", await cleared(rem.id, 750000, "landlord_payout"), false);

      const { error: sendErr } = await svc.rpc("claim_remittance_for_sending", {
        p_id: rem.id, p_sent_by: finance.id,
      });
      sendErr ? ok(`sending it unapproved is refused — ${sendErr.message.replace(/^.*?:\s*/, "").slice(0, 58)}`)
              : bad("AN UNAPPROVED LANDLORD PAYOUT WAS SENT");

      await decide(rem.id, fm, 1, "approved", null, "landlord_payout");
      await decide(rem.id, auditor, 2, "approved", null, "landlord_payout");

      const { error: stillErr } = await svc.rpc("claim_remittance_for_sending", {
        p_id: rem.id, p_sent_by: finance.id,
      });
      stillErr ? ok("two of three stages is still refused") : bad("A PARTIALLY APPROVED PAYOUT WAS SENT");

      // ₦750,000 sits in tier 2.
      (await decide(rem.id, tier1, 3, "approved", null, "landlord_payout"))
        ? ok("tier 1 cannot clear a ₦750,000 payout") : bad("TIER 1 CLEARED A TIER-2 PAYOUT");

      const e = await decide(rem.id, tier2, 3, "approved", null, "landlord_payout");
      e ? bad(`tier 2 was refused — ${e.message.slice(0, 60)}`) : ok("tier 2 gives final approval");

      eq("now cleared to send", await cleared(rem.id, 750000, "landlord_payout"), true);

      // …but not by someone who approved it.
      const { error: selfErr } = await svc.rpc("claim_remittance_for_sending", {
        p_id: rem.id, p_sent_by: tier2.id,
      });
      selfErr ? ok("the approver still cannot be the sender") : bad("THE APPROVER SENT THE PAYOUT");

      const { error: goErr } = await svc.rpc("claim_remittance_for_sending", {
        p_id: rem.id, p_sent_by: finance.id,
      });
      goErr ? bad(`finance was refused a cleared payout — ${goErr.message.slice(0, 60)}`)
            : ok("finance sends it once the chain is complete");

      const { data: sent } = await svc.from("remittances").select("sent_by, status").eq("id", rem.id).single();
      sent?.sent_by === finance.id ? ok("and who released it is recorded") : bad("sent_by was not recorded");

      await svc.from("payment_approvals").delete().eq("payable_id", rem.id);
      await svc.from("remittances").delete().eq("id", rem.id);
      await svc.from("payout_recipients").delete().eq("id", recip.id);
      await svc.from("properties").delete().eq("id", prop.id);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n10. Append-only");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(T1);
  await decide(p, fm, 1);
  const { error: uErr } = await svc.from("payment_approvals")
    .update({ decision: "rejected", reason: "changed my mind about this one" })
    .eq("payable_id", p).eq("stage_order", 1);
  uErr ? ok("an approval cannot be updated") : bad("AN APPROVAL WAS EDITED AFTER THE FACT");

  const { error: dErr } = await svc.from("payment_approvals")
    .delete().eq("payable_id", p).eq("stage_order", 1);
  dErr ? ok("an approval cannot be deleted") : bad("AN APPROVAL WAS DELETED");
}

// ---------------------------------------------------------------------------
console.log("\n11. Cross-org isolation");
// ---------------------------------------------------------------------------
{
  if (!crossOrg) {
    console.log("  – skipped: only one org seeded");
  } else {
    const p = await mkPayment(T1);
    await decide(p, fm, 1); await decide(p, auditor, 2);
    const e = await decide(p, crossOrg, 3);
    e ? ok("an approver from another org cannot action this payable") : bad("A CROSS-ORG APPROVER ACTIONED A PAYABLE");
  }
}

// ---------------------------------------------------------------------------
console.log("\n12. The status machine no longer takes approval on trust");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(T1);
  // A direct flip to `approved` with no chain at all. Service-role writes are
  // exempt from the transition trigger by design, so this asserts through the
  // gate function the trigger itself calls.
  eq("an unapproved payment is not cleared", await cleared(p, T1), false);

  const { error } = await svc.rpc("assert_chain_cleared", {
    p_type: "vendor_payment", p_id: p, p_amount: T1,
  });
  /0 of 3|only 0/.test(error?.message ?? "")
    ? ok("and the refusal names how far it actually got")
    : bad(`unhelpful refusal: ${error?.message ?? "none"}`);

  // The chain completing is what moves the payment, not a role flipping it.
  await decide(p, fm, 1); await decide(p, auditor, 2); await decide(p, tier1, 3);
  const { data: pay } = await svc.from("payments").select("status, approved_by").eq("id", p).single();
  eq("completing the chain marks the payment approved", pay?.status, "approved");
  eq("and records the stage-3 approver as the approver", pay?.approved_by, tier1.id);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
// ⚠️ `payment_approvals` CANNOT be deleted — not by the service role, not by
// anyone. `trg_approvals_append_only` (0151) fires on DELETE regardless of the
// caller's role, which is the whole point: "a decision is never deleted".
//
// This teardown used to try anyway. supabase-js RETURNS the error rather than
// throwing it, and nothing here read it, so every run silently failed to clean
// up, then silently failed to delete the users those approvals reference (FK),
// and left the whole cast behind. Seventy probe accounts had accumulated before
// anyone looked — found only because a network outage made the teardown noisy
// enough to notice.
//
// So: delete what genuinely can be deleted, and DEACTIVATE the rest. That is
// the same answer `seed-org-logins.mjs` reached for the same reason — an
// account that has done anything cannot be erased without orphaning the record
// of what it did, and every picker filters `deactivated_at is null`, so a
// deactivated probe disappears from the product without breaking the trail.
for (const id of madePayments) {
  await svc.from("payments").delete().eq("id", id);
}
for (const id of madeVendors) await svc.from("vendors").delete().eq("id", id);

let hardDeleted = 0;
let deactivated = 0;
for (const id of madeUsers) {
  const { error } = await svc.from("users").delete().eq("id", id);
  if (!error) {
    await svc.auth.admin.deleteUser(id).catch(() => {});
    hardDeleted++;
    continue;
  }
  // Referenced by an append-only approval — deactivate instead of leaving it
  // active and pretending the cleanup worked.
  const { error: deErr } = await svc
    .from("users")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("id", id)
    .is("deactivated_at", null);
  if (!deErr) deactivated++;
}
console.log(
  `\ncleanup: ${hardDeleted} probe account(s) removed, ${deactivated} deactivated ` +
    `(they authored append-only approvals and cannot be erased)`
);

console.log(failures === 0
  ? "\n\x1b[32mAll approval chain checks passed.\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
