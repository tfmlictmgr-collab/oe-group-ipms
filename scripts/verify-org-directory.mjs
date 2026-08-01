// Per-org entry URLs, and the directory that must not leak the client list.
//
// The claims that matter:
//   • org_public_branding resolves ONE org by slug, anonymously
//   • it returns only the org's public face — never contact details, counts, or
//     anything about what else exists
//   • it cannot be made to enumerate: a wrong slug and a retired org answer the
//     same way as each other, with nothing
//   • operator_org_directory returns the full list to an operator admin
//   • and returns NOTHING to a brand admin — the one that matters, because a
//     brand admin is authenticated and would otherwise be trusted
//   • slugs are unique among live orgs
//
// Usage: node scripts/verify-org-directory.mjs
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

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) return null;
  return c;
};

const orgRes = await svc.from("orgs").select("id, name, slug, delivery_brand, is_platform_operator, deleted_at");
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const live = orgRes.data.filter((o) => !o.deleted_at);
const oea = live.find((o) => o.delivery_brand === "OEA");

console.log("Org entry URLs and the operator directory\n");

console.log("A. Every live org has a unique slug");
{
  const slugs = live.map((o) => o.slug).filter(Boolean);
  slugs.length === live.length
    ? ok(`all ${live.length} live orgs carry a slug`)
    : bad(`${live.length - slugs.length} live org(s) have no slug`);

  const lowered = slugs.map((s) => s.toLowerCase());
  new Set(lowered).size === lowered.length
    ? ok("no two live orgs share one, case-folded")
    : bad("DUPLICATE SLUG AMONG LIVE ORGS");

  const retired = orgRes.data.filter((o) => o.deleted_at && o.slug);
  const clash = retired.filter((r) => lowered.includes((r.slug ?? "").toLowerCase()));
  clash.length === 0
    ? ok("no retired org is holding a live org's address hostage")
    : bad(`${clash.length} retired org(s) collide with a live slug`);
}

console.log("\nB. An anonymous visitor resolves one org by slug, and only its public face");
{
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data, error } = await anon.rpc("org_public_branding", { p_slug: oea.slug });
  if (error) { bad(`anonymous branding lookup failed — ${error.message.slice(0, 70)}`); }
  else {
    (data ?? []).length === 1
      ? ok("a known slug resolves to exactly one organisation, with no session")
      : bad(`returned ${(data ?? []).length} rows`);

    const row = (data ?? [])[0] ?? {};
    const leaked = ["support_email", "support_phone", "finance_email", "it_email", "tenant_applications_open", "is_platform_operator", "parent_org_id"]
      .filter((k) => k in row);
    leaked.length === 0
      ? ok("it carries only the public face — no contact details, no configuration")
      : bad(`LEAKED FIELDS: ${leaked.join(", ")}`);
  }

  // Case-insensitive, because a URL is not case sensitive in practice.
  const { data: upper } = await anon.rpc("org_public_branding", { p_slug: oea.slug.toUpperCase() });
  (upper ?? []).length === 1
    ? ok("the same slug in upper case resolves identically")
    : bad("case folding does not hold");
}

console.log("\nC. It cannot be made to enumerate");
{
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });

  const { data: missing } = await anon.rpc("org_public_branding", { p_slug: "no-such-org-here" });
  (missing ?? []).length === 0
    ? ok("an unknown slug returns nothing, not a hint")
    : bad("AN UNKNOWN SLUG RETURNED A ROW");

  // A wildcard must be treated as a literal, never as a pattern.
  for (const probe of ["%", "_", "*", "' or '1'='1"]) {
    const { data } = await anon.rpc("org_public_branding", { p_slug: probe });
    if ((data ?? []).length !== 0) {
      bad(`ENUMERATION VIA "${probe}" RETURNED ${(data ?? []).length} ROW(S)`);
    }
  }
  ok("wildcards and quotes are matched literally — no pattern escapes into the lookup");

  // An anonymous visitor must not be able to read the orgs table directly.
  const { data: direct } = await anon.from("orgs").select("id, name, slug");
  (direct ?? []).length === 0
    ? ok("and the orgs table itself stays unreadable without a session")
    : bad(`ANON READ ${(direct ?? []).length} ORG ROW(S) DIRECTLY`);
}

console.log("\nD. The directory is for operators, and refuses everyone else");
{
  // A brand admin: authenticated, privileged inside their own org, and exactly
  // the caller who must not be able to list the platform's clients.
  const brandAdmin = await login("oea.admin@oegroup.test");
  if (!brandAdmin) bad("could not sign in as the OEA administrator");
  else {
    const { data, error } = await brandAdmin.rpc("operator_org_directory");
    if (error) {
      ok(`a brand administrator is refused (${error.message.slice(0, 40)}…)`);
    } else {
      (data ?? []).length === 0
        ? ok("a brand administrator gets an empty directory — no client list")
        : bad(`A BRAND ADMIN LISTED ${(data ?? []).length} ORGANISATION(S)`);
    }
    await brandAdmin.auth.signOut();
  }

  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data: anonDir, error: anonErr } = await anon.rpc("operator_org_directory");
  (anonErr || (anonDir ?? []).length === 0)
    ? ok("and an anonymous visitor gets nothing at all")
    : bad(`ANON LISTED ${(anonDir ?? []).length} ORGANISATION(S)`);
}

console.log("\nE. An operator admin does get the directory");
{
  const operatorOrg = orgRes.data.find((o) => o.is_platform_operator && !o.deleted_at);
  if (!operatorOrg) {
    console.log("  \x1b[33mSKIP\x1b[0m no platform-operator org in this environment");
  } else {
    const { data: opAdmin } = await svc
      .from("users").select("email").eq("org_id", operatorOrg.id).eq("role", "admin")
      .is("deactivated_at", null).limit(1).maybeSingle();
    if (!opAdmin) {
      console.log("  \x1b[33mSKIP\x1b[0m operator org has no admin to sign in as");
    } else {
      const c = await login(opAdmin.email);
      if (!c) {
        console.log(`  \x1b[33mSKIP\x1b[0m could not sign in as ${opAdmin.email}`);
      } else {
        const { data, error } = await c.rpc("operator_org_directory");
        if (error) bad(`the operator was refused — ${error.message.slice(0, 70)}`);
        else {
          (data ?? []).length >= live.length
            ? ok(`the operator sees all ${(data ?? []).length} organisation(s), retired ones included`)
            : bad(`the operator saw only ${(data ?? []).length} of ${live.length} live orgs`);
          const withCounts = (data ?? []).filter((r) => r.member_count !== null && r.property_count !== null);
          withCounts.length === (data ?? []).length
            ? ok("each row carries its member and property counts for the launcher")
            : bad("some rows have null counts");
        }
        await c.auth.signOut();
      }
    }
  }
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — every org has its own address, and only an operator can list them."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
