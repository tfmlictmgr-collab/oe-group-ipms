// Verifies 0331: an applicant's documents are read by the people who review the
// application, a vendor's documents by that vendor and the vendor desk, and an
// application's decision is written only by the functions that record one.
//
// Before 0331 both buckets admitted ANY signed-in member of the organisation —
// a tenant, a landlord, another company's vendor login — so this suite sits in
// each of those seats and asks the storage table what it can list. That is what
// the storage API's list and download run against: `storage.objects` under the
// caller's role and claims.
//
// Every act runs in a signed-in user's own session (`set local role
// authenticated` with their claims), inside ONE transaction that is rolled back
// at the end — no fixture, account or object row survives it.
//
// Usage: node scripts/verify-document-buckets.mjs [--env .env.staging.local]
import path from "node:path";
import crypto from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { requireNonProductionTarget } from "./lib/target-env.mjs";

const envArg = process.argv.indexOf("--env");
const envFile = envArg > -1 ? process.argv[envArg + 1] : ".env.local";
config({ path: path.join(process.cwd(), envFile), quiet: true, override: true });
requireNonProductionTarget(process.cwd(), "Writes document fixtures in a rolled-back transaction.");

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
const check = (cond, m, detail) => (cond ? ok(m) : bad(detail ? `${m} — ${detail}` : m));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

async function as(uid) {
  await db.query("set local role authenticated");
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: uid, role: "authenticated" }),
  ]);
}
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

async function newUser(orgId, role, label) {
  const id = crypto.randomUUID();
  const email = `probe-docbucket-${label}-${id.slice(0, 8)}@oegroup.test`;
  await db.query(
    "insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')",
    [id, email]
  );
  await db.query(
    "insert into users (id, org_id, role, full_name, email) values ($1, $2, $3, $4, $5)",
    [id, orgId, role, `Probe ${label}`, email]
  );
  return id;
}

/** The fixture object names this seat can see in a bucket — what a storage
 *  `list` or `download` would be allowed to return. */
async function visible(bucket, names) {
  const r = await db.query(
    "select name from storage.objects where bucket_id = $1 and name = any($2::text[])",
    [bucket, names]
  );
  return new Set(r.rows.map((x) => x.name));
}
const rows = async (sql, p) => (await db.query(sql, p)).rowCount;

console.log(`\nApplicant and vendor documents (0331) · ${envFile}`);
await db.connect();
await db.query("begin");

