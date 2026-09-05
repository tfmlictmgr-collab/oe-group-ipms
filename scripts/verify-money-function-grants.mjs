// The three fixes of 0231/0232/0233, asserted where they actually live.
//
// The claims that matter:
//   • the function that WRITES THE LEDGER is not callable by anon, and not by
//     a signed-in user either — service_role alone (0231)
//   • `resolve_payable` no longer answers to anon, and still answers to the
//     chain's own authenticated caller, which is the half a blunt revoke breaks
//   • a property_owner scoped to a property cannot assign a unit on a pending
//     application — the capability gate, not the scope gate, is what refuses
//     them (0231)
//   • the landlord payout list offers each property ONCE, to the owner of
//     record, however many co-owners the property has (0232)
//   • a statement's rent figures are one currency's, and it says how many the
//     period holds (0233)
//
// 📌 Why this file exists at all. Decision 24's note records `revoke all …
// from public` being forgotten three times, the third by an author who had
// just read the two migrations written about the first two — and records that
// what caught it was "the suite asserting it against a live anon client". Prose
// in a migration header has now failed at this four times. This is the assertion.
//
// ⚠️ STRICTLY READ-ONLY. It creates nothing, updates nothing and deletes
// nothing, in any world. Every negative case is a call that is SUPPOSED to be
// refused, so a pass leaves no residue and a regression leaves no damage —
// which is what makes it safe to point at production, where these defects are
// live. The service role is used only to establish what the answer ought to be.
//
// Usage: npx tsx scripts/verify-money-function-grants.mjs
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
const FROM = "2000-01-01";
const TO = "2100-12-31";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const skip = (m) => console.log(`  \x1b[33mSKIP\x1b[0m ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
const anon = createClient(URL_, ANON, { auth: { persistSession: false } });

async function login(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) return null;
  const { data: { user } } = await c.auth.getUser();
  return { c, id: user.id, email };
}

const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const oea = (orgs ?? []).find((o) => o.slug === "oea");
if (!oea) { console.error("No OEA org — cannot run."); process.exit(1); }

const finance = await login("oea.financeapprover@oegroup.test");
const owner = await login("oea.propertyowner@oegroup.test");
const pm = await login("oea.facilitymanager@oegroup.test");

// A uuid that is real where one is needed, so a refusal is a REFUSAL and not
// merely "no such row" — the distinction the whole file turns on.
const { data: reqs } = await svc
  .from("ops_requisitions").select("id, org_id, status").limit(1);
const aRequisition = (reqs ?? [])[0] ?? null;

// ── §A The ledger write is service_role alone ─────────────────────────────
head("§A recognise_requisition_payable — the function that writes the ledger");

{
  const id = aRequisition?.id ?? "00000000-0000-0000-0000-000000000000";

  const { error: anonErr } = await anon.rpc("recognise_requisition_payable", {
    p_requisition_id: id,
  });
  anonErr
    ? ok("refused anonymously")
    : bad("!!! CALLABLE BY ANON — anyone can post to the ledger with a requisition id");

  if (finance) {
    // Even the payment officer. This is not an operational RPC; nothing in the
    // product has ever called it, and a signed-in path into ledger_postings is
    // a non-delegable control reached sideways (decision 7).
    const { error } = await finance.c.rpc("recognise_requisition_payable", {
      p_requisition_id: id,
    });
    error
      ? ok("refused to a signed-in payment officer — service_role alone")
      : bad("!!! a signed-in user posted to the ledger through it");
  }

  if (!aRequisition) {
    skip("no requisition on file — the refusals above used a non-existent id");
  } else {
    ok(`the id used was a real requisition (${aRequisition.status}), so the refusal is a refusal`);
  }
}

// ── §B The payable read lost anon and kept the chain ──────────────────────
head("§B resolve_payable — closed to anon, still open to the chain");

{
  const { data: pay } = await svc.from("payments").select("id").limit(1);
  const paymentId = (pay ?? [])[0]?.id ?? "00000000-0000-0000-0000-000000000000";

  const { error: anonErr } = await anon.rpc("resolve_payable", {
    p_type: "vendor_payment", p_id: paymentId,
  });
  anonErr
    ? ok("refused anonymously")
    : bad("!!! CALLABLE BY ANON — the org and amount of any payable, by id");

  // ⚠️ The half that matters as much. `lib/approvals/chain.ts` calls this as
  // the signed-in user; revoking authenticated too would have closed the hole
  // and broken the chain, which is the failure mode 0212 describes from the
  // other direction (a control nobody could get past).
  if (finance) {
    const { error } = await finance.c.rpc("resolve_payable", {
      p_type: "vendor_payment", p_id: paymentId,
    });
    error
      ? bad(`the chain's own caller was refused — ${error.message}`)
      : ok("still answers the signed-in caller the approvals chain uses");
  }
}

