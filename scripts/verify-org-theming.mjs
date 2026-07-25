// Proves the per-org theming write path is safe:
//   1. an admin CAN rebrand their own org,
//   2. an admin CANNOT rebrand another org (cross-brand hijack),
//   3. a non-admin CANNOT rebrand even their own org.
// Enforced by RLS (orgs_admin_update), not just by hiding the UI.
// Usage: node scripts/verify-org-theming.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

async function login(email) {
  const c = createClient(URL, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}
async function orgOf(c) {
  const { data: { user } } = await c.auth.getUser();
  const { data, error } = await c.from("users").select("org_id").eq("id", user.id).single();
  if (error || !data) throw new Error(`could not read org for ${user?.email}: ${error?.message}`);
  return data.org_id;
}

const tfml = await login("tfml@oegroup.test");
const oea = await login("oea@oegroup.test");
const fm = await login("fm@oegroup.test");

const tfmlOrg = await orgOf(tfml);
const oeaOrg = await orgOf(oea);
const fmOrg = await orgOf(fm);

console.log("Per-org theming write path (RLS-enforced)\n");

console.log("A. An admin may rebrand their OWN org");
{
  const { data, error } = await tfml
    .from("orgs")
    .update({ theme_primary: "#0F766E", theme_logo_text: "TX" })
    .eq("id", tfmlOrg)
    .select("theme_primary, theme_logo_text");
  if (!error && data?.length === 1 && data[0].theme_primary === "#0F766E") {
    ok(`TFML admin set primary=${data[0].theme_primary} mono=${data[0].theme_logo_text}`);
  } else {
    bad(`expected own-org update to succeed — ${error?.message ?? "no rows returned"}`);
  }
}

console.log("\nB. An admin may NOT rebrand ANOTHER org (cross-brand hijack)");
{
  const { data, error } = await tfml
    .from("orgs")
    .update({ theme_primary: "#000000" })
    .eq("id", oeaOrg)
    .select("id");
  if (error) ok(`blocked (${error.message.split("\n")[0].slice(0, 60)})`);
  else if (!data || data.length === 0) ok("blocked (0 rows — RLS refused)");
  else bad("ALLOWED — a brand could repaint another brand's portal");
}

console.log("\nC. A non-admin may NOT rebrand even their own org");
{
  const { data, error } = await fm
    .from("orgs")
    .update({ theme_primary: "#123456" })
    .eq("id", fmOrg)
    .select("id");
  if (error) ok(`blocked (${error.message.split("\n")[0].slice(0, 60)})`);
  else if (!data || data.length === 0) ok("blocked (0 rows — RLS refused)");
  else bad("ALLOWED — a facility manager could rebrand the portal");
}

console.log("\nD. OEA's theme is untouched by TFML's activity");
{
  const { data } = await oea.from("orgs").select("theme_primary").eq("id", oeaOrg).single();
  if (data?.theme_primary === null || data?.theme_primary === undefined) {
    ok("OEA still on its brand default (never overwritten)");
  } else if (data.theme_primary === "#000000") {
    bad("OEA was repainted by the TFML admin — isolation broken");
  } else {
    ok(`OEA has its own value (${data.theme_primary}), not TFML's`);
  }
}

// Reset TFML back to its brand default so the dev data stays clean.
await tfml.from("orgs").update({ theme_primary: null, theme_logo_text: null }).eq("id", tfmlOrg);
console.log("\n(reset TFML theme overrides back to brand defaults)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — theming is admin-only and org-scoped."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