try {
  const org = await one("select id from orgs where slug = 'oea' and deleted_at is null");
  if (!org) throw new Error("the oea org is missing");
  const props = (await db.query(
    "select id from properties where org_id = $1 and deleted_at is null order by created_at limit 2",
    [org.id]
  )).rows;
  if (props.length < 2) throw new Error("oea needs two live properties");
  const [P, other] = props;
  const admin = await one(
    `select id from users where org_id = $1 and role = 'admin' and deactivated_at is null
       and email like 'oea.%@oegroup.test' order by email limit 1`,
    [org.id]
  );
  if (!admin) throw new Error("the oea demo administrator is missing");

  // ── Seats ──────────────────────────────────────────────────────────────
  const pm = await newUser(org.id, "property_manager", "pm");          // reviewer, on P
  const pmElsewhere = await newUser(org.id, "property_manager", "pm2"); // reviewer, not on P
  const landlord = await newUser(org.id, "property_owner", "landlord"); // owner of P
  const ownerRep = await newUser(org.id, "owner_representative", "rep"); // represents P
  const tenant = await newUser(org.id, "tenant", "tenant");
  const opsStaff = await newUser(org.id, "fm_ops_staff", "ops");
  const officer = await newUser(org.id, "finance_approver", "officer"); // vendors.read
  const vendorUserA = await newUser(org.id, "vendor", "vendorA");
  const vendorUserB = await newUser(org.id, "vendor", "vendorB");

  for (const [uid, relation, prop] of [
    [pm, "manager", P.id], [pmElsewhere, "manager", other.id],
    [landlord, "owner", P.id], [ownerRep, "representative", P.id],
  ]) {
    await db.query(
      "insert into property_stakeholders (org_id, user_id, property_id, relation) values ($1, $2, $3, $4)",
      [org.id, uid, prop, relation]
    );
  }

  // ── An application on P with one attachment and one finding ────────────
  const app = await one(
    `insert into tenant_applications (org_id, type, applicant_name, applicant_email, property_id, status, submitted_at)
     values ($1, 'individual', 'Probe Applicant', 'probe-applicant@oegroup.test', $2, 'submitted', now())
     returning id`,
    [org.id, P.id]
  );
  const appDoc = `${org.id}/${app.id}/national_id-${crypto.randomUUID()}.pdf`;
  const appOrphan = `${org.id}/${crypto.randomUUID()}/orphan-${crypto.randomUUID()}.pdf`;
  const att = await one(
    `insert into application_attachments (org_id, application_id, kind, storage_path, file_name, content_type, size_bytes)
     values ($1, $2, 'national_id', $3, 'id.pdf', 'application/pdf', 1024) returning id`,
    [org.id, app.id, appDoc]
  );
  await db.query(
    `insert into application_document_findings (org_id, application_id, attachment_id, kind, severity, summary, model, evidence_mode)
     values ($1, $2, $3, 'format', 'info', 'Probe finding for the suite', 'probe', 'extracted_text')`,
    [org.id, app.id, att.id]
  );

  // ── Two companies, one document each ───────────────────────────────────
  const vendorA = await one("insert into vendors (org_id, name) values ($1, 'PROBEDOC Vendor A') returning id", [org.id]);
  const vendorB = await one("insert into vendors (org_id, name) values ($1, 'PROBEDOC Vendor B') returning id", [org.id]);
  await db.query("insert into vendor_users (org_id, vendor_id, user_id, is_owner) values ($1, $2, $3, true)", [org.id, vendorA.id, vendorUserA]);
  await db.query("insert into vendor_users (org_id, vendor_id, user_id, is_owner) values ($1, $2, $3, true)", [org.id, vendorB.id, vendorUserB]);
  const docA = `${org.id}/${vendorA.id}/cac_certificate-${crypto.randomUUID()}.pdf`;
  const docB = `${org.id}/${vendorB.id}/bank_evidence-${crypto.randomUUID()}.pdf`;
  const vendorOrphan = `${org.id}/${crypto.randomUUID()}/tin_certificate-${crypto.randomUUID()}.pdf`;
  await db.query(
    `insert into vendor_documents (org_id, vendor_id, doc_type, storage_path, file_name)
     values ($1, $2, 'cac_certificate', $3, 'cac.pdf'), ($1, $4, 'bank_evidence', $5, 'bank.pdf')`,
    [org.id, vendorA.id, docA, vendorB.id, docB]
  );

  // The bytes are not needed to test who may see them; the object rows are
  // exactly what the storage API's list and download consult.
  for (const [bucket, name] of [
    ["application-documents", appDoc], ["application-documents", appOrphan],
    ["vendor-documents", docA], ["vendor-documents", docB], ["vendor-documents", vendorOrphan],
  ]) {
    await db.query("insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, name]);
  }
  const appNames = [appDoc, appOrphan];
  const vendorNames = [docA, docB, vendorOrphan];

  // ── A. application-documents ───────────────────────────────────────────
  section("A. An applicant's documents are read by the application's reviewers");
  await as(pm);
  let v = await visible("application-documents", appNames);
  check(v.has(appDoc), "the property manager on that property reads the applicant's document");
  check(!v.has(appOrphan), "but not an object no application records");
  await as(admin.id);
  v = await visible("application-documents", appNames);
  check(v.has(appDoc), "the administrator (applications.review_all) reads it");
  for (const [uid, who] of [
    [pmElsewhere, "a property manager on a different property"],
    [landlord, "the landlord of that property"],
    [ownerRep, "the Owner Rep of that property"],
    [tenant, "a tenant"],
    [opsStaff, "ops staff"],
    [officer, "the payment officer"],
    [vendorUserA, "a vendor login"],
  ]) {
    await as(uid);
    v = await visible("application-documents", appNames);
    check(v.size === 0, `${who} lists nothing in application-documents`, `saw ${v.size}`);
  }

  // ── B. The application rows follow the same rule ───────────────────────
  section("B. The application, its overview and its findings — reviewers only");
  await as(pm);
  check(await rows("select 1 from tenant_applications where id = $1", [app.id]) === 1, "the property manager reads the application");
  check(await rows("select 1 from application_overview where id = $1", [app.id]) === 1, "and its overview");
  check(await rows("select 1 from application_document_findings where application_id = $1", [app.id]) === 1, "and its document findings");
  check(await rows("select 1 from application_attachments where application_id = $1", [app.id]) === 1, "and its attachment record");
  for (const [uid, who] of [[landlord, "the landlord"], [ownerRep, "the Owner Rep"], [pmElsewhere, "a manager of another property"]]) {
    await as(uid);
    const n =
      await rows("select 1 from tenant_applications where id = $1", [app.id]) +
      await rows("select 1 from application_overview where id = $1", [app.id]) +
      await rows("select 1 from application_document_findings where application_id = $1", [app.id]) +
      await rows("select 1 from application_attachments where application_id = $1", [app.id]);
    check(n === 0, `${who} reads no application, overview, finding or attachment record on that property`, `saw ${n} rows`);
  }

  // ── C. No decision by PATCH ────────────────────────────────────────────
  section("C. A decision is recorded through its functions, never by a direct write");
  for (const [uid, who] of [[landlord, "the landlord"], [pm, "a reviewer"], [admin.id, "the administrator"]]) {
    await as(uid);
    const m = await refused(
      "update tenant_applications set status = 'approved', decided_by = $2, decided_at = now() where id = $1",
      [app.id, uid]
    );
    check(/permission denied/.test(m ?? ""), `${who} cannot PATCH an application to approved`, m ?? "the update ran");
  }
  await asOwner();
  const after = await one("select status, decided_by from tenant_applications where id = $1", [app.id]);
  check(after.status === "submitted" && after.decided_by === null, "the application is still submitted, decided by nobody",
    `${after.status} / ${after.decided_by}`);

  // ── D. vendor-documents ────────────────────────────────────────────────
  section("D. A vendor's documents are read by that vendor and the vendor desk");
  await as(vendorUserA);
  v = await visible("vendor-documents", vendorNames);
  check(v.has(docA), "vendor A's login reads vendor A's document");
  check(!v.has(docB), "but not vendor B's");
  check(!v.has(vendorOrphan), "nor an object no vendor document records");
  await as(vendorUserB);
  v = await visible("vendor-documents", vendorNames);
  check(v.has(docB) && !v.has(docA), "vendor B's login reads B's and not A's");
  for (const [uid, who] of [[officer, "the payment officer (vendors.read)"], [pm, "a property manager (vendors.read)"], [admin.id, "the administrator"]]) {
    await as(uid);
    v = await visible("vendor-documents", vendorNames);
    check(v.has(docA) && v.has(docB) && !v.has(vendorOrphan), `${who} reads both companies' documents and no orphan`, `saw ${v.size}`);
  }
  for (const [uid, who] of [[tenant, "a tenant"], [landlord, "a landlord"], [ownerRep, "an Owner Rep"], [opsStaff, "ops staff"]]) {
    await as(uid);
    v = await visible("vendor-documents", vendorNames);
    check(v.size === 0, `${who} lists nothing in vendor-documents`, `saw ${v.size}`);
  }

  // ── E. The catalogue says what this suite proved ───────────────────────
  section("E. The live catalogue");
  await asOwner();
  const pol = await one(
    `select count(*)::int n from pg_policy
      where polrelid = 'storage.objects'::regclass and polcmd in ('r', '*')
        and pg_get_expr(polqual, polrelid) ~ 'application-documents|vendor-documents'`
  );
  check(pol.n === 2, "exactly two SELECT policies read the two buckets", `found ${pol.n}`);
  const upd = await one(
    `select has_any_column_privilege('authenticated', 'public.tenant_applications', 'UPDATE') a,
            has_any_column_privilege('anon', 'public.tenant_applications', 'UPDATE') b`
  );
  check(!upd.a && !upd.b, "neither authenticated nor anon holds UPDATE on tenant_applications");
  const fn = await one(
    `select count(*)::int n from information_schema.routine_privileges
      where routine_schema = 'public' and routine_name = 'caller_reviews_applications'
        and grantee in ('PUBLIC', 'anon')`
  );
  const exists = await one("select to_regprocedure('public.caller_reviews_applications()') is not null e");
  check(exists.e && fn.n === 0, "caller_reviews_applications exists and is not callable anonymously");
} catch (e) {
  bad(`suite error: ${e.message}`);
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}

if (failures) {
  console.log(`\n\x1b[31m${failures} check(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log("\n\x1b[32mALL CHECKS PASSED — applicant and vendor documents are read only by their reviewers and their own vendor, and no application is decided by a direct write.\x1b[0m");
