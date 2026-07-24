// Proves Day 2 layer 2 — JWT org claims + the anti-spoof brand-header logic.
//   1. Sign in as real users, decode the returned access_token, and assert its
//      app_metadata.{org_id,delivery_brand,role} match the users/orgs tables.
//   2. Assert two different-brand users carry different org claims (isolation).
//   3. Unit-test applyTrustedOrgHeaders: a client-supplied x-org-id is stripped
//      and replaced by the claim; with no claim the header is absent.
// Run with tsx so the real TS helper is exercised: npx tsx scripts/verify-jwt-claims.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { applyTrustedOrgHeaders, ORG_HEADER, BRAND_HEADER } from "../lib/org-headers.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

async function claimFor(email) {
  const c = createClient(URL, ANON);
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  const p = decode(data.session.access_token);
  return p.app_metadata ?? {};
}

console.log("Day 2 JWT org claims\n");

console.log("A. Signed-token claim matches the DB, per user");
const cases = [
  ["finance@oegroup.test", "direct"],
  ["tfml@oegroup.test", "TFML"],
  ["oea@oegroup.test", "OEA"],
];
const claims = {};
for (const [email, expectBrand] of cases) {
  const claim = await claimFor(email);
  claims[email] = claim;
  const { data: dbUser } = await svc.from("users").select("org_id, role").eq("email", email).single();
  const orgMatch = claim.org_id === dbUser.org_id;
  const brandMatch = claim.delivery_brand === expectBrand;
  const roleMatch = claim.role === dbUser.role;
  if (orgMatch && brandMatch && roleMatch)
    ok(`${email}: org+brand(${expectBrand})+role(${dbUser.role}) all in the JWT and match DB`);
  else bad(`${email}: org=${orgMatch} brand=${brandMatch}(${claim.delivery_brand}) role=${roleMatch}`);
}

console.log("\nB. Cross-brand claims are distinct (isolation in the token itself)");
if (claims["tfml@oegroup.test"].org_id !== claims["oea@oegroup.test"].org_id)
  ok("TFML and OEA users carry different org_id claims");
else bad("TFML and OEA share an org claim");

console.log("\nC. applyTrustedOrgHeaders strips client spoofing, sets from claim");
{
  const h = new Headers();
  h.set(ORG_HEADER, "SPOOFED-ORG");           // attacker-supplied
  h.set(BRAND_HEADER, "SPOOFED-BRAND");
  applyTrustedOrgHeaders(h, { orgId: "real-org-123", brand: "OEA", role: "admin" });
  if (h.get(ORG_HEADER) === "real-org-123" && h.get(BRAND_HEADER) === "OEA")
    ok("spoofed x-org-id/x-delivery-brand overwritten by the claim");
  else bad(`spoof survived: org=${h.get(ORG_HEADER)} brand=${h.get(BRAND_HEADER)}`);
}
{
  const h = new Headers();
  h.set(ORG_HEADER, "SPOOFED-ORG");
  applyTrustedOrgHeaders(h, {});               // no authenticated claim
  if (h.get(ORG_HEADER) === null) ok("no claim → spoofed header stripped, left absent");
  else bad(`header not stripped: ${h.get(ORG_HEADER)}`);
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — org/brand/role ride in the signed JWT; headers are un-spoofable."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
