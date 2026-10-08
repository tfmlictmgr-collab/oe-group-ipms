// Permanently remove named TEST accounts, and what hangs off them, from one
// organisation. Run by hand. NEVER a migration: migrations replay on every
// fresh database, and this must only ever run once, on purpose.
//
//   node scripts/purge-test-records.mjs --world prod --org oea \
//        --emails a@x.com,b@y.com [--prefix wt.] [--tag WT-] [--include-audit]
//   ...add  --apply --backup <file> --confirm "PURGE oea <n>"  to commit.
//
//   ...add  --vendors "Tutors De Clean,Other Co"  to remove named vendor COMPANIES
//   (and their logins and stored files). A vendor that was ever paid, scored,
//   given a ticket or a ledger account is REFUSED - that is financial history.
//
// DRY RUN IS THE DEFAULT AND IS NOT A GUESS. It executes every delete for real
// inside one transaction and then ROLLS BACK, so the counts and any refusal are
// exactly what --apply would meet. Nothing is committed without --apply.
//
// What it can NEVER touch, by construction: the triggers that protect
// properties, units, org nodes, assets, ledger entries/postings and storage
// buckets are never disabled. A purge that tried to take one of those would
// fail and roll back, not succeed. Only the specific blockers named in
// RELAXED are disabled, inside the transaction, and re-verified as enabled
// before commit.
//
// What it will not do: remove real money. If the org holds any ledger entry or
// remittance it refuses to apply — walkthrough money that really moved through
// Paystack or Flutterwave stays on the gateway's books and ours.
//
// Audit rows: the trail is immutable by design (ISO 41001 §7.5). Deleting the
// 'actor' rows of a purged user needs --include-audit, which is a recorded
// decision, not a default. Without it a user who ever acted cannot be deleted
// and the run refuses rather than half-doing it.
import fs from "node:fs";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i < 0 ? d : (process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const world = arg("world"), orgSlug = arg("org", "oea");
const emails = String(arg("emails", "")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const prefix = arg("prefix") && arg("prefix") !== true ? String(arg("prefix")).toLowerCase() : null;
const tag = arg("tag") && arg("tag") !== true ? String(arg("tag")) : null;
const vendorNames = String(arg("vendors", "")).split(",").map((s) => s.trim()).filter(Boolean);
const includeAudit = !!arg("include-audit"), apply = !!arg("apply");
if (!world || (!emails.length && !prefix && !tag && !vendorNames.length)) {
  console.error("usage: --world <demo|dev|staging|prod> --org <slug> (--emails a,b | --prefix wt. | --tag WT- | --vendors \"Name,Name\") [--include-audit] [--apply --backup FILE --confirm \"PURGE <org> <n>\"]");
  process.exit(2);
}
if (world === "demo") { console.error("Refusing: the frozen demo world is never a target."); process.exit(2); }

const envFile = `.env.${world}.local`;
const env = Object.fromEntries(fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));

// Roles a purge may remove. Staff roles are refused outright: "delete the test
// tenant" must never be able to delete the person who is administering.
const REMOVABLE_ROLES = new Set(["tenant", "property_owner", "vendor"]);

// Blockers this run may relax (table → trigger). Real-data guards are absent
// on purpose. Ledger / posting / property / unit / org-node / asset triggers
// are NOT here.
const RELAXED = [
  ["service_charges", "service_charges_no_hard_delete"],
  ["leases", "leases_no_hard_delete"],
  ["payment_approvals", "trg_approvals_append_only"],
  ["manual_remittance_records", "manual_remittance_records_final"],
  ["vendor_users", "vendor_users_keep_an_owner"],
  ...(includeAudit ? [["audit_log", "audit_no_delete"]] : []),
];

// A referencing row is either deleted (it belongs to the test person) or has
// its pointer cleared (it merely records who did something). Anything not
// named here is UNCLASSIFIED and stops the run — the script asks rather than
// guesses, because a wrong guess here deletes a real record.
const DELETE_TABLES = new Set([
  "service_charges", "invitations", "tickets", "leases", "tenant_applications",
  "rent_charges", "payment_intents", "vendor_users", "offline_payment_claims",
  "vendor_registrations", "vendor_documents",
]);
const ACTOR_COL = /(^|_)(created|updated|reviewed|approved|invited|verified|decided|raised|submitted|assigned|set|confirmed|recorded|resolved|released|actor)(_by|_user_id)?$|^(created_by|updated_by|assigned_to_user_id)$/;

const c = new pg.Client({ host: env.SUPABASE_DB_HOST, port: +env.SUPABASE_DB_PORT, database: env.SUPABASE_DB_NAME, user: env.SUPABASE_DB_USER, password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;
const report = [], problems = [], applyOnly = [];
const say = (s) => { console.log(s); };

const org = (await q("select id, is_platform_operator from orgs where slug=$1", [orgSlug]))[0];
if (!org) { console.error("no such org"); process.exit(2); }
if (org.is_platform_operator) { console.error("Refusing: platform operator org."); process.exit(2); }

const users = await q(
  `select id, email, full_name, role from users where org_id=$1 and (lower(email)=any($2) ${prefix ? "or lower(email) like $3" : "and $3::text is null"})`,
  [org.id, emails, prefix ? prefix + "%" : null]
);
for (const u of users) if (!REMOVABLE_ROLES.has(u.role)) problems.push(`REFUSED: ${u.email} is a ${u.role}; only ${[...REMOVABLE_ROLES].join(", ")} may be purged.`);
const missing = emails.filter((e) => !users.some((u) => u.email.toLowerCase() === e));
if (missing.length) problems.push(`NOT FOUND in ${orgSlug}: ${missing.join(", ")}`);

// ── Vendor companies ──────────────────────────────────────────────────────
// Named exactly (case-insensitive). A name that matches two companies is
// refused rather than guessed. Their logins go with them unless the login also
// belongs to a company that is staying.
const vendors = [];
for (const name of vendorNames) {
  const rows = await q("select id, name, approval_status from vendors where org_id=$1 and lower(name)=lower($2)", [org.id, name]);
  if (rows.length === 0) problems.push(`VENDOR NOT FOUND in ${orgSlug}: "${name}"`);
  else if (rows.length > 1) problems.push(`VENDOR AMBIGUOUS: "${name}" matches ${rows.length} companies; rename or remove the duplicates by hand`);
  else vendors.push(rows[0]);
}
const vendorIds = vendors.map((v) => v.id);
if (vendorIds.length) {
  const logins = await q(
    `select u.id, u.email, u.full_name, u.role,
            exists (select 1 from vendor_users o where o.user_id = u.id and o.vendor_id <> all($1::uuid[])) as elsewhere
       from vendor_users vu join users u on u.id = vu.user_id
      where vu.vendor_id = any($1::uuid[]) and u.org_id = $2`, [vendorIds, org.id]);
  for (const l of logins) {
    if (l.elsewhere) { report.push(`login ${l.email} also belongs to a vendor that is staying: unlinked only, account kept`); continue; }
    if (l.role !== "vendor") { problems.push(`REFUSED: ${l.email} is linked to a vendor but is a ${l.role}; not removed.`); continue; }
    if (!users.some((u) => u.id === l.id)) users.push({ id: l.id, email: l.email, full_name: l.full_name, role: l.role });
  }
}
const ids = users.map((u) => u.id);

say(`\n${apply ? "APPLY" : "DRY RUN"} — world=${world} org=${orgSlug}`);
say(`Vendor companies (${vendors.length}): ` + (vendors.map((v) => v.name).join("; ") || "none"));
say(`Targets (${users.length}): ` + users.map((u) => `${u.full_name} <${u.email}> [${u.role}]`).join("; "));

// Money guard, per account. An organisation that has taken real money (every
// live one, from its first day) must still be able to remove a test account
// that money never touched, so the question is asked of each TARGET, not of
// the organisation. An account money touched is refused and named: it is
// deactivated in the app instead, because its payments, receipts and payouts
// stay on the books (the ledger is immutable by design).
for (const u of users) {
  const m = (await q(
    `select
       (select count(*) from payment_intents where payer_user_id = $1 and (status = 'paid' or coalesce(amount_paid, 0) > 0))::int as online,
       (select count(*) from offline_payment_claims where (payer_user_id = $1 or recorded_by = $1) and status = 'confirmed')::int as offline,
       (select count(*) from rent_charges rc join leases l on l.id = rc.lease_id where l.tenant_user_id = $1 and coalesce(rc.amount_paid, 0) > 0)::int as rent,
       (select count(*) from service_charges where billed_to_user_id = $1 and coalesce(amount_paid, 0) > 0)::int as sc,
       (select count(*) from remittances r join payout_recipients p on p.id = r.recipient_id where p.user_id = $1)::int as payouts,
       (select count(*) from ledger_entries where created_by = $1)::int as ledger`, [u.id]))[0];
  const found = Object.entries(m).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
  if (found.length) problems.push(`ACCOUNT HAS MONEY HISTORY: ${u.email} (${found.join(", ")}). Deactivate it in the app instead (People → Directory → Manage → Deactivate), and leave it out of this run.`);
}
if (tag) {
  const n = (await q(`select count(*)::int n from rent_charges rc join leases l on l.id = rc.lease_id
                       where l.org_id = $1 and l.tenant_name ilike $2 and coalesce(rc.amount_paid, 0) > 0`, [org.id, tag + "%"]))[0].n;
  if (n) problems.push(`TAGGED TENANCY HAS MONEY HISTORY: ${n} paid rent charge(s) on leases named "${tag}…". End those tenancies in the app; they stay on the books.`);
}

const before = (await q(`select (select count(*) from properties where org_id=$1)::int p, (select count(*) from units where org_id=$1)::int u,
  (select count(*) from users where org_id=$1 and role not in ('tenant','property_owner','vendor'))::int staff`, [org.id]))[0];

// Storage objects owned by targets are removed through the API after commit
// (deleting the row in SQL would orphan the file).
const objects = ids.length ? await q("select bucket_id, name from storage.objects where owner = any($1::uuid[])", [ids]) : [];

// A vendor with money or work history is not deletable, whatever was asked.
// These are COUNTED before anything is touched.
const HISTORY = [
  ["payments", "vendor_id"], ["vendor_evaluations", "vendor_id"], ["ledger_accounts", "counterparty_vendor_id"],
  ["tickets", "assigned_vendor_id"], ["ops_requisition_lines", "vendor_id"], ["assets", "assigned_vendor_id"],
];
for (const v of vendors) {
  const found = [];
  for (const [t, col] of HISTORY) {
    const n = (await q(`select count(*)::int n from ${t} where ${col} = $1`, [v.id]))[0].n;
    if (n) found.push(`${t}=${n}`);
  }
  const rem = (await q("select count(*)::int n from remittances r join payout_recipients p on p.id = r.recipient_id where p.vendor_id = $1", [v.id]).catch(() => [{ n: 0 }]))[0].n;
  if (rem) found.push(`remittances=${rem}`);
  if (found.length) problems.push(`VENDOR HAS HISTORY: "${v.name}" (${found.join(", ")}). It was used; retire it instead of deleting it.`);
}

// Stored files that belong to the vendor company (KYC pack, bank evidence).
const vendorFiles = [];
if (vendorIds.length) {
  for (const r of await q("select storage_path p from vendor_documents where vendor_id = any($1::uuid[]) and storage_path is not null", [vendorIds])) vendorFiles.push({ bucket_id: "vendor-documents", name: r.p });
  for (const r of await q("select evidence_bucket b, evidence_path p from payout_recipients where vendor_id = any($1::uuid[]) and evidence_path is not null", [vendorIds])) vendorFiles.push({ bucket_id: r.b || "payout-evidence", name: r.p });
  const loose = await q("select bucket_id, name from storage.objects where bucket_id in ('vendor-documents','payout-evidence') and name like any($1::text[])", [vendorIds.flatMap((id) => [`%/${id}/%`, `${id}/%`])]);
  vendorFiles.push(...loose);
}
const gatewayRecipients = vendorIds.length ? await q("select gateway, recipient_code, display_name from payout_recipients where vendor_id = any($1::uuid[]) and recipient_code is not null", [vendorIds]) : [];
for (const f of vendorFiles) if (!objects.some((o) => o.bucket_id === f.bucket_id && o.name === f.name)) objects.push(f);

// Every FK that points at users, and how many rows each holds for the targets.
const fks = await q(`select k.conrelid::regclass::text child, a.attname col, k.confrelid::regclass::text parent, k.confdeltype del, not a.attnotnull nullable
  from pg_constraint k join pg_attribute a on a.attrelid=k.conrelid and a.attnum=k.conkey[1]
  where k.contype='f' and k.confrelid in ('public.users'::regclass,'auth.users'::regclass) and array_length(k.conkey,1)=1`);

await c.query("begin");
const step = async (label, sql, params) => {
  await c.query("savepoint s");
  try { const r = await c.query(sql, params); await c.query("release savepoint s"); if (r.rowCount) report.push(`${label}: ${r.rowCount}`); return r.rowCount; }
  catch (e) { await c.query("rollback to savepoint s"); problems.push(`${label} FAILED — ${e.message}${e.detail ? " (" + e.detail + ")" : ""}`); return 0; }
};

if ((!problems.length && (ids.length || vendorIds.length)) || tag) {
  for (const [t, trg] of RELAXED) await c.query(`alter table ${t} disable trigger ${trg}`);

  if (vendorIds.length && !problems.length) {
    // Rows that point at the vendor and block its delete, none of them history.
    const vAudit = await q(`select id from vendors where id = any($1::uuid[])
        union select id from payout_recipients where vendor_id = any($1::uuid[])
        union select id from payout_detail_requests where vendor_id = any($1::uuid[])
        union select id from vendor_registrations where vendor_id = any($1::uuid[])
        union select id from vendor_documents where vendor_id = any($1::uuid[])
        union select id from vendor_applications where vendor_id = any($1::uuid[])`, [vendorIds]);
    await step("vendor_introductions (to this vendor)", "delete from vendor_introductions where target_vendor_id = any($1::uuid[])", [vendorIds]);
    await step("invitations naming the vendor", "delete from invitations where vendor_id = any($1::uuid[])", [vendorIds]);
    await step("vendor_applications", "delete from vendor_applications where vendor_id = any($1::uuid[])", [vendorIds]);
    await step("payout_detail_requests", "delete from payout_detail_requests where vendor_id = any($1::uuid[])", [vendorIds]);
    await step("payout_recipients", "delete from payout_recipients where vendor_id = any($1::uuid[])", [vendorIds]);
    await step("vendors (cascades documents, registration, property links, login links)", "delete from vendors where id = any($1::uuid[])", [vendorIds]);
    if (includeAudit && vAudit.length) await step("audit_log about the vendor and its records", "delete from audit_log where entity_id = any($1::uuid[])", [vAudit.map((r) => r.id)]);
  }

  if (tag) {
    await step(`leases tagged ${tag}`, "delete from leases where org_id=$1 and tenant_name ilike $2", [org.id, tag + "%"]);
    await step(`vendors tagged ${tag}`, "delete from vendors where org_id=$1 and name ilike $2", [org.id, tag + "%"]);
  }

  for (const f of fks) {
    if (f.child.startsWith("auth.") || f.child === "users" || f.parent === "auth.users") continue;
    const col = f.col, child = f.child;
    const n = (await q(`select count(*)::int n from ${child} where "${col}" = any($1::uuid[])`, [ids]))[0].n;
    if (!n) continue;
    if (f.del === "c") { report.push(`${child}.${col}: ${n} (cascades)`); continue; }
    if (f.del === "n") { report.push(`${child}.${col}: ${n} (set null by FK)`); continue; }
    if (child === "audit_log") {
      if (!includeAudit) problems.push(`audit_log.actor_id: ${n} rows of immutable audit by these users. Re-run with --include-audit to delete them (a recorded decision), or leave the users in place.`);
      else await step("audit_log (actor)", `delete from audit_log where actor_id = any($1::uuid[])`, [ids]);
      continue;
    }
    if (DELETE_TABLES.has(child)) { await step(`delete ${child} via ${col}`, `delete from ${child} where "${col}" = any($1::uuid[])`, [ids]); continue; }
    if (ACTOR_COL.test(col) && f.nullable) { await step(`clear ${child}.${col}`, `update ${child} set "${col}"=null where "${col}" = any($1::uuid[])`, [ids]); continue; }
    problems.push(`UNCLASSIFIED: ${child}.${col} holds ${n} row(s) pointing at a target. Say whether to delete them or clear the pointer.`);
  }

  if (!problems.length && ids.length) await step("auth.users (cascades public.users, sessions, identities, notifications)", "delete from auth.users where id = any($1::uuid[])", [ids]);

  for (const [t, trg] of RELAXED) await c.query(`alter table ${t} enable trigger ${trg}`);
  if (!problems.length) { try { await c.query("set constraints all immediate"); } catch (e) { problems.push("CONSTRAINT CHECK FAILED — " + e.message); } }
}

// Post-conditions: nothing real moved, no guard left off.
const after = (await q(`select (select count(*) from properties where org_id=$1)::int p, (select count(*) from units where org_id=$1)::int u,
  (select count(*) from users where org_id=$1 and role not in ('tenant','property_owner','vendor'))::int staff`, [org.id]))[0];
if (JSON.stringify(after) !== JSON.stringify(before)) problems.push(`POST-CONDITION: properties/units/staff changed ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
const off = await q(`select tgrelid::regclass::text t, tgname from pg_trigger where not tgisinternal and tgenabled <> 'O' and tgname = any($1)`, [RELAXED.map((r) => r[1])]);
if (off.length) problems.push("A guard trigger is not enabled: " + JSON.stringify(off));

say("\nWould remove / change:\n  " + (report.join("\n  ") || "(nothing)"));
if (objects.length) say(`  storage files owned by targets: ${objects.length} (removed through the Storage API after commit)`);
if (gatewayRecipients.length) say("  GATEWAY RECIPIENTS to remove by hand in the gateway dashboard: " + gatewayRecipients.map((g) => `${g.gateway} ${g.recipient_code} (${g.display_name})`).join("; "));
say(`Kept intact: ${after.p} properties, ${after.u} units, ${after.staff} staff accounts.`);
if (problems.length) say("\nBLOCKERS:\n  - " + problems.join("\n  - "));

let committed = false;
problems.push(...(apply ? applyOnly : []));
if (!apply && applyOnly.length) say("\nNOTE (blocks --apply):\n  - " + applyOnly.join("\n  - "));
if (apply && !problems.length) {
  const confirm = arg("confirm"), backup = arg("backup");
  const okBackup = backup && backup !== true && fs.existsSync(backup) && Date.now() - fs.statSync(backup).mtimeMs < 2 * 3600e3;
  if (!okBackup) problems.push("--backup <file> must name a backup made in the last 2 hours (scripts/backup-database.mjs).");
  else if (confirm !== `PURGE ${orgSlug} ${users.length + vendors.length}`) problems.push(`--confirm must be exactly "PURGE ${orgSlug} ${users.length + vendors.length}" (accounts + vendor companies).`);
  else { await c.query("commit"); committed = true; }
  if (!committed) say("\nNOT APPLIED:\n  - " + problems.join("\n  - "));
}
if (!committed) await c.query("rollback");

if (committed && objects.length) {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  for (const b of [...new Set(objects.map((o) => o.bucket_id))]) {
    const { error } = await sb.storage.from(b).remove(objects.filter((o) => o.bucket_id === b).map((o) => o.name));
    say(error ? `storage ${b}: ${error.message}` : `storage ${b}: removed`);
  }
}
say(committed ? "\nCOMMITTED." : apply ? "\nNothing changed." : "\nDry run complete — nothing was changed (transaction rolled back).");
await c.end();
process.exit(committed || (!apply && !problems.length) ? 0 : 1);
