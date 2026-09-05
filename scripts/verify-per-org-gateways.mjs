// Per-org payment gateway accounts (0156).
//
// ⚠️ What this closes. `getGateway()` read PAYSTACK_SECRET_KEY from the
// environment — ONE key pair for the whole platform. Every collection from
// every organisation landed in the same merchant account and every transfer
// drew on the same balance. With one live client that is invisible; with two
// brands and a service-charge client it is a TFML vendor paid out of OEA's
// money.
//
// 📌 The brief said to mirror "the existing Flutterwave per-org pattern". There
// was none — Flutterwave was a global env var too, and verify-fx-collections
// proves per-CURRENCY ledger segregation, not per-ORG gateway segregation. The
// pattern actually followed is `channel_routes` (0039/0047): per-org
// credentials, no policies, no grants, service-role only.
//
// Usage: node scripts/verify-per-org-gateways.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

if (!URL_ || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
if (/prod/i.test(URL_)) {
  console.error("Refusing to run: target looks like production. This writes fixture rows.");
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
};

// Same envelope the application uses. Duplicated here deliberately: if this
// drifts from lib/gateway/credentials.ts the suite should fail, because a
// credential the app cannot decrypt is a payment path that is down.
const KEY = process.env.GATEWAY_CREDENTIAL_KEY;
const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(KEY, "base64"), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
};
const decrypt = (payload) => {
  const [iv, tag, data] = payload.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(KEY, "base64"), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
};

const { data: orgs } = await svc.from("orgs")
  .select("id, slug, gateway_tag, is_platform_operator").is("deleted_at", null);
const a = orgs.find((o) => o.slug === "tfml");
const b = orgs.find((o) => o.slug === "oea");
if (!a || !b) { console.error("Need the tfml and oea orgs seeded."); process.exit(2); }

console.log("\nPer-org payment gateways (0156)\n");

// ---------------------------------------------------------------------------
console.log("1. Every org has a distinct reference tag");
// ---------------------------------------------------------------------------
{
  const tags = orgs.filter((o) => o.gateway_tag).map((o) => o.gateway_tag);
  tags.length === orgs.length
    ? ok(`all ${orgs.length} orgs carry a tag`)
    : bad(`${orgs.length - tags.length} org(s) have no gateway_tag`);
  new Set(tags).size === tags.length
    ? ok("and every tag is unique — a shared tag would route a webhook to the wrong key")
    : bad("TWO ORGS SHARE A GATEWAY TAG");
  tags.every((t) => /^[A-Z0-9]{6}$/.test(t))
    ? ok("each is six opaque characters, granting nothing")
    : bad(`malformed tag(s): ${tags.filter((t) => !/^[A-Z0-9]{6}$/.test(t)).join(", ")}`);
}

// ---------------------------------------------------------------------------
console.log("\n2. A reference resolves to the org that minted it");
// ---------------------------------------------------------------------------
{
  const refA = `OE-${a.gateway_tag}-SE-TEST-0001`;
  const { data: gotA } = await svc.rpc("payment_reference_org_tag", { p_reference: refA });
  gotA === a.id ? ok("a tagged reference finds its org") : bad(`resolved to ${gotA}, expected ${a.id}`);

  const { data: gotB } = await svc.rpc("payment_reference_org_tag", {
    p_reference: `OE-${b.gateway_tag}-SE-TEST-0002`,
  });
  gotB === b.id ? ok("and a different org's reference finds a different org") : bad(`resolved to ${gotB}`);

  // ⚠️ The compatibility case that matters on deploy day.
  const { data: legacy } = await svc.rpc("payment_reference_org_tag", {
    p_reference: "OE-SE-M9X2K1-A4B7C2",
  });
  legacy === null
    ? ok("a pre-0156 reference resolves to null — it verifies against the platform key, not a wrong one")
    : bad(`a legacy reference resolved to ${legacy} — in-flight payments would break`);

  const { data: junk } = await svc.rpc("payment_reference_org_tag", { p_reference: "'; drop table orgs; --" });
  junk === null ? ok("and junk resolves to null rather than matching anything") : bad(`junk resolved to ${junk}`);
}

// ---------------------------------------------------------------------------
console.log("\n3. The credential table is unreachable from a signed-in session");
// ---------------------------------------------------------------------------
{
  const c = await login("tfml.admin@oegroup.test");
  const { data, error } = await c.from("org_gateway_credentials").select("secret_key_enc").limit(1);
  (error || (data ?? []).length === 0)
    ? ok(`an administrator cannot read the credential table (${(error?.message ?? "empty").slice(0, 46)})`)
    : bad("!!! AN ADMINISTRATOR READ STORED GATEWAY CIPHERTEXT");

  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data: ad, error: ae } = await anon.from("org_gateway_credentials").select("secret_key_enc").limit(1);
  (ae || (ad ?? []).length === 0)
    ? ok("and anon certainly cannot")
    : bad("!!! ANON READ STORED GATEWAY CIPHERTEXT");
  await c.auth.signOut();
}