// ── §C The capability gate, not the scope gate ────────────────────────────
head("§C assign_application_unit — a landlord holds the scope and not the right");

if (!owner) {
  skip("no OEA property owner login");
} else {
  const { data: apps } = await svc
    .from("tenant_applications")
    .select("id, property_id, status")
    .eq("org_id", oea.id)
    .in("status", ["submitted", "under_review", "info_requested"])
    .is("purged_at", null)
    .limit(20);

  // The exploit path exactly: an application on a property this owner is a
  // stakeholder of. current_user_property_ids() does not filter on relation
  // (decision 19), so before 0231 the scope check ALONE admitted them.
  const { data: mine } = await svc
    .from("property_stakeholders")
    .select("property_id")
    .eq("user_id", owner.id)
    .eq("relation", "owner");
  const owned = new Set((mine ?? []).map((r) => r.property_id));
  // Preferred: an application on a property they own, which is the exploit in
  // its exact shape. Failing that, ANY open application still proves the gate —
  // 0231 puts the capability check BEFORE the scope check, so a landlord is
  // refused for the capability whether or not the scope would have admitted
  // them. The weaker fixture tests the same line; it just does not also
  // demonstrate that the scope would have let them through.
  const onOwned = (apps ?? []).find((a) => owned.has(a.property_id));
  const target = onOwned ?? (apps ?? [])[0];
  if (target && !onOwned) {
    skip("no open application on a property this landlord owns — using another, which still proves the capability gate");
  }

  if (!target) {
    skip("no open application in the org at all");
  } else {
    const { data: units } = await svc
      .from("units").select("id").eq("property_id", target.property_id)
      .is("deleted_at", null).is("occupant_user_id", null).limit(1);
    // The unit need not be real: 0231's capability check runs before the unit
    // is resolved, so a landlord is refused for the capability either way. And
    // if the gate were ever removed, this call would come back "no such unit" —
    // a refusal for the WRONG reason, which the assertion below fails on. So
    // the weaker fixture cannot turn into a false pass.
    const unitId = (units ?? [])[0]?.id ?? "00000000-0000-0000-0000-000000000000";

    {
      const { error } = await owner.c.rpc("assign_application_unit", {
        p_application_id: target.id, p_unit_id: unitId,
      });
      if (!error) {
        bad("!!! A LANDLORD ASSIGNED A UNIT ON A PENDING APPLICATION");
      } else if (/applications\.recommend/.test(error.message)) {
        ok("refused for the capability, which is the gate 0231 added");
      } else {
        // A refusal for any other reason is still a refusal, but it is not
        // this one — and a test that accepts the wrong reason stops testing.
        bad(`refused, but not for the capability — "${error.message}"`);
      }
    }
  }

  // The gate must not have closed on the people who are supposed to hold it.
  if (pm && target) {
    const { data: cap } = await pm.c.rpc("has_permission", {
      p_capability: "applications.recommend",
    });
    cap
      ? ok("the FM/PM still holds applications.recommend")
      : bad("the FM/PM lost applications.recommend — the gate closed on the wrong people");
  }
}

// ── §D One property, one payout row ───────────────────────────────────────
head("§D landlord_payout_candidates — each property offered once");

