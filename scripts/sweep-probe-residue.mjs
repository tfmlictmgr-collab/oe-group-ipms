// Sweeps the fixtures that verification suites leave behind when they crash.
//
// ⚠️ Why this exists as a STANDALONE script, when scripts/lib/probe-cleanup.mjs
// already sweeps at the start of each suite: that sweep only runs for the suite
// that owns the prefix, and only when that suite is next run. A suite that is
// retired, renamed, or simply not run again leaves its fixtures forever — and
// four of them have now been found in front of a user (a Region dropdown, the
// public tenancy application page, the analytics contractor filter, and the
// brand pickers). This is the broom for everything at once.
//
// Dry run by default. `--apply` deletes. `--env <file>` picks the world.
//
// Usage: node scripts/sweep-probe-residue.mjs [--apply] [--env .env.dev.local]
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  sweepProbeNodes, sweepProbeProperties, sweepProbeVendors, sweepProbeApplications,
} from "./lib/probe-cleanup.mjs";

const apply = process.argv.includes("--apply");
const envArg = process.argv.indexOf("--env");
const envFile = envArg > -1 ? process.argv[envArg + 1] : ".env.local";
config({ path: path.join(process.cwd(), envFile) });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const NAME_PREFIXES = ["PROBE", "Probe ", "Perm probe"];
const EMAIL_PREFIX = "probe";
const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };

console.log(`\nProbe residue — ${apply ? c.r("APPLY") : c.g("DRY RUN")}  ·  ${envFile}`);
console.log(c.d(`  ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`));

async function byName(table, col = "name", extra = "") {
  const found = new Map();
  for (const p of NAME_PREFIXES) {
    const { data, error } = await svc.from(table).select(`id,${col}${extra}`).ilike(col, `${p}%`);
    if (error) { console.log(`  ${c.r("ERR")} ${table}: ${error.message}`); return []; }
    for (const r of data ?? []) found.set(r.id, r);
  }
  return [...found.values()];
}

// ── What is there ────────────────────────────────────────────────────────────
const orgs = await byName("orgs", "name", ",deleted_at,slug");
const props = await byName("properties");
const vendors = await byName("vendors");
const nodes = await byName("org_nodes", "name", ",path,level");
const apps = await byName("tenant_applications", "applicant_name");
const { data: probeUsers } = await svc.from("users")
  .select("id,email,org_id,deactivated_at").ilike("email", `${EMAIL_PREFIX}%`);

// ⚠️ Bank accounts do not follow the pattern above, twice over: the column is
// `label`, not `name`, and suites write the marker MID-STRING — `Operating
// (probe 1H86PS)` — so a prefix match finds nothing. A leftover survived the
// first full sweep of staging for exactly that reason, and was the only row in
// `bank_accounts` on the whole world.
//
// A bank account is not swept on its name alone. It must ALSO be unconfigured
// in every respect — no bank, no account name, no last four, no ledger link, no
// opening entry — because "probe" appearing in a label somebody typed is not
// permission to delete the account the client's money sits in. Anything
// carrying real configuration is listed and left.
const { data: labelled } = await svc.from("bank_accounts")
  .select("id,label,bank_name,account_name,account_number_last4,ledger_account_id,opening_entry_id,purpose,currency")
  .ilike("label", "%probe%");
const bankUnconfigured = (labelled ?? []).filter((b) =>
  !b.bank_name && !b.account_name && !b.account_number_last4 &&
  !b.ledger_account_id && !b.opening_entry_id);
const bankConfigured = (labelled ?? []).filter((b) => !bankUnconfigured.includes(b));

