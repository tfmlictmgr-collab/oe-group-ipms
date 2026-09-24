// Verifies that an organisation's money, messages and links carry that
// organisation's identity and nobody else's (0288, 11 Sept 2026).
//
//   npx tsx scripts/verify-gateway-isolation.mjs
//
// Written after an OEA tenant paid OEA rent and received a Paystack receipt
// reading "Total Facilities Management Limited received your payment" — which
// was accurate: `org_gateway_credentials` held 0 rows, every org's checkout
// fell back to the platform key, and the platform key is TFML's merchant
// account. The same shape was then found in three more places: the cascade's
// email step (one global From), WhatsApp/Telegram (one shared token), and
// every emailed link (one deployment address).
//
// The DATABASE checks run as real users inside a transaction that is always
// rolled back — nothing survives. The APPLICATION checks import the real
// resolvers (lib/gateway, lib/notify, lib/portal-origin) and call them; the
// Paystack amount check replaces `fetch` for one call so no network is used
// and no money moves.
import { config } from "dotenv";
import { requireNonProductionTarget } from "./lib/target-env.mjs";
import pg from "pg";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

config({ path: ".env.local", quiet: true });
requireNonProductionTarget(process.cwd(), "Runs DB checks as real users in a rolled-back transaction against the real org register.");
if (!process.env.SUPABASE_DB_HOST) {
  console.error("Missing SUPABASE_DB_* in .env.local");
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
const skip = (m) => console.log(`  \x1b[33mSKIP\x1b[0m ${m}`);
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** Everything inside runs in ONE transaction that is always rolled back. */
async function rolledBack(fn) {
  await client.query("begin");
  try {
    return await fn();
  } finally {
    await client.query("rollback");
  }
}
async function as(uid) {
  await client.query("set local role authenticated");
  await client.query(`set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated" })}'`);
}
async function asOwner() {
  await client.query("reset role");
}
async function refusal(sql, params) {
  await client.query("savepoint s");
  try {
    await client.query(sql, params);
    await client.query("release savepoint s");
    return null;
  } catch (e) {
    await client.query("rollback to savepoint s");
    return e.message;
  }
}

await client.connect();
const one = async (sql, p) => (await client.query(sql, p)).rows[0];
const org = async (slug) => one("select id, name, custom_domain, uses_platform_gateway from orgs where slug = $1 and deleted_at is null", [slug]);
const tfml = await org("tfml");
const oea = await org("oea");
const oeaTenant = await one("select id, org_id from users where email = 'oea.tenant@oegroup.test'");
const oeaAdmin = await one("select id from users where email = 'oea.admin@oegroup.test'");
const otherTenant = await one(
  "select id from users where role = 'tenant' and org_id = $1 and deactivated_at is null and id <> $2 and email not like 'probe%' order by created_at limit 1",
  [oea.id, oeaTenant.id]
);

// ════════════════════════════════════════════════════════════════════════════
section("A. Exactly one organisation owns the platform merchant account");

{
  const owners = (await client.query("select slug from orgs where uses_platform_gateway and deleted_at is null")).rows;
  owners.length === 1 && owners[0].slug === "tfml"
    ? ok("the platform key belongs to TFML, and to nobody else")
    : bad(`platform-account owners: ${JSON.stringify(owners)}`);

  const n = await rolledBack(async () => {
    await as(oeaAdmin.id);
    const r = await refusal("update orgs set uses_platform_gateway = true where id = $1", [oea.id]);
    return r;
  });
  n
    ? ok("an organisation's administrator cannot claim the platform account for their own org")
    : bad("an org administrator set uses_platform_gateway");

  const dup = await rolledBack(async () =>
    refusal("update orgs set uses_platform_gateway = true where id = $1", [oea.id])
  );
  dup && /orgs_one_platform_gateway_owner/.test(dup)
    ? ok("…and even the database owner cannot give it to a second org")
    : bad(`a second platform-account owner was accepted: ${dup}`);
}

// ════════════════════════════════════════════════════════════════════════════
section("B. A checkout runs on the paying organisation's own account, or not at all");

const gw = await import("../lib/gateway/index.ts");
{
  const hasKey = gw.gatewayConfigured("NGN");
  if (!hasKey) {
    skip("no platform Paystack key in this environment — the refusal path cannot be exercised");
  } else {
    const t = await gw.resolveOrgGateway(tfml.id, "NGN", "collect");
    t.merchant === "platform" && t.adapter.name === "paystack"
      ? ok("TFML, which owns the platform key, checks out on it")
      : bad(`TFML resolved to ${t.merchant}/${t.adapter.name}`);

    const credOea = await one("select count(*)::int n from org_gateway_credentials where org_id = $1 and active", [oea.id]);
    if (credOea.n > 0) {
      const o = await gw.resolveOrgGateway(oea.id, "NGN", "collect");
      o.merchant === "org" ? ok("OEA checks out on its OWN connected account") : bad("OEA did not use its own account");
    } else {
      let refused = null;
      try {
        await gw.resolveOrgGateway(oea.id, "NGN", "collect");
      } catch (e) {
        refused = e;
      }
      refused?.name === "GatewayNotConnectedError"
        ? ok("OEA, with no account of its own, is REFUSED — never routed through TFML's")
        : bad(`OEA was given a gateway: ${refused?.message ?? "no refusal"}`);
      /bank transfer/i.test(refused?.message ?? "")
        ? ok("…and the refusal says what the payer can do instead")
        : bad("the refusal does not point at the bank-transfer route");
      /TFML|Total Facilities/i.test(refused?.message ?? "")
        ? bad("the refusal names another organisation")
        : ok("…without naming any other organisation");
    }

    // Payouts go through the same resolver — an OEA landlord must never be
    // paid out of TFML's balance.
    let payoutRefused = false;
    if (credOea.n === 0) {
      try { await gw.getGatewayForOrg(oea.id, "NGN", "payout"); } catch { payoutRefused = true; }
      payoutRefused
        ? ok("payouts for OEA are refused too — no remittance leaves another org's balance")
        : bad("getGatewayForOrg still hands OEA the platform key");
    }
  }
}

// A payout in a currency NOTHING pays out in must be refused in every world,
// not simulated in the keyless ones. `gatewayPreference` returns an empty list
// for a foreign-currency payout; production therefore refuses one before the
// remittance is claimed. A keyless dev or staging used to fall through to the
// simulated adapter instead — whose `transfer` reports success and posts to the
// ledger — so Stage 4.4 would have watched an FX payout "succeed" on staging
// and proved a path that refuses in production. Runs in every world, because
// the worlds that CAN get this wrong are the keyless ones.
{
  for (const [label, o] of [["TFML", tfml], ["OEA", oea]]) {
    let outcome = "a gateway";
    try {
      const r = await gw.resolveOrgGateway(o.id, "USD", "payout");
      outcome = r.merchant === "simulated" ? "the SIMULATED adapter" : `the ${r.merchant} account`;
    } catch (e) {
      outcome = e.name === "GatewayNotConnectedError" ? "refused" : `error: ${e.message}`;
    }
    outcome === "refused"
      ? ok(`${label}: a foreign-currency payout is refused, as it is in production`)
      : bad(`${label}: a foreign-currency payout resolved to ${outcome} — a simulated transfer posts to the ledger`);
  }
  // The Naira payout must still resolve, or dev could not rehearse a payout at all.
  let ngnOk = false;
  try { await gw.resolveOrgGateway(tfml.id, "NGN", "payout"); ngnOk = true; } catch { ngnOk = false; }
  ngnOk || !gw.gatewayConfigured("NGN")
    ? ok("…while a Naira payout still resolves, so the refusal is about the currency, not a blanket no")
    : bad("a Naira payout is now refused too — the guard is too wide");
}

// ════════════════════════════════════════════════════════════════════════════
section("C. Verification uses the account that TOOK the payment");

{
  if (!gw.gatewayConfigured("NGN")) {
    skip("no platform key — verification routing needs one");
  } else {
    // An intent minted on the platform key before 0288 (merchant NULL) is still
    // verified there, so a tenant who already paid is recognised.
    const legacy = await gw.adapterForIntent({ org_id: oea.id, gateway: "paystack", currency: "NGN", merchant_account: null });
    legacy.name === "paystack"
      ? ok("an OEA payment taken on the platform key before 0288 is still verified on it")
      : bad("a pre-0288 payment has no way to be verified");

    let refused = false;
    try {
      await gw.adapterForIntent({ org_id: oea.id, gateway: "paystack", currency: "NGN", merchant_account: "org" });
    } catch { refused = true; }
    const credOea = await one("select count(*)::int n from org_gateway_credentials where org_id = $1 and active", [oea.id]);
    credOea.n === 0
      ? (refused
          ? ok("a payment marked as taken on OEA's own account is never checked against the platform key")
          : bad("an org-account payment fell back to the platform key for verification"))
      : ok("(OEA has its own account — org verification exercised by use)");
  }

  // Paystack's `amount` includes the fee when the merchant passes it to the
  // payer; the demand is credited with what WE asked for.
  if (gw.gatewayConfigured("NGN")) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        status: true,
        data: { amount: 10000200000, requested_amount: 10000000000, currency: "NGN", status: "success", paid_at: "2026-09-11T12:39:00Z" },
      }), { status: 200 });
    try {
      const v = await gw.getAdapterByName("paystack").verifyTransaction("RENT-VERIFY-FEE");
      v.amount === 100000000
        ? ok("a ₦100,000,000 demand paid with Paystack's ₦2,000 fee on top is credited ₦100,000,000, not ₦100,002,000")
        : bad(`the fee was credited to the tenant: ${v.amount}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("D. The checkout address has one write path, and it cannot be pointed anywhere");

await rolledBack(async () => {
  const ref = `ISO-VERIFY-${Date.now()}`;
  const { id: intentId } = await one(
    `insert into payment_intents (org_id, purpose, amount_expected, currency, gateway, gateway_reference, payer_user_id, created_by)
     values ($1, 'other', 1000, 'NGN', 'paystack', $2, $3, $3) returning id`,
    [oea.id, ref, oeaTenant.id]
  );

  // Before 0288 the app wrote this through the tenant's session and RLS
  // declined it silently — the root of the "Continue payment" 404.
  await as(oeaTenant.id);
  const direct = await client.query("update payment_intents set checkout_url = 'https://checkout.paystack.com/x' where id = $1", [intentId]);
  direct.rowCount === 0
    ? ok("a tenant still cannot write the row directly (the silent no-op that caused the 404)")
    : bad("a tenant updated payment_intents directly");

  const phish = await refusal("select set_payment_intent_checkout($1, 'https://paystack-checkout.example.com/pay', 'platform')", [intentId]);
  phish ? ok("an address that is not the gateway's own checkout is refused") : bad("a non-gateway checkout address was stored");

  const good = await refusal("select set_payment_intent_checkout($1, 'https://checkout.paystack.com/abc123', 'platform')", [intentId]);
  good === null ? ok("the payer records the gateway's checkout address through the function") : bad(`the payer's own write was refused: ${good}`);

  const moved = await refusal("select set_payment_intent_checkout($1, 'https://checkout.paystack.com/abc123', 'org')", [intentId]);
  moved ? ok("the merchant account cannot be changed once recorded") : bad("the merchant account was re-pointed after the fact");

  const retire = await refusal("select retire_unopened_payment_intent($1)", [intentId]);
  retire ? ok("a payment WITH an address to continue to cannot be retired") : bad("an openable payment was retired");

  if (otherTenant) {
    await as(otherTenant.id);
    const stranger = await refusal("select set_payment_intent_checkout($1, 'https://checkout.paystack.com/zzz', 'platform')", [intentId]);
    stranger ? ok("another tenant cannot touch it") : bad("another tenant wrote someone else's checkout");
  } else {
    skip("no second OEA tenant to try as");
  }

  await asOwner();
  const row = await one("select checkout_url, merchant_account from payment_intents where id = $1", [intentId]);
  row.checkout_url === "https://checkout.paystack.com/abc123" && row.merchant_account === "platform"
    ? ok("what was recorded is exactly the payer's own write")
    : bad(`recorded: ${JSON.stringify(row)}`);
});