// ---------------------------------------------------------------------------
console.log("\n4. Storing and resolving a credential");
// ---------------------------------------------------------------------------
if (!KEY) {
  console.log("  – skipped: GATEWAY_CREDENTIAL_KEY not set in this environment");
} else {
  const secretA = "sk_test_" + "A".repeat(24);
  const secretB = "sk_test_" + "B".repeat(24);

  await svc.from("org_gateway_credentials").delete().in("org_id", [a.id, b.id]);

  const store = async (org, secret) => {
    const { error } = await svc.rpc("set_org_gateway_credential", {
      p_gateway: "paystack", p_public_key: "pk_test_probe",
      p_secret_enc: encrypt(secret), p_webhook_enc: encrypt("whsec_" + org.slug),
      p_key_mode: "test", p_secret_last4: secret.slice(-4), p_org_id: org.id,
    });
    return error;
  };

  const eA = await store(a, secretA);
  const eB = await store(b, secretB);
  (!eA && !eB) ? ok("both orgs' credentials stored") : bad(`store failed: ${eA?.message ?? eB?.message}`);

  const readBack = async (org) => {
    const { data } = await svc.from("org_gateway_credentials")
      .select("secret_key_enc, key_mode, secret_last4")
      .eq("org_id", org.id).eq("gateway", "paystack").eq("active", true).maybeSingle();
    return data;
  };

  const rA = await readBack(a);
  const rB = await readBack(b);

  rA?.secret_key_enc !== secretA && !String(rA?.secret_key_enc ?? "").includes(secretA)
    ? ok("the stored value is ciphertext, not the key")
    : bad("!!! THE SECRET KEY IS STORED IN PLAINTEXT");

  decrypt(rA.secret_key_enc) === secretA && decrypt(rB.secret_key_enc) === secretB
    ? ok("each org decrypts to ITS OWN key — the segregation that stops a TFML payout drawing on OEA's balance")
    : bad("!!! AN ORG RESOLVED THE WRONG KEY");

  rA.secret_last4 === secretA.slice(-4)
    ? ok("last four recorded for identification, which cannot reconstruct a key")
    : bad(`last4 was ${rA.secret_last4}`);

  // Tamper-evidence: GCM must refuse a modified ciphertext rather than yield a
  // wrong key that would be sent to Paystack as a live credential.
  {
    const [iv, tag, data] = rA.secret_key_enc.split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    let threw = false;
    try { decrypt([iv, tag, flipped.toString("base64")].join(":")); } catch { threw = true; }
    threw ? ok("a tampered credential throws rather than decrypting to something wrong")
          : bad("!!! TAMPERED CIPHERTEXT DECRYPTED");
  }

  // Superseding keeps the old row rather than overwriting it.
  await store(a, "sk_test_" + "C".repeat(24));
  const { data: rows } = await svc.from("org_gateway_credentials")
    .select("active").eq("org_id", a.id).eq("gateway", "paystack");
  const actives = (rows ?? []).filter((r) => r.active).length;
  actives === 1 && (rows ?? []).length === 2
    ? ok("replacing a key supersedes rather than overwrites — when it changed stays on the record")
    : bad(`after replacement: ${rows?.length} row(s), ${actives} active`);

  await svc.from("org_gateway_credentials").delete().in("org_id", [a.id, b.id]);
}

// ---------------------------------------------------------------------------
console.log("\n5. Only an administrator of the owning org may connect one");
// ---------------------------------------------------------------------------
if (KEY) {
  const enc = encrypt("sk_test_" + "Z".repeat(24));

  const fin = await login("tfml.financeapprover@oegroup.test");
  const { error: finErr } = await fin.rpc("set_org_gateway_credential", {
    p_gateway: "paystack", p_public_key: null, p_secret_enc: enc, p_webhook_enc: null,
    p_key_mode: "test", p_secret_last4: "ZZZZ", p_org_id: null,
  });
  finErr ? ok("finance cannot connect a gateway — it is the account, not a payment out of it")
         : bad("!!! FINANCE CONNECTED A GATEWAY ACCOUNT");
  await fin.auth.signOut();

  // Cross-org: a TFML admin naming OEA's id.
  const adm = await login("tfml.admin@oegroup.test");
  const { error: crossErr } = await adm.rpc("set_org_gateway_credential", {
    p_gateway: "paystack", p_public_key: null, p_secret_enc: enc, p_webhook_enc: null,
    p_key_mode: "test", p_secret_last4: "ZZZZ", p_org_id: b.id,
  });
  crossErr ? ok("and cannot connect one for ANOTHER organisation")
           : bad("!!! A TFML ADMIN SET OEA'S GATEWAY CREDENTIALS");
  await adm.auth.signOut();

  await svc.from("org_gateway_credentials").delete().in("org_id", [a.id, b.id]);
}

// ---------------------------------------------------------------------------
console.log("\n6. The status view tells the org what it needs and no more");
// ---------------------------------------------------------------------------
if (KEY) {
  await svc.rpc("set_org_gateway_credential", {
    p_gateway: "paystack", p_public_key: "pk_test_probe",
    p_secret_enc: encrypt("sk_live_" + "Q".repeat(24)), p_webhook_enc: null,
    p_key_mode: "live", p_secret_last4: "QQQQ", p_org_id: a.id,
  });

  const c = await login("tfml.admin@oegroup.test");
  const { data } = await c.rpc("org_gateway_status", { p_org_id: null });
  const row = (data ?? [])[0];

  row?.key_mode === "live"
    ? ok("an administrator learns the key is LIVE — the one fact that decides whether real money moves")
    : bad(`status did not report the mode: ${JSON.stringify(row)}`);

  Object.values(row ?? {}).every((v) => !String(v).startsWith("sk_"))
    ? ok("and no field carries a secret key")
    : bad("!!! THE STATUS VIEW LEAKED A KEY");

  // Another org's status is not reachable through the parameter.
  const { data: other } = await c.rpc("org_gateway_status", { p_org_id: b.id });
  (other ?? []).length === 0
    ? ok("asking for another org's status returns nothing")
    : bad("!!! READ ANOTHER ORG'S GATEWAY STATUS");
  await c.auth.signOut();

  await svc.from("org_gateway_credentials").delete().in("org_id", [a.id, b.id]);
}

console.log(failures === 0
  ? "\n\x1b[32mAll per-org gateway checks passed.\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