// ⚠️ Payout recipients were the gap this broom did not cover, and the omission
// had teeth. `payout_recipients_landlord_uidx` (0040b) allows ONE ACTIVE
// landlord recipient per (org, user) — so a single row left behind by a suite
// that crashed occupies that slot for every later run. On staging, seven of
// them had accumulated since 20 Aug, and `verify-remittance-account` failed
// with "Cannot read properties of null" for weeks because its insert was
// hitting 23505 against litter, not because anything it tests was broken.
//
// The names are stated in full rather than folded into NAME_PREFIXES, because
// two suites label theirs "Test …" and a blanket `%test%` over a table of
// payment destinations is not a filter anyone should write.
const RECIPIENT_NAMES = [
  "Probe Landlord%", "PROBE%", "Test Landlord Payouts%",
  "Test Vendor Payouts%", "Test Account-Naming Payouts%",
];
const recipients = new Map();
for (const pattern of RECIPIENT_NAMES) {
  const { data } = await svc.from("payout_recipients")
    .select("id,display_name,party,active").ilike("display_name", pattern);
  for (const r of data ?? []) recipients.set(r.id, r);
}
const probeRecipients = [...recipients.values()];

const orgIds = new Set(orgs.map((o) => o.id));
console.log(`  orgs                 ${orgs.length}  ${c.d(orgs.map((o) => o.name).join(", ").slice(0, 90))}`);
console.log(`  properties           ${props.length}`);
console.log(`  vendors              ${vendors.length}`);
console.log(`  org_nodes            ${nodes.length}`);
console.log(`  tenant_applications  ${apps.length}`);
console.log(`  users                ${(probeUsers ?? []).length}`);
console.log(`  payout_recipients    ${probeRecipients.length}` +
  (probeRecipients.some((r) => !r.active) ? c.d(`  (${probeRecipients.filter((r) => !r.active).length} already inactive)`) : ""));
console.log(`  bank_accounts        ${bankUnconfigured.length}` +
  (bankConfigured.length ? c.r(`  (+${bankConfigured.length} LEFT — configured)`) : ""));
for (const b of bankConfigured) {
  console.log(`    ${c.r("LEFT")} ${b.label} — carries configuration, not swept`);
}

// Anything real hanging off a probe org would be destroyed by the cascade, so
// look before deleting rather than trust that a probe org only holds probes.
if (orgIds.size) {
  console.log("\n  Rows hanging off probe orgs (all cascade on delete):");
  for (const t of ["properties", "users", "vendors", "tickets", "leases", "payments", "audit_log"]) {
    const { count, error } = await svc.from(t).select("id", { count: "exact", head: true })
      .in("org_id", [...orgIds]);
    if (!error) console.log(`    ${t.padEnd(20)} ${count ?? 0}`);
  }
}

if (!apply) {
  console.log(`\n${c.d("Dry run — nothing deleted. Re-run with --apply.")}\n`);
  process.exit(0);
}

// ── Remove, children before parents ─────────────────────────────────────────
console.log("\nDeleting:");
// Anything the database refused, collected across every phase below and
// reported together at the end rather than scrolling past mid-sweep.
const problems = [];
const appsGone = await sweepProbeApplications(svc, "Probe ");
console.log(`  applications  ${appsGone}`);
const propsGone = await sweepProbeProperties(svc, ["PROBE", "Probe Court", "Probe "]);
console.log(`  properties    ${propsGone}`);
const vendorsGone = await sweepProbeVendors(svc, ["Perm probe", "PROBE", "Probe "]);
console.log(`  vendors       ${vendorsGone}`);
let nodesGone = 0;
for (const p of NAME_PREFIXES) nodesGone += await sweepProbeNodes(svc, p);
console.log(`  org_nodes     ${nodesGone}`);

// A recipient a remittance points at is DEACTIVATED, not deleted. The FK would
// refuse the delete anyway, but deactivation is the better answer on its own
// terms: the uniqueness index is partial on `active`, so switching the flag
// frees the (org, user) slot for the next run while the payout history keeps
// the destination it actually named. Deleting a payment destination out from
// under a settled payout is the ledger equivalent of erasing an audit row.
let recipientsGone = 0, recipientsDeactivated = 0;
for (const r of probeRecipients) {
  const { count } = await svc.from("remittances")
    .select("id", { count: "exact", head: true }).eq("recipient_id", r.id);
  if ((count ?? 0) === 0) {
    const { error } = await svc.from("payout_recipients").delete().eq("id", r.id);
    if (error) problems.push(`${r.display_name}: ${error.message}`);
    else recipientsGone++;
    continue;
  }
  if (!r.active) continue;
  const { error } = await svc.from("payout_recipients")
    .update({ active: false }).eq("id", r.id);
  if (error) problems.push(`${r.display_name}: ${error.message}`);
  else recipientsDeactivated++;
}
console.log(`  recipients    ${recipientsGone} deleted, ${recipientsDeactivated} deactivated (named by a remittance)`);