await rolledBack(async () => {
  const { id: intentId } = await one(
    `insert into payment_intents (org_id, purpose, amount_expected, currency, gateway, gateway_reference, payer_user_id, created_by)
     values ($1, 'other', 1000, 'NGN', 'paystack', $2, $3, $3) returning id`,
    [oea.id, `ISO-VERIFY-B-${Date.now()}`, oeaTenant.id]
  );
  await as(oeaTenant.id);
  const r = await refusal("select retire_unopened_payment_intent($1)", [intentId]);
  await asOwner();
  const { status } = await one("select status from payment_intents where id = $1", [intentId]);
  r === null && status === "abandoned"
    ? ok("a pending payment with no address to return to can be retired by its payer, so a fresh one can open")
    : bad(`retire: ${r} / status ${status}`);
});

// ════════════════════════════════════════════════════════════════════════════
section("E. Messages leave as the organisation, or not at all");

const notify = await import("../lib/notify.ts");
{
  // An org whose WhatsApp route has no key of its own gets no sender — never
  // the shared WHATSAPP_ACCESS_TOKEN, which on 360dialog decides the brand.
  const keyless = await one(
    `select r.org_id from channel_routes r join orgs o on o.id = r.org_id
      where r.channel = 'whatsapp' and r.outbound_token is null and o.deleted_at is null limit 1`
  );
  if (keyless) {
    const s = await notify.whatsappSenderForOrg(keyless.org_id);
    s === null
      ? ok("a WhatsApp route with no key of its own is skipped, not sent with the shared token")
      : bad("a keyless WhatsApp route borrowed the shared token");
  } else {
    skip("every WhatsApp route carries its own key");
  }

  const botless = await one(
    `select o.id from orgs o where o.deleted_at is null
        and not exists (select 1 from channel_routes r where r.org_id = o.id and r.channel = 'telegram' and r.outbound_token is not null)
      order by o.created_at limit 1`
  );
  const t = await notify.telegramSenderForOrg(botless.id);
  t === null
    ? ok("an org with no Telegram bot of its own sends nothing — not the shared bot")
    : bad("an org with no bot was given the shared TELEGRAM_BOT_TOKEN");

  const tf = await notify.whatsappSenderForOrg(tfml.id);
  const oe = await notify.whatsappSenderForOrg(oea.id);
  tf && oe && tf.accessToken !== oe.accessToken && tf.phoneNumberId !== oe.phoneNumberId
    ? ok("TFML and OEA send WhatsApp from different numbers with different keys")
    : bad("TFML and OEA WhatsApp senders are not distinct");
}

