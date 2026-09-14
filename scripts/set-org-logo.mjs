// Sets an org's logo the same way the Settings → LogoUpload UI does — uploads
// to the `org-logos` Storage bucket, then writes `orgs.logo_url` — just from a
// local file via the service role, instead of a browser upload.
//
// Path shape matches LogoUpload.tsx exactly (`{orgId}/logo-{timestamp}.{ext}`)
// because `saveLogoUrl`'s server action re-validates the URL against that same
// prefix before it will accept it — a URL from anywhere else is refused, by
// design, so a crafted value can't point the <img> at a third-party host.
//
// Usage:
//   node scripts/set-org-logo.mjs TFML ./scratchpad/tfml-logo.png
//   node scripts/set-org-logo.mjs OEA  ./scratchpad/oea-logo.png
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const [brandArg, filePath] = process.argv.slice(2);
if (!brandArg || !filePath) {
  console.error("\nUsage: node scripts/set-org-logo.mjs <TFML|OEA> <path-to-image>\n");
  process.exit(1);
}

const CONTENT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp" };
const ext = path.extname(filePath).slice(1).toLowerCase();
const contentType = CONTENT_TYPES[ext];
if (!contentType) {
  console.error(`\n"${filePath}" — unsupported extension .${ext}. Use png, jpg, svg or webp.\n`);
  process.exit(1);
}

const bytes = await readFile(path.resolve(rootDir, filePath));
if (bytes.length > 1024 * 1024) {
  console.error(`\nFile is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — LogoUpload's own limit is 1 MB.\n`);
  process.exit(1);
}

const BRANDS = { TFML: "TFML", OEA: "OEA" };
const brand = BRANDS[brandArg.toUpperCase()];
if (!brand) {
  console.error(`\nUnknown brand "${brandArg}". Use TFML or OEA.\n`);
  process.exit(1);
}

const { data: org, error: orgErr } = await svc
  .from("orgs").select("id, name, portal_name")
  .eq("delivery_brand", brand).is("deleted_at", null);
if (orgErr) { console.error(`\n${orgErr.message}\n`); process.exit(1); }
if (!org?.length) { console.error(`\nNo organisation with delivery_brand "${brand}".\n`); process.exit(1); }
if (org.length > 1) {
  // Same guard as register-whatsapp-number.mjs — delivery_brand is not unique,
  // and guessing which org gets the logo is exactly the fault that script hit.
  console.error(`\nAmbiguous: ${org.length} organisations share delivery_brand "${brand}". Refusing to guess.\n`);
  console.table(org);
  process.exit(1);
}
const orgId = org[0].id;

const objectPath = `${orgId}/logo-${Date.now()}.${ext}`;
const { error: upErr } = await svc.storage
  .from("org-logos")
  .upload(objectPath, bytes, { upsert: true, contentType });
if (upErr) { console.error(`\nUpload failed: ${upErr.message}\n`); process.exit(1); }

const { data: pub } = svc.storage.from("org-logos").getPublicUrl(objectPath);

const { error: updErr } = await svc.from("orgs").update({ logo_url: pub.publicUrl }).eq("id", orgId);
if (updErr) { console.error(`\nUploaded, but could not save logo_url: ${updErr.message}\n`); process.exit(1); }

console.log(`\nLogo set for ${org[0].portal_name || org[0].name}.`);
console.log(pub.publicUrl);
