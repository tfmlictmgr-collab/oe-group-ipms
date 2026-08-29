// The OEA approval chain — decision 23 (board, 28 Aug 2026).
//
//     requester → AUDIT review/approval → MP (executive) → PAYMENT APPROVER
//                                                        → PAYMENT OFFICER
//
// ⚠️ What this suite is really for. `verify-approval-chain.mjs` exercises the
// STANDARD ladder against the POC org and would pass unchanged if the OEA
// reshape had never been applied — its org is `direct`, and 0211 made the chain
// per-organisation. A suite that never runs against the brand whose rules
// changed proves nothing about them. This is the OEA half, and it asserts the
// two things that are genuinely different: the FM/PM is NOT a rung, and the MP
// is on EVERY payment rather than only above the threshold.
//
// It also covers the control the whole reshape rests on: `orgs.delivery_brand`
// selects the ladder now, so an administrator who could edit it could put
// themselves back into stage 3. Section 6 attempts exactly that, as a real
// signed-in administrator, and requires it to fail.
//
// Every refusal is verified by ATTEMPTING the operation, never by reading a
// policy or a grant table — reading grants is what produced the "68 tables
// writable by anon" false alarm on this project.
//
// Usage: node scripts/verify-oea-payment-chain.mjs
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

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

const T2 = 1000000; // tier 2 ceiling — the old "above the threshold" line

const { data: orgs, error: orgErr } = await svc
  .from("orgs").select("id, slug, delivery_brand").is("deleted_at", null);
if (orgErr) { console.error("db unreachable:", orgErr.message); process.exit(1); }

const oea = orgs.find((o) => o.delivery_brand === "OEA");
const tfml = orgs.find((o) => o.delivery_brand === "TFML");
if (!oea) { console.error("No OEA-branded org is seeded — nothing to verify."); process.exit(2); }

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeUsers = [];
const madeVendors = [];

// Start-of-run sweep — end-of-run cleanup cannot repair end-of-run cleanup.
// Deliberately does NOT attempt to delete `payment_approvals`: it cannot be
// done by anyone (0175's guard), and the attempt is what silently made the
// teardown in the sibling suite a no-op for every run before it was fixed.
{
  const { data: stale } = await svc.from("users").select("id").like("email", "probeoea.%@oegroup.test");
  for (const u of stale ?? []) {
    const { error } = await svc.from("users").delete().eq("id", u.id);
    if (!error) await svc.auth.admin.deleteUser(u.id).catch(() => {});
    else await svc.from("users")
      .update({ deactivated_at: new Date().toISOString() })
      .eq("id", u.id).is("deactivated_at", null);
  }
  const { data: staleV } = await svc.from("vendors").select("id").like("name", "Probe OEA%");
  for (const v of staleV ?? []) {
    await svc.from("payments").delete().eq("vendor_id", v.id);
    await svc.from("vendors").delete().eq("id", v.id);
  }
}

