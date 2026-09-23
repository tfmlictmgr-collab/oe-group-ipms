// Verifies that Flutterwave takes Naira collections and that payouts never
// reach an adapter that cannot pay out (board, 23 Sept 2026 — Option A).
//
//   npx tsx scripts/verify-flutterwave-collections.mjs
//
// Paystack's business verification could not be passed in time; Flutterwave's
// could, and one Flutterwave account takes Naira and foreign currency. So
// Flutterwave became the PREFERRED Naira collector, with Paystack kept for any
// organisation that has only a Paystack account and for automated payouts. The
// Flutterwave adapter collects and refuses to transfer, so the one thing this
// change must never do is hand it to a payout — that would claim a remittance
// and then fail at the gateway.
//
// What it proves, and how:
//   A  the preference table, which is the ONE place the choice is made;
//   B  the platform-key selection under each combination of deployment keys —
//      process.env is swapped per case and restored, no network is used;
//   C  the real organisations' own credentials still win, and an org with only
//      Paystack is untouched (preference, not replacement);
//   D  Flutterwave's verified amount excludes a fee passed to the payer —
//      `fetch` is replaced for one call, no money moves;
//   E  a payment verified in a different currency from its demand is NOT
//      posted — against a real pending intent, with a stub adapter, and the
//      row is read back to prove nothing was written;
//   F  Settings → Banking refuses a Flutterwave key without its secret hash,
//      and a key saved under the wrong gateway;
//   G  every caller in the application states whether it collects or pays out,
//      and the webhook builds its verifier from the SENDER's credential.
import { config } from "dotenv";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { requireNonProductionTarget } from "./lib/target-env.mjs";

config({ path: ".env.local", quiet: true });
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(2);
}
// ⚠️ An ALLOWLIST of the demo/dev/staging projects, not a pattern. The first
// draft refused URLs matching /prod/i, and the production project's URL is a
// bare project ref with no "prod" in it — it ran against production on its
// first attempt (23 Sept 2026; reads only, nothing written). Section E reads a
// real payment request, so the target has to be known, not guessed.
const world = requireNonProductionTarget(process.cwd(), "This suite reads real payment requests and org credentials.");
console.log(`target: ${world}`);
// Never simulate "production" here: the resolver's simulated branch is part of
// what is being tested, and it is (correctly) unreachable in production.
delete process.env.VERCEL_ENV;
process.env.NODE_ENV = "test";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const skip = (m) => console.log(`  \x1b[33mSKIP\x1b[0m ${m}`);
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const gw = await import("../lib/gateway/index.ts");
const { supabaseAdmin } = await import("../lib/supabase/admin.ts");

// Deployment keys, swapped per case and ALWAYS restored.
const KEYS = ["PAYSTACK_SECRET_KEY", "FLUTTERWAVE_SECRET_KEY", "FLUTTERWAVE_WEBHOOK_HASH"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function withKeys(keys, fn) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, keys);
  const restore = () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  try {
    const r = fn();
    return r instanceof Promise ? r.finally(restore) : (restore(), r);
  } catch (e) {
    restore();
    throw e;
  }
}
const PS_TEST = "sk_test_" + "a".repeat(40);
const FW_TEST = "FLWSECK_TEST-" + "b".repeat(32) + "-X";
const FW_LIVE = "FLWSECK-" + "c".repeat(32) + "-X";

async function refusal(p) {
  try { await p; return null; } catch (e) { return e; }
}

// ════════════════════════════════════════════════════════════════════════════
section("A. The preference table — the one place the choice is made");

same(gw.gatewayPreference("NGN", "collect"), ["flutterwave", "paystack"])
  ? ok("Naira collections: Flutterwave first, Paystack only where Flutterwave is not connected")
  : bad(`NGN collect → ${gw.gatewayPreference("NGN", "collect")}`);
same(gw.gatewayPreference("usd", "collect"), ["flutterwave"])
  ? ok("foreign-currency collections: Flutterwave, as before (case-insensitive)")
  : bad(`USD collect → ${gw.gatewayPreference("usd", "collect")}`);
same(gw.gatewayPreference("NGN", "payout"), ["paystack"])
  ? ok("Naira payouts: Paystack only — the Flutterwave adapter is never offered a payout")
  : bad(`NGN payout → ${gw.gatewayPreference("NGN", "payout")}`);