// An unconfigured probe account still gets the same look a configured one would
// — reconciliation lines cascade from it, and a statement line is a record of
// what a bank said, not a fixture. Nothing is deleted out from under a
// remittance either, even though the FK there would refuse anyway.
let banksGone = 0;
for (const b of bankUnconfigured) {
  let held = false;
  for (const t of ["bank_statement_lines", "reconciliations", "remittances"]) {
    const { count, error } = await svc.from(t)
      .select("id", { count: "exact", head: true }).eq("bank_account_id", b.id);
    if (!error && (count ?? 0) > 0) {
      console.log(`  ${c.r("KEPT")} ${b.label} — ${count} ${t} row(s) reference it`);
      held = true;
      break;
    }
  }
  if (held) continue;
  const { error } = await svc.from("bank_accounts").delete().eq("id", b.id);
  if (error) console.log(`  ${c.r("KEPT")} ${b.label} — ${error.message}`);
  else banksGone++;
}
console.log(`  bank_accounts ${banksGone}`);

// Users live in two places: the auth store and the public mirror. Deleting only
// the mirror leaves a login that still works and cannot be seen.
//
// A probe user that ACTED has audit_log rows, and `audit_log.actor_id`
// references users(id) with no cascade — so the database refuses the delete.
// That refusal is the immutable-audit guardrail working, not an obstacle to
// route around: the fallback is deactivation, which takes the account out of
// every picker and blocks the login while the trail keeps its actor.
let usersGone = 0, usersDeactivated = 0;
for (const u of probeUsers ?? []) {
  const { error: rowErr } = await svc.from("users").delete().eq("id", u.id);
  if (!rowErr) {
    const { error: authErr } = await svc.auth.admin.deleteUser(u.id);
    if (authErr && !/not found/i.test(authErr.message)) {
      problems.push(`${u.email} (auth store): ${authErr.message}`);
    }
    usersGone++;
    continue;
  }
  if (!u.deactivated_at) {
    const { error: deErr } = await svc.from("users")
      .update({ deactivated_at: new Date().toISOString() }).eq("id", u.id);
    if (deErr) { problems.push(`${u.email}: ${deErr.message}`); continue; }
  }
  await svc.auth.admin.updateUserById(u.id, { ban_duration: "876000h" });
  usersDeactivated++;
}
console.log(`  users         ${usersGone} deleted, ${usersDeactivated} deactivated (held by audit)`);

// Probe ORGS are deliberately NOT hard-deleted. `audit_log.org_id` references
// orgs(id) with no cascade, so the database refuses it anyway — and the refusal
// is correct. Soft-delete is what every query in the app already filters on
// (`is('deleted_at', null)`), so a soft-deleted org appears in no directory, no
// picker and no login. Forcing the hard delete would mean deleting the org's
// audit rows first, which is the one thing A3 says never happens.
let orgsSoftDeleted = 0;
for (const o of orgs) {
  if (o.deleted_at) continue;
  const { error } = await svc.from("orgs")
    .update({ deleted_at: new Date().toISOString() }).eq("id", o.id);
  if (error) problems.push(`${o.name}: ${error.message}`); else orgsSoftDeleted++;
}
console.log(`  orgs          ${orgsSoftDeleted} soft-deleted, ${orgs.filter((o) => o.deleted_at).length} already were (audit kept)`);

for (const k of problems) console.log(`  ${c.r("KEPT")} ${k}`);
console.log(`
${c.g("Sweep complete.")}
`);
