// Verifies People → Directory, the person profile, and the three searchable
// lists built beside them (11 Sept 2026).
//
//   node scripts/verify-people-directory.mjs          (needs `npm run dev` running)
//
// Two halves. The DATABASE half runs as real users inside a transaction that is
// always rolled back, so it leaves nothing behind. The PAGE half signs in as
// real demo accounts and reads what the server renders — because every check
// that matters here is "does THIS reader get THIS section", and the only honest
// way to prove that is to sit in their seat (decision 23's recorded lesson:
// a suite that writes through the service role proves the policy and never the
// product).
//
// 📌 What it deliberately does NOT assert: row counts. Staging carries probe
// accounts from other suites (decision 38), so "the tenants list has 9 rows"
// would be a check about another suite's litter, not about this feature.
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local", quiet: true });

const SITE = process.env.RENDER_BASE || "http://localhost:3000";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD = "OEGroupDemo2026!";

if (!process.env.SUPABASE_DB_HOST) {
  console.error("Missing SUPABASE_DB_* in .env.local");
  process.exit(2);
}
if (/prod/i.test(URL_ ?? "")) {
  console.error("Refusing to run: target looks like production.");
  process.exit(2);
}

const client = new pg.Client({
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

/** Run as `uid`, always rolled back — no fixture state survives. */
async function asUser(uid, fn) {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated" })}'`
    );
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

// ── Reach the dev server first, so a missing precondition reads as SKIP ─────
try {
  await fetch(SITE, { redirect: "manual" });
} catch (e) {
  console.error(`\nCannot reach ${SITE} — start the dev server first (npm run dev).\n${e.message}`);
  process.exit(2);
}

await client.connect();

const idOf = async (email) =>
  (await client.query("select id, org_id, role from users where email = $1", [email])).rows[0];

const admin = await idOf("oea.admin@oegroup.test");
const pm = await idOf("oea.pm@oegroup.test");
const fm = await idOf("oea.fmgr@oegroup.test");
const tenant = await idOf("oea.tenant@oegroup.test");
const vendorLogin = await idOf("oea.vendor@oegroup.test");
const tfmlAdmin = await idOf("tfml.admin@oegroup.test");
for (const [k, v] of Object.entries({ admin, pm, fm, tenant, vendorLogin, tfmlAdmin })) {
  if (!v) { console.error(`Missing demo account: ${k}`); process.exit(2); }
}

// ── Signing in, as the browser would ────────────────────────────────────────
const ref = new URL(URL_).hostname.split(".")[0];
const cookieCache = new Map();
async function cookieFor(email) {
  if (cookieCache.has(email)) return cookieCache.get(email);
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const s = await r.json();
  if (!s.access_token) throw new Error(`sign-in failed for ${email}`);
  const enc = "base64-" + Buffer.from(JSON.stringify({
    access_token: s.access_token, token_type: "bearer", expires_in: s.expires_in,
    expires_at: s.expires_at, refresh_token: s.refresh_token, user: s.user,
  })).toString("base64");
  const parts = [];
  for (let i = 0, n = 0; i < enc.length; i += 3180, n++) {
    parts.push(`sb-${ref}-auth-token.${n}=${enc.slice(i, i + 3180)}`);
  }
  const c = parts.join("; ");
  cookieCache.set(email, c);
  return c;
}

/** The server-rendered HTML for `path` as `email`, flattened to text. */
async function page(email, path) {
  const res = await fetch(`${SITE}${path}`, {
    headers: { cookie: await cookieFor(email) },
    redirect: "manual",
  });
  const html = res.status < 300 ? await res.text() : "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
  return { status: res.status, html, text };
}

// ════════════════════════════════════════════════════════════════════════════
section("A. Recording a tenant of record goes through the letting policy");

const accountless = (
  await client.query(
    `select id from leases
      where org_id = $1 and tenant_user_id is null and deleted_at is null
      order by created_at limit 1`,
    [admin.org_id]
  )
).rows[0];

if (!accountless) {
  console.log("  \x1b[33mSKIP\x1b[0m no account-less tenancy in the OEA org to exercise");
} else {
  // The administrator holds `leases.write` and oversight: their update lands.
  const n1 = await asUser(admin.id, async () =>
    (await client.query(
      "update leases set tenant_name = 'Probe Tenant Of Record' where id = $1 and tenant_user_id is null",
      [accountless.id]
    )).rowCount
  );
  n1 === 1
    ? ok("the letting desk can name the tenant of an account-less tenancy")
    : bad(`an administrator's update matched ${n1} rows`);

  // A tenant holds no write on leases — the update matches nothing and raises
  // nothing (decision 38), which is why the action checks the rows it got back.
  const n2 = await asUser(tenant.id, async () =>
    (await client.query(
      "update leases set tenant_name = 'forged' where id = $1", [accountless.id]
    )).rowCount
  );
  n2 === 0
    ? ok("a tenant cannot rename the tenant of a tenancy")
    : bad(`a tenant's update matched ${n2} rows`);

  // Another organisation's administrator cannot reach it at all.
  const n3 = await asUser(tfmlAdmin.id, async () =>
    (await client.query(
      "update leases set tenant_name = 'forged' where id = $1", [accountless.id]
    )).rowCount
  );
  n3 === 0
    ? ok("another organisation's administrator cannot touch it")
    : bad(`a cross-org update matched ${n3} rows`);
}

// ════════════════════════════════════════════════════════════════════════════
section("B. The directory is a view of what each reader already reaches");

{
  // Profiles read `users` through the caller: another org's person is not a row.
  const seen = await asUser(tfmlAdmin.id, async () =>
    (await client.query("select count(*)::int n from users where id = $1", [tenant.id])).rows[0].n
  );
  seen === 0
    ? ok("a TFML administrator cannot read an OEA tenant's row")
    : bad("an OEA tenant is readable from TFML");
}

for (const g of ["staff", "tenants", "landlords", "vendors"]) {
  const r = await page("oea.admin@oegroup.test", `/dashboard/people/directory?group=${g}`);
  r.status === 200 && r.text.includes("Directory —") && !/Application error/i.test(r.html)
    ? ok(`the administrator opens the ${g} group`)
    : bad(`the ${g} group did not render for the administrator (status ${r.status})`);
}

{
  const r = await page("oea.fmgr@oegroup.test", "/dashboard/people/directory?group=tenants");
  r.text.includes("Directory — Tenants")
    ? ok("a facilities manager reaches the directory (People admits FM/PM/RM)")
    : bad("the facilities manager was refused the directory");
}
{
  const r = await page("oea.finance@oegroup.test", "/dashboard/people/directory");
  r.text.includes("Not available for your role") && !r.text.includes("Directory —")
    ? ok("the Payment Officer is refused, by the People gate, not shown an empty list")
    : bad("the Payment Officer reached the directory");
}
{
  const r = await page("oea.tenant@oegroup.test", "/dashboard/people/directory?group=tenants");
  !r.text.includes("Directory —")
    ? ok("a tenant cannot open the directory")
    : bad("a tenant was shown the tenant directory");
}

// ════════════════════════════════════════════════════════════════════════════
section("C. A profile shows each reader only the sections they may read");

const profile = (id) => `/dashboard/people/${id}`;
{
  const r = await page("oea.admin@oegroup.test", profile(tenant.id));
  r.text.includes("Contact & account") && r.text.includes("Tenancies")
    ? ok("the administrator opens a tenant's profile, with their tenancies")
    : bad("the tenant profile did not render for the administrator");
  r.text.includes("Online collections raised against them")
    ? ok("…and, holding org-wide money read, their payments")
    : bad("the administrator was not shown the tenant's payments");
}
{
  // ⚠️ Decision 29 + 25: a facilities manager holds no money read, so the
  // section is absent — never present and empty.
  const r = await page("oea.fmgr@oegroup.test", profile(tenant.id));
  r.text.includes("Contact & account") && !r.text.includes("Online collections raised against them")
    ? ok("a facilities manager sees the tenant, and no payments section at all")
    : bad("a facilities manager was shown a tenant's payments section");
  !r.text.includes("Rent outstanding")
    ? ok("…nor what the tenant owes")
    : bad("a facilities manager was shown rent outstanding");
}
{
  const r = await page("tfml.admin@oegroup.test", profile(tenant.id));
  !r.text.includes("Contact & account") && !r.text.includes("oea.tenant@oegroup.test")
    ? ok("another organisation's administrator gets no profile — the id is not a row to them")
    : bad("an OEA tenant's profile rendered for a TFML administrator");
}
{
  const r = await page("oea.admin@oegroup.test", "/dashboard/people/members");
  r.status < 500 && !r.text.includes("Contact & account") && !/Application error/i.test(r.html)
    ? ok("a sibling path that is not an id is a not-found, never a 500")
    : bad(`/dashboard/people/members answered ${r.status}`);
}
{
  const r = await page("oea.admin@oegroup.test", profile(vendorLogin.id));
  r.text.includes("Company") && r.text.includes("Company owner")
    ? ok("a vendor login's profile names its company and its standing in it")
    : bad("the vendor login's profile did not show its company");
}

// ════════════════════════════════════════════════════════════════════════════
section("D. The searchable lists and the links into profiles");

{
  const r = await page("oea.admin@oegroup.test", "/dashboard/leases");
  r.html.includes('aria-label="Search tenancies"') && r.html.includes('aria-label="Field to search"')
    ? ok("Leases & Rent carries a search, by all fields or one")
    : bad("Leases & Rent has no search");
  /href="\/dashboard\/leases\/[0-9a-f-]{36}"/.test(r.html)
    ? ok("…and each tenancy in the table opens its own statement")
    : bad("the rent roll's rows open nothing");
  r.text.includes("Not assigned")
    ? bad("a rent-roll row still reads 'Not assigned' — the tenant of record is not being read")
    : ok("no row reads 'Not assigned' (account first, then tenant of record)");
}
{
  const prop = (
    await client.query(
      `select p.id from properties p
        where p.org_id = $1 and p.deleted_at is null
          and exists (select 1 from property_stakeholders s where s.property_id = p.id)
        order by p.created_at limit 1`,
      [admin.org_id]
    )
  ).rows[0];
  const r = await page("oea.admin@oegroup.test", `/dashboard/properties/${prop.id}`);
  r.html.includes('aria-label="Search people who can be attached"')
    ? ok("\"Who is attached to this property\" is searchable")
    : bad("the attachment list has no search");
  r.text.includes("Attached only")
    ? ok("…and can be narrowed to who is attached now")
    : bad("the attached-only filter is missing");
  /href="\/dashboard\/people\/[0-9a-f-]{36}"/.test(r.html)
    ? ok("…and its names open the person's profile for someone who can open People")
    : bad("the attachment list does not link to profiles");
}
{
  const vendorId = (
    await client.query("select vendor_id from vendor_users where user_id = $1 limit 1", [vendorLogin.id])
  ).rows[0]?.vendor_id;
  const r = await page("oea.admin@oegroup.test", `/dashboard/vendors/${vendorId}`);
  r.text.includes("People at this company") && !r.text.includes("Nobody logs in for this company yet")
    ? ok("a vendor's page lists the people who log in for it (the two-FK embed is disambiguated)")
    : bad("the vendor page claims nobody logs in for a company with a live login");
}
{
  const r = await page("oea.finance@oegroup.test", profile(vendorLogin.id));
  const v = await page("oea.finance@oegroup.test", `/dashboard/vendors/${(
    await client.query("select vendor_id from vendor_users where user_id = $1 limit 1", [vendorLogin.id])
  ).rows[0]?.vendor_id}`);
  !/href="\/dashboard\/people\/[0-9a-f-]{36}"/.test(v.html) && !r.text.includes("Contact & account")
    ? ok("the Payment Officer is not handed profile links into a section they cannot open")
    : bad("a profile link was offered to a reader People refuses");
}

await client.end();

console.log(
  failures
    ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
    : "\n\x1b[32mALL CHECKS PASSED\x1b[0m — every row opens a profile, and every profile shows its reader only what their role already reaches."
);
process.exit(failures ? 1 : 0);