{
  // ONE email sender in the codebase. The cascade posted to Resend itself,
  // From a global "OE Group" address, bypassing the per-org identity.
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f.startsWith(".") ? [] : walk(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  const senders = [...walk("lib"), ...walk("app")]
    .filter((p) => readFileSync(p, "utf8").includes("api.resend.com/emails"))
    .map((p) => p.replace(/\\/g, "/"));
  senders.length === 1 && senders[0] === "lib/email.ts"
    ? ok("lib/email.ts is the only place mail is sent — every message carries its org's sender")
    : bad(`mail is posted to the provider from: ${senders.join(", ")}`);
  const cascade = readFileSync("lib/cascade.ts", "utf8");
  // The CODE, not the prose: the file's own comment quotes the old sender
  // while explaining why it went, and a check that fires on its own
  // explanation is a check about comments.
  const cascadeCode = cascade.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  /process\.env\.EMAIL_FROM|from:\s*["'`]/.test(cascadeCode)
    ? bad("the notification cascade still carries a global sender")
    : ok("the notification cascade's email step has no global sender left");
}

// ════════════════════════════════════════════════════════════════════════════
section("F. A link is to the organisation's own portal");

const { portalOrigin } = await import("../lib/portal-origin.ts");
{
  const o = await portalOrigin(oea.id);
  oea.custom_domain
    ? (o === `https://${oea.custom_domain}`
        ? ok(`an OEA letter links to OEA's own domain (${oea.custom_domain})`)
        : bad(`an OEA letter links to ${o}`))
    : skip("OEA has no bound domain in this environment");
  if (oea.custom_domain && /probe-portal|\.test$/.test(oea.custom_domain)) {
    bad(`OEA's live domain is a TEST value (${oea.custom_domain}) — a suite left it bound; see verify-custom-domains`);
  }
  const t = await portalOrigin(tfml.id);
  t !== o || !oea.custom_domain
    ? ok("a TFML letter and an OEA letter never share an address")
    : bad("TFML and OEA links resolve to the same host");
}

// ════════════════════════════════════════════════════════════════════════════
section("G. The screen's answer is the checkout's answer");

// `collectionRouteForOrg` labels a screen; `resolveOrgGateway` takes the money.
// They are two functions answering one question, so they can drift — and a
// banner that disagrees with the checkout below it is worse than no banner,
// because it is believed. Before this section existed the banner read
// `process.env` alone: an org collecting on its own Paystack TEST key was shown
// "Live keys — real money" as soon as the platform held a live Flutterwave key,
// and, the dangerous way round, an org on its own LIVE key under a platform
// test key was told no card would be charged.
//
// So: call both, for real, and require the same answer.
{
  const compare = async (label, orgId, currency) => {
    const route = await gw.collectionRouteForOrg(orgId, currency);

    let resolved = null;
    let refusal = null;
    try {
      resolved = await gw.resolveOrgGateway(orgId, currency, "collect");
    } catch (e) {
      refusal = e;
    }

    // The banner declines to guess; nothing to hold it to.
    if (route.state === "unknown") {
      skip(`${label} ${currency}: the route could not be read, and the banner says so`);
      return;
    }

    if (refusal) {
      if (refusal.name !== "GatewayNotConnectedError") {
        bad(`${label} ${currency}: the checkout failed in a way neither function models — ${refusal.message}`);
        return;
      }
      route.state === "not_connected"
        ? ok(`${label} ${currency}: checkout is refused, and the screen says so`)
        : bad(`${label} ${currency}: checkout is REFUSED but the screen says "${route.state}"`);
      return;
    }

    if (route.state === "not_connected") {
      bad(`${label} ${currency}: the screen says no account is connected, but checkout resolved to ${resolved.merchant}`);
      return;
    }

    if (resolved.merchant === "simulated") {
      route.state === "simulated"
        ? ok(`${label} ${currency}: checkout is simulated, and the screen says so`)
        : bad(`${label} ${currency}: checkout is SIMULATED but the screen says "${route.state}"`);
      return;
    }

    if (route.state !== "connected") {
      bad(`${label} ${currency}: checkout resolved to ${resolved.merchant}/${resolved.adapter.name} but the screen says "${route.state}"`);
      return;
    }
    route.gateway === resolved.adapter.name
      ? ok(`${label} ${currency}: both name ${route.gateway}`)
      : bad(`${label} ${currency}: the screen names ${route.gateway}, the checkout uses ${resolved.adapter.name}`);
    route.merchant === resolved.merchant
      ? ok(`${label} ${currency}: both say the ${route.merchant} account`)
      : bad(`${label} ${currency}: the screen says the ${route.merchant} account, the checkout uses the ${resolved.merchant} one`);
  };

  for (const [label, o] of [["TFML", tfml], ["OEA", oea]]) {
    await compare(label, o.id, "NGN");
    await compare(label, o.id, "USD");
  }

  // ── The disagreement itself, constructed ────────────────────────────────
  // Everything above compares whatever this world happens to be configured as.
  // On a world with no gateway key at all BOTH sides answer "simulated", which
  // is the one configuration in which they cannot disagree — so those passes
  // prove agreement without ever exercising the defect.
  //
  // The defect needs a PLATFORM key present. That half can be constructed from
  // the environment alone: no database write, no network call (neither function
  // contacts a gateway; one reads a column, the other builds an adapter).
  //
  // With a platform key set and an org that does not own it, the OLD banner
  // said "test mode" — over a checkout that 0288 refuses every single time.
  {
    const saved = {
      p: process.env.PAYSTACK_SECRET_KEY,
      f: process.env.FLUTTERWAVE_SECRET_KEY,
    };
    // Never sent anywhere. Shaped only so `keyIsTest` reads it as a test key.
    process.env.PAYSTACK_SECRET_KEY = "sk_test_verifyonlyneversent000000000000";
    delete process.env.FLUTTERWAVE_SECRET_KEY;
    try {
      // The old answer, still computed the old way, as the thing being improved on.
      const oldBanner = gw.gatewayMode("NGN");

      const oeaRoute = await gw.collectionRouteForOrg(oea.id, "NGN");
      let oeaRefused = false;
      try { await gw.resolveOrgGateway(oea.id, "NGN", "collect"); } catch (e) {
        oeaRefused = e.name === "GatewayNotConnectedError";
      }

      if (!oeaRefused) {
        skip("OEA has a gateway of its own here, so the refusal case cannot be constructed");
      } else if (oldBanner !== "test") {
        bad(`the constructed platform key did not take (gatewayMode said "${oldBanner}")`);
      } else {
        // This is the bug, reproduced.
        oeaRoute.state === "not_connected"
          ? ok('with a platform key set, OEA\'s checkout is refused and the screen says "no account connected" — where it used to say "test mode"')
          : bad(`OEA's checkout is refused but the screen says "${oeaRoute.state}"`);
      }

      // The other side of the same coin: the org that DOES own the platform key
      // is still told the truth, so the fix has not simply made everything read
      // "not connected".
      const tfmlOwn = await one(
        "select count(*)::int n from org_gateway_credentials where org_id = $1 and active",
        [tfml.id]
      );
      if (tfmlOwn.n > 0) {
        skip("TFML has a credential of its own here, so the platform-account case cannot be constructed");
      } else {
        const tfmlRoute = await gw.collectionRouteForOrg(tfml.id, "NGN");
        tfmlRoute.state === "connected" && tfmlRoute.merchant === "platform" && tfmlRoute.gateway === "paystack"
          ? ok("…while TFML, which owns the platform key, is correctly shown as collecting on it")
          : bad(`TFML resolved to "${tfmlRoute.state}"/"${tfmlRoute.merchant ?? "-"}" with a platform key present`);
        tfmlRoute.state === "connected" && tfmlRoute.mode === "test"
          ? ok("…in test mode, read from the platform key's own prefix")
          : bad("TFML's mode did not follow the platform key's prefix");
      }
    } finally {
      // Restore, whatever happened — later sections and any re-run read these.
      saved.p === undefined ? delete process.env.PAYSTACK_SECRET_KEY : (process.env.PAYSTACK_SECRET_KEY = saved.p);
      saved.f === undefined ? delete process.env.FLUTTERWAVE_SECRET_KEY : (process.env.FLUTTERWAVE_SECRET_KEY = saved.f);
    }
  }

  // The mode is the half that cannot be got from the adapter, because an
  // adapter does not expose its key — and it is the half that says whether a
  // real card is charged. Held to `key_mode`, recorded at save time, which is
  // the same column Settings → Banking shows.
  for (const [label, o] of [["TFML", tfml], ["OEA", oea]]) {
    const route = await gw.collectionRouteForOrg(o.id, "NGN");
    if (route.state !== "connected" || route.merchant !== "org") {
      skip(`${label}: not collecting Naira on its own key here, so there is no stored mode to check against`);
      continue;
    }
    const stored = await one(
      "select key_mode from org_gateway_credentials where org_id = $1 and gateway = $2 and active",
      [o.id, route.gateway]
    );
    stored && stored.key_mode === route.mode
      ? ok(`${label}: the banner's "${route.mode} mode" is the mode the stored key was saved as`)
      : bad(`${label}: the banner says ${route.mode}, the stored key is ${stored?.key_mode ?? "absent"}`);
  }
}

await client.end();
console.log(
  failures
    ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
    : "\n\x1b[32mALL CHECKS PASSED\x1b[0m — money, messages and links carry their own organisation's identity, or are refused."
);
process.exit(failures ? 1 : 0);