async function makeUser(orgId, role, tag, tier = null) {
  const email = `probeoea.${tag}.${S}@oegroup.test`;
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
  .insert({ org_id: oea.id, name: `Probe OEA Vendor ${S}`, service_category: "cleaning" })
  .select("id").single();
if (vErr) { console.error("vendor fixture:", vErr.message); process.exit(1); }
madeVendors.push(vendor.id);

const madePayments = [];
const mkPayment = async (amount) => {
  // `service_verified_at` + `performance_validated` ARE the FM/PM job sign-off
  // that decision 23 makes the precondition of the chain. A payment reaches
  // `recommended` only through them, which is why the FM is absent from the
  // ladder without being absent from the process.
  const { data, error } = await svc.from("payments").insert({
    org_id: oea.id, vendor_id: vendor.id, amount, status: "recommended",
    invoice_reference: `POEA-${S}-${Math.random().toString(36).slice(2, 7)}`,
    service_verified_at: new Date().toISOString(), performance_validated: true,
  }).select("id").single();
  if (error) throw new Error(`payment ${amount}: ${error.message}`);
  madePayments.push(data.id);
  return data.id;
};

/** Record a stage decision AS a given person. Returns the error, or null. */
const decide = async (payableId, actor, stage, decision = "approved", reason = null) => {
  const { error } = await svc.from("payment_approvals").insert({
    org_id: oea.id, payable_type: "vendor_payment", payable_id: payableId, stage_order: stage,
    actor_id: actor.id, actor_role: actor.role, actor_tier: actor.tier,
    amount: 1, decision, reason,
  });
  return error;
};

const cleared = async (payableId, amount) => {
  const { data } = await svc.rpc("is_cleared_for_disbursement", {
    p_payable_type: "vendor_payment", p_payable_id: payableId, p_amount: amount,
  });
  return data;
};

// ── Cast ───────────────────────────────────────────────────────────────────
const fm      = await makeUser(oea.id, "facility_manager", "fm");
const pm      = await makeUser(oea.id, "property_manager", "pm");
const auditor = await makeUser(oea.id, "payment_audit_approver", "auditor");
const md      = await makeUser(oea.id, "executive", "md");
const md2     = await makeUser(oea.id, "executive", "md2");
const tier2   = await makeUser(oea.id, "payment_approver", "tier2", 2);
const tier3   = await makeUser(oea.id, "payment_approver", "tier3", 3);
const admin   = await makeUser(oea.id, "admin", "admin");
const officer = await makeUser(oea.id, "finance_approver", "officer");

console.log("\nOEA payment chain — decision 23\n");

// ---------------------------------------------------------------------------
console.log("1. The organisation climbs the OEA ladder");
// ---------------------------------------------------------------------------
{
  const { data: shape } = await svc.rpc("org_payment_chain", { p_org_id: oea.id });
  eq("OEA resolves to the 'oea' chain", shape, "oea");

  if (tfml) {
    const { data: other } = await svc.rpc("org_payment_chain", { p_org_id: tfml.id });
    eq("TFML still resolves to 'standard'", other, "standard");
  }

  const { data: stages } = await svc.rpc("payment_chain_stages", { p_org_id: oea.id });
  const byOrder = (stages ?? []).sort((a, b) => a.stage_order - b.stage_order);
  eq("three stages", byOrder.length, 3);
  eq("stage 1 is the audit", String(byOrder[0]?.required_roles), "payment_audit_approver");
  eq("stage 2 is the MP", String(byOrder[1]?.required_roles), "executive");
  eq("stage 3 is the payment approver", String(byOrder[2]?.required_roles), "payment_approver");
  eq("only stage 3 is tier-resolved", String(byOrder.map((s) => s.tier_resolved)), "false,false,true");
}

// ---------------------------------------------------------------------------
console.log("\n2. FM/PM sign off the job; they are not a rung of the ladder");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(250000);

  // ⚠️ THE CHANGE. On the standard ladder this is stage 1 and succeeds.
  (await decide(p, fm, 1))
    ? ok("a facilities manager cannot action OEA stage 1")
    : bad("AN FM ACTIONED AN OEA APPROVAL STAGE");
  (await decide(p, pm, 1))
    ? ok("a properties manager cannot action OEA stage 1")
    : bad("A PM ACTIONED AN OEA APPROVAL STAGE");

  // The job sign-off itself is still real, and still theirs — it is the
  // precondition, carried on the payment rather than on the ladder.
  const { data: pay } = await svc.from("payments")
    .select("service_verified_at, performance_validated, status").eq("id", p).single();
  pay?.service_verified_at && pay?.performance_validated && pay.status === "recommended"
    ? ok("the job sign-off is what put the payment in the chain")
    : bad("A PAYMENT REACHED THE CHAIN WITHOUT VERIFICATION");

  const e = await decide(p, auditor, 1);
  e ? bad(`the auditor was refused at stage 1 — ${e.message.slice(0, 70)}`)
    : ok("stage 1 by the auditor is accepted");
}

// ---------------------------------------------------------------------------
console.log("\n3. The MP approves EVERY payment, not only large ones");
// ---------------------------------------------------------------------------
{
  // ₦50,000 — far below tier 1's ceiling. Under decision 9 the executive was
  // only required above the threshold; decision 23 puts them on every payment.
  const small = await mkPayment(50000);
  await decide(small, auditor, 1);

  (await decide(small, tier3, 3))
    ? ok("stage 3 cannot be reached before the MP has approved (₦50,000)")
    : bad("A SMALL PAYMENT SKIPPED THE MP");

  const e = await decide(small, md, 2);
  e ? bad(`the MP was refused on a small payment — ${e.message.slice(0, 70)}`)
    : ok("the MP approves a ₦50,000 payment");

  const e2 = await decide(small, tier2, 3);
  e2 ? bad(`the approver was refused after the MP — ${e2.message.slice(0, 70)}`)
     : ok("the payment approver then gives final approval");

  (await cleared(small, 50000))
    ? ok("the chain is complete and cleared for disbursement")
    : bad("A FULLY APPROVED PAYMENT IS NOT CLEARED");
}

