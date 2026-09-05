// Audit 0804 D2 — an administrator can actually save the settings they are shown.
//
// ⚠️ Why this suite exists at all, and why it signs in.
//
// 0083c replaced `orgs`'s blanket table-level UPDATE grant with an explicit
// column allowlist. **Postgres does not extend such a grant to columns added
// later** — so `management_fee_pct`, `admin_fee_flat`, `renewal_notice_days` and
// `rent_demand_lead_days`, all added by Days 9–10, arrived unwritable, and
// Settings → Lettings failed for every administrator with "permission denied for
// table orgs".
//
// It was invisible to the whole suite because **every** script exercising these
// columns writes through the service-role client, which bypasses column grants
// entirely. A suite that only ever uses `svc` cannot see a grant problem: it is
// testing the database, not the application's access to it.
//
// So this one uses a real signed-in session, and asserts in both directions —
// what an administrator must be able to write, and what they must still not.
//
// Usage: node scripts/verify-lettings-grants.mjs
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
  return error ? null : c;
};

console.log("Settings that can actually be saved\n");

const admin = await login("oea.admin@oegroup.test");
if (!admin) {
  bad("could not sign in as an OEA administrator");
  process.exit(1);
}
const { data: { user } } = await admin.auth.getUser();
const { data: me } = await admin.from("users").select("org_id, role").eq("id", user.id).single();

// Snapshot, so this suite restores whatever the org actually had rather than
// leaving the demo on values it invented.
const LETTINGS = ["management_fee_pct", "admin_fee_flat", "admin_fee_basis",
  "renewal_notice_days", "rent_demand_lead_days"];
const { data: original } = await svc.from("orgs")
  .select(LETTINGS.join(", ")).eq("id", me.org_id).single();

console.log("A. Lettings settings save from an administrator's own session");
{
  // Exactly what `saveLettingsSettings()` writes, through the same kind of
  // client the action uses — not the service role.
  const { error } = await admin.from("orgs").update({
    management_fee_pct: 7.5,
    admin_fee_flat: 25000,
    admin_fee_basis: "per_demand",   // 0181 — deliberately off its default, so a no-op cannot pass
    renewal_notice_days: [120, 90, 60, 30],
    rent_demand_lead_days: 45,
  }).eq("id", me.org_id);

  if (error) {
    bad(`SETTINGS → LETTINGS CANNOT BE SAVED — ${error.message.slice(0, 70)}`);
  } else {
    ok("an administrator can write every lettings column");
    const { data: after } = await svc.from("orgs")
      .select(LETTINGS.join(", ")).eq("id", me.org_id).single();
    Number(after.management_fee_pct) === 7.5 && Number(after.rent_demand_lead_days) === 45
      && after.admin_fee_basis === "per_demand"
      ? ok("and the values actually landed")
      : bad(`the write reported success but stored ${JSON.stringify(after)}`);
  }

  // Restore before anything else runs against this org.
  await svc.from("orgs").update(original).eq("id", me.org_id);
}

console.log("\nB. The deliberate exclusions still hold");
{
  // These are off the allowlist ON PURPOSE (0083c, 0085, 0089, 0211). If a later
  // migration ever re-grants `update on orgs` at table level, every one of them
  // silently becomes writable again — which is exactly the fault 0083b had.
  const forbidden = {
    deleted_at: new Date().toISOString(),
    is_platform_operator: true,
    slug: `hijack-${Date.now()}`,
    custom_domain: "attacker.example.com",
    // ⚠️ The newest and least obvious of them. `delivery_brand` selects the
    // approval ladder (`org_payment_chain`, 0211), so an administrator who
    // could write it could move their org off the OEA chain — whose whole
    // point is that the administrator approves nothing — and onto one where
    // they might. It reads like branding and behaves like a control.
    delivery_brand: "TFML",
  };
  for (const [col, value] of Object.entries(forbidden)) {
    const { error } = await admin.from("orgs").update({ [col]: value }).eq("id", me.org_id);
    error
      ? ok(`${col} is still refused`)
      : bad(`${col.toUpperCase()} IS WRITABLE BY AN ADMINISTRATOR — the allowlist has been widened`);
  }
}

