// Rent money: from the tenant, through the ledger, out to the landlord.
//
// The claims that matter:
//   • a rent receipt splits into the landlord's share and the fee, and the
//     split uses the SNAPSHOT on the demand, not a rate read at payment time
//   • the postings sum to the receipt (the ledger balances)
//   • a part payment apportions the fee rather than taking it all first
//   • the fee is taken ONCE — remittance deducts nothing further
//   • collected-but-unremitted is what gets paid out; a merely raised demand
//     pays a landlord money nobody has handed over
//   • the same month cannot be remitted twice
//   • non-rent collections are unchanged
//
// Usage: node scripts/verify-rent-money.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fixtureUser } from "./lib/org-lookup.mjs";

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
const naira = (n) => `₦${Number(n).toLocaleString()}`;

const { data: orgs } = await svc.from("orgs").select("id, slug, management_fee_pct, admin_fee_flat").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { properties: [], units: [], leases: [], intents: [], entries: [] };

// ⚠️ Sweep stray PROBEMONEY-SC rows from any earlier run that died before
// reaching its own cleanup block — same lesson as `scripts/lib/probe-cleanup.mjs`
// for hierarchy nodes and properties, and `verify-fx-collections`'s equivalent
// sweep. Found live: 16 orphaned "Collection — service charge" ledger entries
// (postings already gone, intents already gone, only the entry left) had
// accumulated over several days in `oea`'s journal — each run's OWN cleanup is
// correctly ordered, so every one of those runs must have thrown somewhere
// AFTER section E created and tracked the row but BEFORE reaching the cleanup
// at the bottom. End-of-run cleanup cannot fix the run that needed it most.
{
  const { data: strayEntries } = await svc
    .from("ledger_entries").select("id").ilike("reference", "PROBEMONEY-SC%");
  if (strayEntries?.length) {
    await svc.from("ledger_postings").delete().in("entry_id", strayEntries.map((e) => e.id));
    const { data: strayIntents } = await svc
      .from("payment_intents").select("id").ilike("gateway_reference", "PROBEMONEY-SC%");
    if (strayIntents?.length) await svc.from("payment_intents").delete().in("id", strayIntents.map((i) => i.id));
    await svc.from("ledger_entries").delete().in("id", strayEntries.map((e) => e.id));
    console.log(`  (swept ${strayEntries.length} orphaned ledger entr${strayEntries.length === 1 ? "y" : "ies"} from earlier run(s))`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const prop = (await svc.from("properties")
  .insert({ org_id: oea.id, name: `PROBEMONEY-Property-${S}` }).select("id").single()).data;
made.properties.push(prop.id);
const unit = (await svc.from("units")
  .insert({ org_id: oea.id, property_id: prop.id, label: `Unit ${S}`, apportionment_factor: 1 })
  .select("id").single()).data;
made.units.push(unit.id);

const { data: tenant } = await svc.from("users").select("id").eq("email", "oea.tenant@oegroup.test").single();
const landlord = await fixtureUser(svc, oea.id, "property_owner",
  ["oea.owner@oegroup.test", "oea.propertyowner@oegroup.test"]);
await svc.from("property_stakeholders")
  .insert({ org_id: oea.id, property_id: prop.id, user_id: landlord.id, relation: "owner" });

const lease = (await svc.from("leases").insert({
  org_id: oea.id, property_id: prop.id, unit_id: unit.id, tenant_user_id: tenant.id,
  start_date: "2026-09-01", end_date: "2027-09-01",
  rent_amount: 10_000_000, rent_frequency: "annual", status: "active",
}).select("id").single()).data;
made.leases.push(lease.id);

const RENT = 10_000_000;
const PCT = Number(oea.management_fee_pct);
const FEE = Math.round(RENT * PCT / 100 * 100) / 100;
// ⚠️ The flat admin fee counts too. `record_collection` posts ONE combined
// `fee_income` line (0092) — management + admin together — and OEA carries a
// non-zero `admin_fee_flat` (₦25,000, decision 14: "the admin fee stays an
// org-wide flat placeholder"). A FEE constant that only knows the pct made
// every landlord-share and fee_income comparison below wrong by exactly that
// amount; the product was deducting both and being reported as wrong for it —
// the same defect `verify-remittance-race` already found and fixed.
const ADMIN_FEE = Number(oea.admin_fee_flat ?? 0);
const TOTAL_FEE = FEE + ADMIN_FEE;

console.log("Rent money, from tenant to landlord\n");

console.log("A. A rent receipt splits into the landlord's share and the fee");
let charge, entryId;
{
  const { data: chargeId, error } = await svc.rpc("raise_rent_charge", {
    p_lease_id: lease.id, p_period_start: "2026-09-01", p_period_end: "2027-09-01",
  });
  if (error) { bad(`could not raise the demand — ${error.message.slice(0, 70)}`); }
  charge = (await svc.from("rent_charges").select("*").eq("id", chargeId).single()).data;

  const { data: intentId, error: ie } = await svc.rpc("create_rent_payment_intent", {
    p_rent_charge_id: chargeId,
  });
  ie ? bad(`could not open a payment — ${ie.message.slice(0, 70)}`) : ok("a payment link opens for the demand");
  if (intentId) made.intents.push(intentId);

  // One live link per debt.
  const { error: dup } = await svc.rpc("create_rent_payment_intent", { p_rent_charge_id: chargeId });
  dup ? ok("and a second link for the same debt is refused") : bad("TWO OPEN LINKS FOR ONE DEBT");

  const { data: eId, error: ce } = await svc.rpc("record_collection", {
    p_intent_id: intentId, p_amount_verified: RENT,
  });
  if (ce) bad(`collection failed — ${ce.message.slice(0, 70)}`);
  entryId = eId;
  if (eId) made.entries.push(eId);

  const { data: postings } = await svc
    .from("ledger_postings")
    .select("amount, memo, ledger_accounts(purpose)")
    .eq("entry_id", entryId);

  const byPurpose = {};
  for (const p of postings ?? []) {
    const k = p.ledger_accounts?.purpose ?? "?";
    byPurpose[k] = (byPurpose[k] ?? 0) + Number(p.amount);
  }

  byPurpose.client_funds === RENT
    ? ok(`the bank is debited the full receipt (${naira(RENT)})`)
    : bad(`bank posting was ${byPurpose.client_funds}`);

  byPurpose.fee_income === -TOTAL_FEE
    ? ok(`the fee is credited to fee income (${naira(TOTAL_FEE)}) — it no longer sits in the landlord's balance`)
    : bad(`fee income was ${byPurpose.fee_income}, expected ${-TOTAL_FEE}`);

  byPurpose.landlord_payable === -(RENT - TOTAL_FEE)
    ? ok(`the landlord is a creditor for the NET only (${naira(RENT - TOTAL_FEE)})`)
    : bad(`landlord payable was ${byPurpose.landlord_payable}, expected ${-(RENT - TOTAL_FEE)}`);

  // ⚠️ Postings must EXIST before "sums to zero" means anything — an empty
  // entry sums to zero perfectly. Third time this shape has appeared in this
  // build, so it is asserted explicitly rather than trusted.
  const sum = (postings ?? []).reduce((s, p) => s + Number(p.amount), 0);
  (postings ?? []).length === 3
    ? ok("the receipt produced three postings — bank, landlord, fee")
    : bad(`expected 3 postings, got ${(postings ?? []).length}`);
  (postings ?? []).length > 0 && Math.abs(sum) < 0.005
    ? ok("and they balance to zero")
    : bad(`THE ENTRY DOES NOT BALANCE: ${sum} across ${(postings ?? []).length} posting(s)`);

  const { data: after } = await svc.from("rent_charges").select("status, amount_paid").eq("id", chargeId).single();
  after.status === "paid" && Number(after.amount_paid) === RENT
    ? ok("the demand is marked paid")
    : bad(`demand is ${after.status} with ${after.amount_paid} paid`);
}

console.log("\nB. The snapshot governs, not a rate read at payment time");
{
  // Raise a demand, then move the org rate BEFORE the tenant pays.
  const { data: cid } = await svc.rpc("raise_rent_charge", {
    p_lease_id: lease.id, p_period_start: "2027-09-01", p_period_end: "2028-09-01",
  });
  const snap = (await svc.from("rent_charges")
    .select("management_fee_amount, admin_fee_amount").eq("id", cid).single()).data;
  const snapFee = Number(snap.management_fee_amount) + Number(snap.admin_fee_amount);

  await svc.from("orgs").update({ management_fee_pct: 40 }).eq("id", oea.id);

  const { data: iid } = await svc.rpc("create_rent_payment_intent", { p_rent_charge_id: cid });
  made.intents.push(iid);
  const { data: eid } = await svc.rpc("record_collection", { p_intent_id: iid, p_amount_verified: RENT });
  made.entries.push(eid);

  const { data: postings } = await svc
    .from("ledger_postings").select("amount, ledger_accounts(purpose)").eq("entry_id", eid);
  const fee = (postings ?? []).filter((p) => p.ledger_accounts?.purpose === "fee_income")
    .reduce((s, p) => s + Number(p.amount), 0);

  Math.abs(fee + snapFee) < 0.005
    ? ok(`the fee taken is the snapshot (${naira(snapFee)}), though the org rate is now 40%`)
    : bad(`took ${-fee}, snapshot said ${snapFee}`);

  await svc.from("orgs").update({ management_fee_pct: PCT }).eq("id", oea.id);
}

console.log("\nC. A part payment apportions the fee");
{
  const { data: cid } = await svc.rpc("raise_rent_charge", {
    p_lease_id: lease.id, p_period_start: "2028-09-01", p_period_end: "2029-09-01",
  });
  const { data: iid } = await svc.rpc("create_rent_payment_intent", { p_rent_charge_id: cid });
  made.intents.push(iid);

  const HALF = RENT / 2;
  const { data: eid } = await svc.rpc("record_collection", { p_intent_id: iid, p_amount_verified: HALF });
  made.entries.push(eid);

  const { data: postings } = await svc
    .from("ledger_postings").select("amount, ledger_accounts(purpose)").eq("entry_id", eid);
  const fee = -(postings ?? []).filter((p) => p.ledger_accounts?.purpose === "fee_income")
    .reduce((s, p) => s + Number(p.amount), 0);

  Math.abs(fee - TOTAL_FEE / 2) < 0.01
    ? ok(`half the rent takes half the fee (${naira(fee)}), not the whole of it`)
    : bad(`took ${naira(fee)} on a half payment; the full fee is ${naira(TOTAL_FEE)}`);

  const { data: st } = await svc.from("rent_charges").select("status").eq("id", cid).single();
  st.status === "part_paid" ? ok("and the demand reads part paid") : bad(`status is ${st.status}`);
}

console.log("\nD. The fee is taken once — remittance deducts nothing further");
{
  // A verified bank recipient is required before anything can be paid out.
  const { data: existing } = await svc.from("payout_recipients")
    .select("id").eq("org_id", oea.id).eq("user_id", landlord.id).eq("party", "landlord").maybeSingle();
  if (!existing) {
    // ⚠️ The first draft invented `account_number` and `bank_code`. The table
    // stores `account_number_last4` only — the full number is never held, which
    // is the point of the column's name and its `^[0-9]{4}$` check. The insert
    // failed, the error was not checked, and section D then reported "no
    // verified recipient" as though the FUNCTION were at fault.
    const { error } = await svc.from("payout_recipients").insert({
      org_id: oea.id, party: "landlord", user_id: landlord.id,
      display_name: `Probe Landlord ${S}`,
      account_name: "Probe Landlord", account_number_last4: "0000",
      bank_name: "Probe Bank", recipient_code: `RCP_PROBE_${S}`, active: true,
    });
    if (error) bad(`could not create a payout recipient — ${error.message.slice(0, 80)}`);
  }

  // 0142: a payout records who released it, and only finance may.
  const { data: rentFinanceUser } = await svc.from("users").select("id")
    .eq("org_id", oea.id).eq("role", "finance_approver").is("deactivated_at", null)
    .limit(1).single();

  const { data: remId, error } = await svc.rpc("create_rent_remittance", {
    p_org_id: oea.id, p_landlord_user_id: landlord.id,
    p_property_id: prop.id, p_period: "2026/27", p_executed_by: rentFinanceUser.id,
  });
  if (error) { bad(`remittance failed — ${error.message.slice(0, 80)}`); }
  else {
    const { data: rem } = await svc.from("remittances")
      .select("gross_amount, management_fee, admin_fee, net_amount").eq("id", remId).single();

    Number(rem.management_fee) === 0 && Number(rem.admin_fee) === 0
      ? ok("the remittance deducts no further fee — it was taken at collection")
      : bad(`A SECOND FEE WAS DEDUCTED: mgmt ${rem.management_fee}, admin ${rem.admin_fee}`);

    Number(rem.net_amount) === Number(rem.gross_amount)
      ? ok("so gross and net are the same figure")
      : bad(`gross ${rem.gross_amount} but net ${rem.net_amount}`);

    // Collected only: two full charges (net RENT - TOTAL_FEE each) plus half of
    // the part-paid one (net (RENT - TOTAL_FEE) / 2) — the unpaid remainder must
    // NOT be remitted.
    const expected = (RENT - TOTAL_FEE) * 2 + (RENT - TOTAL_FEE) / 2;
    Math.abs(Number(rem.net_amount) - expected) < 1
      ? ok(`it pays out only what was collected (${naira(rem.net_amount)})`)
      : bad(`paid out ${naira(rem.net_amount)}, expected ${naira(expected)}`);

    // And nothing can be paid twice.
    const { error: again } = await svc.rpc("create_rent_remittance", {
      p_org_id: oea.id, p_landlord_user_id: landlord.id,
      p_property_id: prop.id, p_period: "2026/27", p_executed_by: rentFinanceUser.id,
    });
    again ? ok("and the same rent cannot be remitted twice") : bad("RENT WAS REMITTED TWICE");

    await svc.from("remittances").delete().eq("id", remId);
  }
}

console.log("\nE. Non-rent collections are unchanged");
{
  const { data: intent } = await svc.from("payment_intents").insert({
    org_id: oea.id, purpose: "service_charge", property_id: prop.id,
    amount_expected: 250_000, gateway: "simulated",
    gateway_reference: `PROBEMONEY-SC-${S}`,
  }).select("id").single();
  made.intents.push(intent.id);

  const { data: eid, error } = await svc.rpc("record_collection", {
    p_intent_id: intent.id, p_amount_verified: 250_000,
  });
  if (error) bad(`a service-charge collection failed — ${error.message.slice(0, 70)}`);
  else {
    made.entries.push(eid);
    const { data: postings } = await svc
      .from("ledger_postings").select("amount, ledger_accounts(purpose)").eq("entry_id", eid);
    const purposes = new Set((postings ?? []).map((p) => p.ledger_accounts?.purpose));
    purposes.has("service_charge_fund") && !purposes.has("fee_income")
      ? ok("a service charge still credits its fund whole, with no fee split")
      : bad(`service charge posted to ${[...purposes].join(", ")}`);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("ledger_postings").delete().in("entry_id", made.entries);
await svc.from("payment_intents").delete().in("id", made.intents);
await svc.from("ledger_entries").delete().in("id", made.entries);
await svc.from("rent_charges").delete().in("lease_id", made.leases);
await svc.from("leases").update({ status: "terminated" }).in("id", made.leases);
await svc.from("leases").delete().in("id", made.leases);
await svc.from("payout_recipients").delete().eq("recipient_code", `RCP_PROBE_${S}`);
await svc.from("property_stakeholders").delete().eq("property_id", prop.id);
await svc.from("units").delete().in("id", made.units);
await svc.from("properties").delete().in("id", made.properties);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the fee is taken once, from the snapshot, and the landlord is a creditor for the net."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