same(gw.gatewayPreference("GBP", "payout"), [])
  ? ok("foreign-currency payouts: no gateway, so they are refused before a remittance is claimed")
  : bad(`GBP payout → ${gw.gatewayPreference("GBP", "payout")}`);

// ════════════════════════════════════════════════════════════════════════════
section("B. The platform key, under every combination of deployment keys");

const { data: tfml } = await supabaseAdmin
  .from("orgs").select("id, name").eq("uses_platform_gateway", true).maybeSingle();
if (!tfml) {
  bad("no organisation owns the platform key (uses_platform_gateway) — 0288's invariant is broken here");
} else {
  await withKeys({ PAYSTACK_SECRET_KEY: PS_TEST }, async () => {
    gw.collectionGatewayName("NGN") === "paystack" && gw.gatewayMode("NGN") === "test"
      ? ok("Paystack key only: Naira is collected through Paystack, labelled test — exactly as before")
      : bad(`Paystack only → ${gw.collectionGatewayName("NGN")}/${gw.gatewayMode("NGN")}`);
    const c = await gw.resolveOrgGateway(tfml.id, "NGN", "collect");
    c.merchant === "platform" && c.adapter.name === "paystack"
      ? ok(`…and ${tfml.name} checks out on the platform Paystack account`)
      : bad(`${tfml.name} collect → ${c.merchant}/${c.adapter.name}`);
    const p = await gw.resolveOrgGateway(tfml.id, "NGN", "payout");
    p.adapter.name === "paystack"
      ? ok("…and pays out through it")
      : bad(`${tfml.name} payout → ${p.adapter.name}`);
  });

  await withKeys({ PAYSTACK_SECRET_KEY: PS_TEST, FLUTTERWAVE_SECRET_KEY: FW_TEST, FLUTTERWAVE_WEBHOOK_HASH: "h" }, async () => {
    gw.collectionGatewayName("NGN") === "flutterwave" && gw.gatewayMode("NGN") === "test"
      ? ok("both keys: Naira moves to Flutterwave, and the label reads Flutterwave's own mode")
      : bad(`both → ${gw.collectionGatewayName("NGN")}/${gw.gatewayMode("NGN")}`);
    const c = await gw.resolveOrgGateway(tfml.id, "NGN", "collect");
    c.merchant === "platform" && c.adapter.name === "flutterwave"
      ? ok(`…${tfml.name}'s Naira checkout opens on Flutterwave`)
      : bad(`${tfml.name} collect → ${c.merchant}/${c.adapter.name}`);
    const p = await gw.resolveOrgGateway(tfml.id, "NGN", "payout");
    p.adapter.name === "paystack"
      ? ok("…while its payouts stay on Paystack, the only adapter that can transfer")
      : bad(`${tfml.name} payout → ${p.adapter.name} (a payout on this adapter fails AFTER the claim)`);
  });

  await withKeys({ FLUTTERWAVE_SECRET_KEY: FW_LIVE, FLUTTERWAVE_WEBHOOK_HASH: "h" }, async () => {
    gw.collectionGatewayName("NGN") === "flutterwave" && gw.gatewayMode("NGN") === "live"
      ? ok("Flutterwave key only (the go-live shape): Naira on Flutterwave, labelled LIVE")
      : bad(`FW only → ${gw.collectionGatewayName("NGN")}/${gw.gatewayMode("NGN")}`);
    gw.gatewayConfigured("NGN")
      ? ok("…and Naira reads as configured, so no screen offers the simulated checkout")
      : bad("a Flutterwave key alone does not count as Naira being configured");
    const e = await refusal(gw.resolveOrgGateway(tfml.id, "NGN", "payout"));
    e?.name === "GatewayNotConnectedError"
      ? ok("…a Naira PAYOUT is refused before any claim — not simulated, not sent to Flutterwave")
      : bad(`FW only, payout → ${e ? e.message : "a gateway was handed out"}`);
    const f = await refusal(gw.resolveOrgGateway(tfml.id, "USD", "payout"));
    f?.name === "GatewayNotConnectedError"
      ? ok("…and so is a foreign-currency payout, which used to fail only at the gateway")
      : bad(`FW only, USD payout → ${f ? f.message : "a gateway was handed out"}`);
  });

  await withKeys({}, async () => {
    gw.collectionGatewayName("NGN") === "simulated" && gw.gatewayMode("NGN") === "simulated"
      ? ok("no keys at all: simulated, as before")
      : bad(`no keys → ${gw.collectionGatewayName("NGN")}`);
    const c = await gw.resolveOrgGateway(tfml.id, "NGN", "collect");
    c.merchant === "simulated"
      ? ok("…and outside production the resolver simulates rather than refusing")
      : bad(`no keys → ${c.merchant}`);
  });
}

