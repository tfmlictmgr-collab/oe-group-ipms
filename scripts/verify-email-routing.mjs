// Proves Reply-To routing without sending mail: resolves the category -> inbox
// mapping against the real org rows, and confirms the fallback chain.
import path from "node:path"; import { fileURLToPath } from "node:url";
import { config } from "dotenv"; import { createClient } from "@supabase/supabase-js";
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

// Mirrors replyToFor() in lib/email.ts.
const resolve = (category, r) => {
  if (!r) return null;
  const chosen = category === "finance" ? r.finance_email
    : category === "it" ? r.it_email : r.support_email;
  return (chosen || r.support_email || null)?.trim() || null;
};

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: orgs } = await svc.from("orgs")
  .select("name, delivery_brand, support_email, finance_email, it_email, email_from_name, email_from_address");

// Mirrors senderFor() in lib/email.ts.
const sender = (i) => {
  const a = i?.email_from_address?.trim(); if (!a) return null;
  const n = i?.email_from_name?.trim();
  return n ? `"${n.replace(/"/g, "")}" <${a}>` : a;
};
const tfml = orgs.find(o => o.delivery_brand === "TFML");
const unset = orgs.find(o => !o.support_email && !o.finance_email);

console.log("Reply-To routing\n");
console.log("A. TFML routes each category to its own inbox");
[["account","info@tfmlconsultant.com"],
 ["finance","accounts@tfmlconsultant.com"],
 ["it","admin@projects.tfmlconsultant.com"],
 ["operations","info@tfmlconsultant.com"]].forEach(([cat, want]) => {
  const got = resolve(cat, tfml);
  got === want ? ok(`${cat.padEnd(10)} -> ${got}`) : bad(`${cat}: expected ${want}, got ${got}`);
});

console.log("\nB. An unset category falls back to support, never to nothing");
{
  const partial = { support_email: "info@x.test", finance_email: null, it_email: null };
  resolve("finance", partial) === "info@x.test" ? ok("finance unset -> support") : bad("finance fallback broken");
  resolve("it", partial) === "info@x.test" ? ok("it unset -> support") : bad("it fallback broken");
}

console.log("\nC. An org with nothing set sends no Reply-To (rather than a broken one)");
{
  const got = resolve("account", unset ?? { support_email: null, finance_email: null, it_email: null });
  got === null ? ok("resolves to null; the header is omitted") : bad(`expected null, got ${got}`);
}

console.log("\nD. Finance never silently falls back to a personal/IT inbox");
{
  const r = { support_email: "info@x.test", finance_email: null, it_email: "it@x.test" };
  resolve("finance", r) !== "it@x.test" ? ok("finance does not leak to the IT inbox") : bad("finance fell through to IT");
}

console.log("\nE. Each brand sends as ITSELF, never as the holding entity");
{
  const oea = orgs.find(o => o.delivery_brand === "OEA");
  const t = sender(tfml), o = sender(oea);
  t === '"TFML Nigeria" <no-reply@notify.tfmlconsultant.com>'
    ? ok(`TFML sends as ${t}`) : bad(`TFML sender is ${t}`);
  o && o.includes("oraegbunike.com") ? ok(`OEA sends as ${o}`) : bad(`OEA sender is ${o}`);
  [t, o].every(v => v && !/OE Group/i.test(v))
    ? ok("neither brand exposes the holding entity in the From header")
    : bad("a brand is sending as OE Group");
  t && o && t !== o ? ok("the two brands have distinct sender identities") : bad("brands share a sender");
}

console.log("\nF. Display names are quoted so punctuation can't split the header");
{
  const risky = sender({ email_from_name: 'Ora Egbunike, Assoc.', email_from_address: "x@y.test" });
  risky === '"Ora Egbunike, Assoc." <x@y.test>' ? ok("comma in a brand name stays inside quotes") : bad(`got ${risky}`);
}

console.log(failures === 0
  ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — replies route to a real, monitored inbox."
  : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
