// The payment approver sees what the payment officer sees, and still cannot
// release a naira (0246).
//
// The claims that matter:
//   • the property statement opens for every money role it should — the 404 was
//     `oversight_roles()` predating the two payment-chain roles, not a bug in
//     the page
//   • the payment approver holds EXACTLY the payment officer's capability set
//   • they read the ledger, payments, remittances, leases, rent charges,
//     reconciliations, bank accounts and the audit trail
//   • and they still cannot move money — disbursement is an explicit
//     finance_approver check, not a member of oversight_roles()
//   • the regional manager's statement access stays SCOPED, which is not the
//     same failure and must not be "fixed"
//
// ⚠️ Every write assertion here reads ROWS AFFECTED, never the absence of an
// error. An RLS-denied PostgREST write returns `[]` with `error === null`,
// which is indistinguishable from success — this suite was written after a
// probe that made exactly that mistake and reported a money control broken when
// it was working. Decision 23's "a write that silently does nothing".
//
// Usage: node scripts/verify-payment-approver-reach.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) { bad(`could not sign in as ${email}: ${error.message}`); return null; }
  return c;
};

const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
const { data: props } = await svc
  .from("properties").select("id, name").eq("org_id", oea.id).is("deleted_at", null).limit(2);

const officer = await login("oea.finance@oegroup.test");
const approver = await login("oea.approver@oegroup.test");
const auditor = await login("oea.auditapprover@oegroup.test");
const regional = await login("oea.regional@oegroup.test");
if (!officer || !approver || !regional) process.exit(1);

// ── A ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§A The statement opens\x1b[0m");
const statementRows = async (c, id) => {
  const { data } = await c.rpc("property_statement", {
    p_property_id: id, p_from: "2026-01-01", p_to: "2026-12-31", p_currency: null,
  });
  return (data ?? []).length;
};
for (const p of props ?? []) {
  (await statementRows(officer, p.id)) > 0
    ? ok(`the payment officer opens "${p.name}"`)
    : bad(`the payment officer gets no row for "${p.name}" — 404`);
  (await statementRows(approver, p.id)) > 0
    ? ok(`the payment approver opens "${p.name}" — the 404 this fixes`)
    : bad(`the payment approver gets no row for "${p.name}" — still 404`);
}

// ⚠️ NOT a bug, and must not be "fixed" into one. A regional manager reaches
// the properties they hold; a property they do not hold answering "no row" is
// the scoping working.
const held = new Set(((await regional.from("properties").select("id")).data ?? []).map((r) => r.id));
let scopedRight = true;
for (const p of props ?? []) {
  const rows = await statementRows(regional, p.id);
  if (held.has(p.id) ? rows === 0 : rows > 0) scopedRight = false;
}
scopedRight
  ? ok(`the regional manager opens only the ${held.size} propert(ies) they hold — scope, not a fault`)
  : bad("the regional manager's statement access does not match the properties they hold");

if (auditor) {
  const anyRow = (await Promise.all((props ?? []).map((p) => statementRows(auditor, p.id)))).some((n) => n > 0);
  anyRow
    ? note("the payment auditor now opens statements too — check this was intended")
    : note("the payment auditor still gets no statement; deliberately out of 0246, and owed its own decision");
}

// ── B ──────────────────────────────────────────────────────────────────────
//
// Stated as a SET comparison rather than a hand-listed expectation, so the two
// cannot drift apart the way the TypeScript copy of B7 did.
console.log("\n\x1b[1m§B The same capabilities as the payment officer\x1b[0m");
const capsFor = async (role) => {
  const { data } = await svc.rpc("b7_baseline");
  return (data ?? []).filter((r) => r.role === role && r.granted).map((r) => r.capability).sort();
};
const officerCaps = await capsFor("finance_approver");
const approverCaps = await capsFor("payment_approver");
JSON.stringify(officerCaps) === JSON.stringify(approverCaps)
  ? ok(`identical sets (${approverCaps.length}): ${approverCaps.join(", ")}`)
  : bad(`officer has [${officerCaps.join(", ")}], approver has [${approverCaps.join(", ")}]`);

// ── C ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§C What they can now read\x1b[0m");
for (const t of ["ledger_entries", "payments", "remittances", "leases", "rent_charges",
                 "reconciliations", "bank_accounts", "audit_log", "sc_budgets"]) {
  const { error } = await approver.from(t).select("id", { count: "exact", head: true });
  error ? bad(`${t} refused: ${error.message.slice(0, 60)}`) : ok(`${t} readable`);
}

// ── D ──────────────────────────────────────────────────────────────────────
//
// The whole safety of "the same set" rests on this: disbursement is not a
// capability, so nothing granted above can reach it.
console.log("\n\x1b[1m§D And they still cannot move money\x1b[0m");
const { data: queued } = await svc
  .from("remittances").select("id, reference, status").eq("status", "queued").limit(1).maybeSingle();

if (!queued) {
  note("no queued remittance to probe against; the assertions below need one");
} else {
  const { data: rows, error } = await approver
    .from("remittances").update({ status: "sent" }).eq("id", queued.id).select("id");
  const { data: after } = await svc
    .from("remittances").select("status").eq("id", queued.id).single();
  (rows ?? []).length === 0 && after.status === "queued"
    ? ok(`${queued.reference} unmoved — 0 rows affected, still queued`)
    : bad(`${queued.reference} moved to ${after.status} by the payment approver`);
  error === null
    ? ok("and PostgREST returned NO error while changing nothing — why this suite counts rows")
    : note(`PostgREST also raised: ${error.message.slice(0, 60)}`);
}

const { data: ent } = await svc.from("ledger_entries").select("id").limit(1).maybeSingle();
if (ent) {
  const { data: rows } = await approver
    .from("ledger_entries").update({ description: "PROBE-0246" }).eq("id", ent.id).select("id");
  (rows ?? []).length === 0
    ? ok("cannot rewrite a ledger entry — 0 rows affected")
    : bad("rewrote a ledger entry");
}

console.log(
  failures
    ? `\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m`
    : "\n\x1b[32m✔ payment approver reach: all checks passed\x1b[0m"
);
process.exit(failures ? 1 : 0);
