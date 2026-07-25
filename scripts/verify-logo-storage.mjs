// Proves the org-logo storage rules: an admin can upload into their OWN org's
// prefix, cannot write into ANOTHER org's prefix, and a non-admin cannot upload
// at all. Enforced by storage RLS (0015), not by hiding the UI.
// Usage: node scripts/verify-logo-storage.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";
const BUCKET = "org-logos";

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
  const { data } = await c.from("users").select("org_id").eq("id", user.id).single();
  return data.org_id;
}

// A 1x1 PNG.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0)
);

const tfml = await login("tfml@oegroup.test");
const oea = await login("oea@oegroup.test");
const fm = await login("fm@oegroup.test");
const tfmlOrg = await orgOf(tfml);
const oeaOrg = await orgOf(oea);

console.log("Org logo storage rules (RLS-enforced)\n");
const stamp = Date.now();

console.log("A. An admin may upload into their OWN org prefix");
{
  const p = `${tfmlOrg}/logo-${stamp}.png`;
  const { error } = await tfml.storage
    .from(BUCKET)
    .upload(p, PNG, { contentType: "image/png", upsert: true });
  if (!error) ok(`uploaded ${p.slice(0, 20)}…`);
  else bad(`own-prefix upload was refused — ${error.message}`);
}

console.log("\nB. An admin may NOT upload into ANOTHER org's prefix");
{
  const p = `${oeaOrg}/hijack-${stamp}.png`;
  const { error } = await tfml.storage
    .from(BUCKET)
    .upload(p, PNG, { contentType: "image/png", upsert: true });
  if (error) ok(`blocked (${error.message.slice(0, 60)})`);
  else bad("ALLOWED — one brand could overwrite another brand's logo");
}

console.log("\nC. A non-admin may NOT upload at all");
{
  const p = `${tfmlOrg}/fm-${stamp}.png`;
  const { error } = await fm.storage
    .from(BUCKET)
    .upload(p, PNG, { contentType: "image/png", upsert: true });
  if (error) ok(`blocked (${error.message.slice(0, 60)})`);
  else bad("ALLOWED — a facility manager could change the org's logo");
}

console.log("\nD. Logos are publicly readable (they render pre-auth / cross-origin)");
{
  const { data } = tfml.storage.from(BUCKET).getPublicUrl(`${tfmlOrg}/logo-${stamp}.png`);
  const res = await fetch(data.publicUrl);
  if (res.ok) ok(`public URL returns ${res.status}`);
  else bad(`public URL returned ${res.status}`);
}

// Clean up the object this test created.
await tfml.storage.from(BUCKET).remove([`${tfmlOrg}/logo-${stamp}.png`]);
console.log("\n(removed the test upload)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — logo writes are admin-only and org-scoped."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