// ---------------------------------------------------------------------------
console.log("\n4. Who may not action a stage");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(500000);

  // ⚠️ Decision 23: "admin not part of money approval". Attempted at all three.
  (await decide(p, admin, 1)) ? ok("an administrator cannot action stage 1") : bad("ADMIN ACTIONED STAGE 1");
  await decide(p, auditor, 1);
  (await decide(p, admin, 2)) ? ok("an administrator cannot action stage 2") : bad("ADMIN ACTIONED STAGE 2");
  await decide(p, md, 2);
  (await decide(p, admin, 3)) ? ok("an administrator cannot give final approval") : bad("ADMIN GAVE FINAL APPROVAL");

  // The payment officer releases; they approve nothing.
  (await decide(p, officer, 3)) ? ok("the payment officer cannot give final approval") : bad("THE PAYMENT OFFICER APPROVED A PAYMENT");

  // The MP is stage 2 and cannot also be stage 3 — separation of duties, and
  // the role is not at that stage on this ladder in any case.
  (await decide(p, md2, 3)) ? ok("an executive cannot give final approval on OEA") : bad("AN EXECUTIVE ACTIONED OEA STAGE 3");

  const e = await decide(p, tier2, 3);
  e ? bad(`the tier-2 approver was refused — ${e.message.slice(0, 70)}`)
    : ok("the payment approver completes the chain");
}

// ---------------------------------------------------------------------------
console.log("\n5. The tier still binds at final approval");
// ---------------------------------------------------------------------------
{
  const big = await mkPayment(T2 + 0.01);   // above tier 2's ceiling
  await decide(big, auditor, 1);
  await decide(big, md, 2);

  (await decide(big, tier2, 3))
    ? ok("tier 2 cannot clear above ₦1,000,000")
    : bad("TIER 2 CLEARED ABOVE ITS BAND");

  // 📌 The config gap the board accepted: with the executive at stage 2 they
  // cannot also clear stage 3, so an OEA org needs a tier-3 approver of its
  // own. This asserts the gap is real and is closed by APPOINTING one.
  const e = await decide(big, tier3, 3);
  e ? bad(`the tier-3 approver was refused — ${e.message.slice(0, 70)}`)
    : ok("a tier-3 payment approver clears it (the appointed-approver answer)");
}

// ---------------------------------------------------------------------------
console.log("\n6. The brand — and so the ladder — cannot be edited from inside");
// ---------------------------------------------------------------------------
{
  // ⚠️ The control the reshape rests on. Before 0211 `delivery_brand` was in
  // the `authenticated` UPDATE allowlist (0083c), so an administrator could
  // have moved their own org to TFML and walked back into stage 3.
  const asAdmin = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: signInErr } = await asAdmin.auth.signInWithPassword({ email: admin.email, password: PW });
  if (signInErr) {
    bad(`could not sign in as the administrator — ${signInErr.message}`);
  } else {
    const { error } = await asAdmin.from("orgs")
      .update({ delivery_brand: "TFML" }).eq("id", oea.id);

    const { data: after } = await svc.from("orgs")
      .select("delivery_brand").eq("id", oea.id).single();

    // Either a refusal or a silent no-op is acceptable; what is NOT acceptable
    // is the value having moved. The row is what this asserts on.
    after?.delivery_brand === "OEA"
      ? ok(`an administrator cannot change their org's brand${error ? " (refused)" : " (no-op)"}`)
      : bad("AN ADMINISTRATOR CHANGED delivery_brand — THE APPROVAL LADDER IS EDITABLE FROM INSIDE THE ORG");

    await asAdmin.auth.signOut();
  }
}

// ---------------------------------------------------------------------------
console.log("\n7. Nobody sends what the chain has not cleared");
// ---------------------------------------------------------------------------
{
  const p = await mkPayment(300000);
  await decide(p, auditor, 1);

  const { error: e1 } = await svc.rpc("assert_chain_cleared", {
    p_type: "vendor_payment", p_id: p, p_amount: 300000,
  });
  e1 ? ok(`a part-approved payment refuses at send — ${e1.message.slice(0, 58)}`)
     : bad("A PART-APPROVED PAYMENT WAS CLEARED TO SEND");

  await decide(p, md, 2);
  await decide(p, tier2, 3);

  const { error: e2 } = await svc.rpc("assert_chain_cleared", {
    p_type: "vendor_payment", p_id: p, p_amount: 300000,
  });
  e2 ? bad(`a fully approved payment was refused — ${e2.message.slice(0, 70)}`)
     : ok("a fully approved payment is clear to send");

  // 0142/0175's maker-checker, on the OEA ladder: the approver may not release.
  const { error: e3 } = await svc.rpc("create_vendor_remittance", {
    p_payment_id: p, p_reference: `POEA-REM-${S}`, p_executed_by: tier2.id,
  });
  e3 ? ok("the approver cannot also release the money") : bad("THE APPROVER RELEASED THE PAYMENT THEY APPROVED");
}