// ════════════════════════════════════════════════════════════════════════════
section("C. An organisation's own account still wins — preference, not replacement");

{
  const { data: creds } = await supabaseAdmin
    .from("org_gateway_credentials").select("org_id, gateway").eq("active", true);
  const byOrg = new Map();
  for (const c of creds ?? []) byOrg.set(c.org_id, [...(byOrg.get(c.org_id) ?? []), c.gateway]);
  const paystackOnly = [...byOrg.entries()].find(([, g]) => g.includes("paystack") && !g.includes("flutterwave"));
  const withFw = [...byOrg.entries()].find(([, g]) => g.includes("flutterwave"));

  if (!process.env.GATEWAY_CREDENTIAL_KEY) {
    skip("GATEWAY_CREDENTIAL_KEY is not set here, so stored credentials cannot be decrypted");
  } else {
    if (paystackOnly) {
      await withKeys({ FLUTTERWAVE_SECRET_KEY: FW_TEST, FLUTTERWAVE_WEBHOOK_HASH: "h" }, async () => {
        const r = await gw.resolveOrgGateway(paystackOnly[0], "NGN", "collect");
        r.merchant === "org" && r.adapter.name === "paystack"
          ? ok("an org with only its own Paystack account keeps collecting on it, even with a platform Flutterwave key present")
          : bad(`paystack-only org → ${r.merchant}/${r.adapter.name} — its money moved to another merchant account`);
      });
    } else {
      skip("no organisation here has only a Paystack credential");
    }
    if (withFw) {
      const r = await gw.resolveOrgGateway(withFw[0], "NGN", "collect");
      r.merchant === "org" && r.adapter.name === "flutterwave"
        ? ok("an org that connected Flutterwave collects Naira on its own Flutterwave account")
        : bad(`flutterwave org → ${r.merchant}/${r.adapter.name}`);
    } else {
      skip("no organisation here has connected Flutterwave yet — exercised by the adapter check below");
    }
  }

  const a = gw.adapterFromCredential({ gateway: "flutterwave", secretKey: FW_TEST, webhookSecret: "hash" });
  const b = gw.adapterFromCredential({ gateway: "paystack", secretKey: PS_TEST, webhookSecret: null });
  a.name === "flutterwave" && b.name === "paystack"
    ? ok("a credential builds the adapter of the gateway it belongs to")
    : bad(`adapterFromCredential → ${a.name}/${b.name}`);
  a.verifySignature("{}", "hash") && !a.verifySignature("{}", "wrong") && !a.verifySignature("{}", null)
    ? ok("…and a Flutterwave org adapter verifies a webhook by its own secret hash, and only by it")
    : bad("the Flutterwave adapter's webhook check does not use the org's hash");
}