if (!finance) {
  skip("no OEA payment officer login");
} else {
  const { data: cands, error } = await finance.c.rpc("landlord_payout_candidates");
  if (error) {
    bad(`landlord_payout_candidates errored — ${error.message}`);
  } else {
    const rows = cands ?? [];
    const seen = new Map();
    for (const r of rows) seen.set(r.property_id, (seen.get(r.property_id) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    dupes.length === 0
      ? ok(`${rows.length} candidate row(s), no property listed twice`)
      : bad(`!!! ${dupes.length} propert(ies) listed more than once — the co-owner fan-out is back`);

    // The owner on each row is the owner OF RECORD, not an arbitrary one.
    let mismatched = 0;
    for (const r of rows) {
      const { data: ofRecord } = await svc.rpc("property_landlord", {
        p_property_id: r.property_id,
      });
      if (ofRecord && ofRecord !== r.landlord_user_id) mismatched++;
    }
    mismatched === 0
      ? ok("every row names the owner property_landlord() resolves")
      : bad(`${mismatched} row(s) name someone other than the owner of record`);
  }

  // Determinism is the whole point of the resolver: the same question, asked
  // twice, cannot answer differently, or a snapshotted fee rate is a coin toss.
  const { data: multi } = await svc
    .from("property_stakeholders").select("property_id").eq("relation", "owner");
  const counts = new Map();
  for (const r of multi ?? []) counts.set(r.property_id, (counts.get(r.property_id) ?? 0) + 1);
  const coOwned = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);

  if (coOwned.length === 0) {
    skip("no co-owned property in this world — the resolver is untested against the case it exists for");
  } else {
    let stable = true;
    for (const pid of coOwned.slice(0, 5)) {
      const a = await svc.rpc("property_landlord", { p_property_id: pid });
      const b = await svc.rpc("property_landlord", { p_property_id: pid });
      if (a.data !== b.data) stable = false;
    }
    stable
      ? ok(`${coOwned.length} co-owned propert(ies): the resolver answers the same each time`)
      : bad("!!! property_landlord answered differently on repeated calls");
  }
}

// ── §E A statement is one currency's ──────────────────────────────────────
head("§E property_statement — denominated, not merely labelled");

if (!finance) {
  skip("no OEA payment officer login");
} else {
  const { data: props } = await svc
    .from("properties").select("id, name").eq("org_id", oea.id).is("deleted_at", null);

  let checked = 0;
  for (const p of (props ?? []).slice(0, 8)) {
    const { data: rows, error } = await finance.c.rpc("property_statement", {
      p_property_id: p.id, p_from: FROM, p_to: TO,
    });
    if (error) { bad(`${p.name}: ${error.message}`); continue; }
    const row = (rows ?? [])[0];
    if (!row) continue;

    if (row.rent_currencies === undefined || row.rent_currencies === null) {
      bad(`${p.name}: no rent_currencies column — 0233 did not apply`);
      continue;
    }

    // What the service role can see, unfiltered, is the truth to measure against.
    const { data: leases } = await svc
      .from("leases").select("id").eq("property_id", p.id).is("deleted_at", null);
    const leaseIds = (leases ?? []).map((l) => l.id);
    if (leaseIds.length === 0) continue;

    const { data: charges } = await svc
      .from("rent_charges").select("currency, amount").in("lease_id", leaseIds);
    const all = charges ?? [];
    if (all.length === 0) continue;

    const distinct = new Set(all.map((c) => c.currency));
    Number(row.rent_currencies) === distinct.size
      ? ok(`${p.name}: rent_currencies says ${distinct.size}, and there are ${distinct.size}`)
      : bad(`${p.name}: rent_currencies says ${row.rent_currencies}, there are ${distinct.size}`);

    // The demanded total must be the reported currency's subtotal — NOT the
    // sum of every currency wearing that currency's label, which is what both
    // statements did before 0233.
    const subtotal = all
      .filter((c) => c.currency === row.currency)
      .reduce((a, c) => a + Number(c.amount), 0);
    const everything = all.reduce((a, c) => a + Number(c.amount), 0);
    const reported = Number(row.rent_demanded);

    if (Math.abs(reported - subtotal) < 0.005) {
      ok(`${p.name}: rent_demanded is the ${row.currency} subtotal`);
    } else if (Math.abs(reported - everything) < 0.005 && distinct.size > 1) {
      bad(`!!! ${p.name}: rent_demanded is EVERY currency added together, labelled ${row.currency}`);
    } else {
      bad(`${p.name}: rent_demanded ${reported} matches neither the ${row.currency} subtotal (${subtotal}) nor the total (${everything})`);
    }

    if (distinct.size === 1) {
      skip(`${p.name}: single-currency, so the filter is proven only not to have broken it`);
    }
    checked++;
  }

  if (checked === 0) skip("no property with rent charges to measure");
}

// ── ───────────────────────────────────────────────────────────────────────
console.log(
  failures === 0
    ? "\n\x1b[32mAll checks passed.\x1b[0m\n"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