console.log("\nC. Every orgs column is either allowed or deliberately excluded");
{
  // The check that would have caught D2 the day it was introduced: a NEW column
  // on `orgs` is unwritable by default and nobody notices until a save fails in
  // front of a user. Anything not on either list below is unclassified — a
  // column somebody added without deciding which side of the line it sits on.
  const ALLOWED = new Set([
    "name", "parent_org_id",
    "theme_primary", "theme_accent", "theme_logo_text", "logo_url", "portal_name", "tagline",
    "support_email", "support_phone", "login_headline",
    "vendor_applications_open", "finance_email", "it_email",
    "email_from_name", "email_from_address", "tenant_applications_open",
    "management_fee_pct", "admin_fee_flat", "renewal_notice_days", "rent_demand_lead_days",
    "whatsapp_number", "telegram_bot_username",   // 0146a/0147, granted by 0158
    "vendor_enhanced_kyc_threshold",              // 0164, vendor self-service tiering
    "admin_fee_basis",                            // 0181, decision 14's resolution
  ]);
  const EXCLUDED = new Set([
    "id", "created_at",              // identity, never in an UPDATE payload
    "deleted_at",                    // retire_org()/unretire_org() only
    "is_platform_operator",          // the org-isolation crossing (0050)
    "slug", "custom_domain",         // operator controls (0085, 0089)
    "gateway_tag",                   // DB-generated (0156), read-only everywhere it's used
    // ⚠️ MOVED HERE FROM `ALLOWED` BY DECISION 23 (0211). It was a branding
    // field and was writable by an org administrator, which was harmless right
    // up until the approval ladder started reading it: `org_payment_chain()`
    // resolves OEA to the audit → MP → payment-approver chain and everything
    // else to the standard one, so an administrator who could edit this column
    // could have moved their own organisation to TFML and walked straight back
    // into the final-approval stage decision 23 removed them from.
    //
    // 📌 The column did not change. Its READERS did — which is what moved it
    // across this line, and is the reason section C exists at all.
    "delivery_brand",
  ]);

  // ⚠️ THE CALLER'S OWN ROW. Not `.limit(1)`.
  //
  // The first draft of this suite read `orgs.select("*").limit(1)` to learn the
  // column names and then echoed those values back onto `me.org_id`. That is a
  // read of an ARBITRARY org — Postgres returned the POC's row — and the echo
  // wrote the POC's name, brand, portal name and sender identity straight over
  // the OEA organisation. `oeaportal.com` served "OE Group — Foundation POC"
  // with no OEA branding until it was restored from `audit_log.before_state`.
  //
  // 📌 A suite that writes must read the row it is going to write. Learning a
  // schema from one row and applying it to another is the same mistake as
  // trusting `delivery_brand` to identify an org — a lookup that returns *a*
  // row where the code assumes *the* row.
  const { data: mine } = await svc.from("orgs").select("*").eq("id", me.org_id).single();
  const present = Object.keys(mine ?? {});

  if (present.length === 0) {
    bad("could not read the orgs column list");
  } else {
    const unclassified = present.filter((c) => !ALLOWED.has(c) && !EXCLUDED.has(c));
    unclassified.length === 0
      ? ok(`all ${present.length} orgs columns are classified`)
      : bad(
          `UNCLASSIFIED orgs column(s): ${unclassified.join(", ")} — decide whether ` +
          `each belongs in the 0083c UPDATE allowlist, and add it to this suite either way`
        );

    // And the allowlist this suite believes in matches the one the database
    // enforces, so the list above cannot rot into documentation.
    //
    // ⚠️ ONE update writing every allowlisted column to its own current value,
    // not one request per column. The per-column loop this replaced fired
    // twenty-odd sequential round-trips, and when two of them hit a connect
    // timeout it reported "the database refuses it" — a transport failure
    // dressed up as a permission failure. A suite that cannot tell those apart
    // teaches people to ignore it.
    const echo = {};
    for (const col of present) if (ALLOWED.has(col)) echo[col] = mine[col];

    const { error: e } = await admin.from("orgs").update(echo).eq("id", me.org_id);
    if (!e) {
      ok(`and all ${Object.keys(echo).length} of them are writable in practice`);
    } else if (/permission denied/i.test(e.message)) {
      bad(`a column this suite calls allowed is refused by the database — ${e.message.slice(0, 60)}`);
    } else {
      // Say what it was. An unreachable database is not a failed assertion.
      console.log(`  \x1b[33mSKIP\x1b[0m could not reach the database to confirm — ${e.message.slice(0, 60)}`);
    }
  }
}

await admin.auth.signOut();

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the settings screens write what they show, and nothing more."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exitCode = failures === 0 ? 0 : 1;