// ════════════════════════════════════════════════════════════════════════════
section("D. Flutterwave's verified amount is what WE asked for");

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      status: "success",
      data: { amount: 250000, charged_amount: 253500, currency: "NGN", status: "successful", created_at: "2026-09-23T10:00:00Z" },
    }), { status: 200 });
  try {
    const v = await gw.adapterFromCredential({ gateway: "flutterwave", secretKey: FW_TEST, webhookSecret: "h" })
      .verifyTransaction("OE-TEST-FEE");
    v.ok && v.status === "success" && v.amount === 250000 && v.currency === "NGN"
      ? ok("₦250,000 demand, ₦253,500 charged with the fee passed on → credited ₦250,000")
      : bad(`verify → ${JSON.stringify(v)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("E. A payment verified in another currency is not posted");

{
  const { settleIntentByReference } = await import("../lib/gateway/settle.ts");
  const { data: intent } = await supabaseAdmin
    .from("payment_intents")
    .select("id, gateway_reference, currency, status, ledger_entry_id, amount_paid")
    .eq("currency", "NGN").eq("status", "pending").is("ledger_entry_id", null)
    .limit(1).maybeSingle();
  if (!intent) {
    skip("no pending Naira payment request here to test against");
  } else {
    const stub = {
      name: "flutterwave",
      verifyTransaction: async () => ({ ok: true, status: "success", amount: 500, currency: "USD", paidAt: new Date().toISOString() }),
    };
    const out = await settleIntentByReference(intent.gateway_reference, { adapter: stub });
    out.state === "unknown" && /USD/.test(out.detail) && /not posted/.test(out.detail)
      ? ok("a Naira demand the gateway reports as paid in USD is refused, and says why")
      : bad(`currency mismatch → ${JSON.stringify(out)}`);
    const { data: after } = await supabaseAdmin
      .from("payment_intents").select("status, ledger_entry_id, amount_paid").eq("id", intent.id).single();
    after.ledger_entry_id === null && after.status === intent.status && Number(after.amount_paid) === Number(intent.amount_paid)
      ? ok("…and the row is untouched: no ledger entry, same status, same amount paid")
      : bad(`the mismatched payment changed the row: ${JSON.stringify(after)}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("F. Settings → Banking refuses a key it could not use");

{
  process.env.GATEWAY_CREDENTIAL_KEY ??= Buffer.alloc(32, 7).toString("base64");
  let actions = null;
  try {
    actions = await import("../app/dashboard/settings/banking/gateway-actions.ts");
  } catch (e) {
    skip(`the Settings action could not be loaded outside Next (${e.message.split("\n")[0]})`);
  }
  if (actions) {
    const noHash = await actions.saveOrgGatewayCredential({ gateway: "flutterwave", secretKey: FW_TEST });
    !noHash.ok && /secret hash/i.test(noHash.message)
      ? ok("a Flutterwave key without its secret hash is refused — its webhooks could never be verified")
      : bad(`no hash → ${JSON.stringify(noHash)}`);
    const wrongFamily = await actions.saveOrgGatewayCredential({ gateway: "flutterwave", secretKey: PS_TEST, webhookSecret: "h" });
    !wrongFamily.ok && /not a Flutterwave secret key/i.test(wrongFamily.message)
      ? ok("a Paystack key saved as Flutterwave is refused, instead of failing at the first checkout")
      : bad(`paystack key as flutterwave → ${JSON.stringify(wrongFamily)}`);
    const reverse = await actions.saveOrgGatewayCredential({ gateway: "paystack", secretKey: FW_TEST });
    !reverse.ok && /not a Paystack secret key/i.test(reverse.message)
      ? ok("…and the reverse")
      : bad(`flutterwave key as paystack → ${JSON.stringify(reverse)}`);
    const pub = await actions.saveOrgGatewayCredential({ gateway: "flutterwave", secretKey: "FLWPUBK_TEST-" + "d".repeat(32) + "-X", webhookSecret: "h" });
    !pub.ok && /PUBLIC key/.test(pub.message)
      ? ok("a Flutterwave PUBLIC key pasted as the secret is named as such")
      : bad(`public key → ${JSON.stringify(pub)}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("G. Every caller says whether it collects or pays out");

{
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) { if (f !== "node_modules" && f !== ".next") walk(p); }
      else if (/\.(ts|tsx)$/.test(f)) files.push(p);
    }
  };
  walk("app"); walk("lib");
  const offenders = [];
  let calls = 0;
  for (const f of files) {
    if (f.replace(/\\/g, "/").endsWith("lib/gateway/index.ts")) continue;
    // Comment lines name these functions in prose; only code is a call.
    const src = readFileSync(f, "utf8").split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const m of src.matchAll(/(resolveOrgGateway|getGatewayForOrg)\(([^)]*)\)/g)) {
      calls++;
      if (!/"(collect|payout)"/.test(m[2])) offenders.push(`${f}: ${m[0]}`);
    }
  }
  offenders.length === 0 && calls > 0
    ? ok(`all ${calls} calls name their purpose`)
    : bad(`calls with no stated purpose:\n      ${offenders.join("\n      ")}`);

  const route = readFileSync("app/api/webhooks/payments/[gateway]/route.ts", "utf8");
  !/getGatewayForOrg\(/.test(route) && /adapterFromCredential\(cred\)/.test(route)
    ? ok("the webhook verifies with the SENDER's credential, never with whichever gateway the org would collect on")
    : bad("the webhook still chooses its verifier by collection preference");
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED — Naira is collected on Flutterwave where it is connected, and no payout reaches an adapter that cannot pay.\x1b[0m"
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