// ---------------------------------------------------------------------------
console.log("");
console.log("8. The chain can see what it is approving, and who approved it");
// ---------------------------------------------------------------------------
//
// ⚠️ Reported from the demo: the requisition's details "didn't surface on the
// audit approver role and other finance approvers". Two separate causes, both
// asserted here as a real signed-in user rather than read off a policy.
{
  const asUserClient = async (email) => {
    const c = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error } = await c.auth.signInWithPassword({ email, password: PW });
    return error ? null : c;
  };

  // A. THE AUDIT TRAIL COULD NOT NAME ANYONE. `users_select` gated on
  //    `oversight_roles_with_fm()` (0072a), written before 0151 created these
  //    two roles — so they could read ONE row, their own, and every stage on
  //    the trail rendered "Approved by someone no longer listed" to the very
  //    person whose stage exists to check it. 0157 fixed the same omission for
  //    payments and remittances; `users` is reached by an EMBED, so it failed
  //    as a wrong sentence rather than an empty screen. Fixed in 0222.
  for (const who of [auditor, tier2]) {
    const c = await asUserClient(who.email);
    if (!c) { bad(`could not sign in as ${who.role}`); continue; }
    const { data: seen } = await c.from("users").select("id").eq("org_id", oea.id);
    (seen?.length ?? 0) > 1
      ? ok(`${who.role} can name the people on the trail (${seen.length} rows)`)
      : bad(`${who.role} READS ONLY ${seen?.length ?? 0} USER ROW(S) — the audit trail cannot name who approved`);
    await c.auth.signOut();
  }

  // B. THE EVIDENCE ITSELF. A requisition's invoice lives in the same bucket a
  //    vendor invoice scan does, and 0140's read policy joined `payments` and
  //    nothing else until 0217 — so it was readable by nobody. Asserted against
  //    a REAL attachment where the org has one; skipped honestly where it does
  //    not, rather than passing on an empty set.
  const { data: withInvoice } = await svc
    .from("ops_requisitions")
    .select("id, invoice_attachment_path")
    .eq("org_id", oea.id)
    .not("invoice_attachment_path", "is", null)
    .limit(1)
    .maybeSingle();

  if (!withInvoice) {
    console.log("  [33mNOTE[0m no requisition on this org carries an invoice — B not exercised");
  } else {
    for (const who of [auditor, tier2, officer]) {
      const c = await asUserClient(who.email);
      if (!c) { bad(`could not sign in as ${who.role}`); continue; }
      const { data: req } = await c.from("ops_requisitions").select("id, total_amount")
        .eq("id", withInvoice.id).maybeSingle();
      const { data: lines } = await c.from("ops_requisition_lines").select("id, description, amount")
        .eq("requisition_id", withInvoice.id);
      const { data: sig } = await c.storage.from("invoice-attachments")
        .createSignedUrl(withInvoice.invoice_attachment_path, 60);
      req && (lines?.length ?? 0) > 0 && sig?.signedUrl
        ? ok(`${who.role} reads the requisition, its ${lines.length} line(s) and its invoice`)
        : bad(`${who.role} is missing part of what they approve — requisition=${Boolean(req)} lines=${lines?.length ?? 0} invoice=${Boolean(sig?.signedUrl)}`);
      await c.auth.signOut();
    }
  }
}

// ── Teardown ───────────────────────────────────────────────────────────────
//
// An account that authored an approval CANNOT be deleted — `payment_approvals`
// is append-only and the foreign key holds. Those are deactivated instead,
// which is the honest outcome: the decision stays attributable for ever, and
// the account cannot be used again.
{
  for (const id of madePayments) await svc.from("payments").delete().eq("id", id);
  for (const id of madeVendors) await svc.from("vendors").delete().eq("id", id);

  let removed = 0, deactivated = 0;
  for (const id of madeUsers) {
    const { error } = await svc.from("users").delete().eq("id", id);
    if (!error) {
      await svc.auth.admin.deleteUser(id).catch(() => {});
      removed++;
    } else {
      await svc.from("users")
        .update({ deactivated_at: new Date().toISOString() })
        .eq("id", id).is("deactivated_at", null);
      deactivated++;
    }
  }
  console.log(`\ncleanup: ${removed} probe account(s) removed, ${deactivated} deactivated (they authored append-only approvals and cannot be erased)`);
}

if (failures > 0) {
  console.log(`\n\x1b[31m${failures} check(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log("\n\x1b[32mAll OEA payment chain checks passed.\x1b[0m");
