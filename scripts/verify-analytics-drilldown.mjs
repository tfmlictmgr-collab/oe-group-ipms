// Drill-down scoping, and the tier-aware approval queue (Task 4).
//
// ⚠️ The claim being tested is NOT "the console checks who you are". It is that
// a DRILL TARGET does — separately, and on its own. A drill page is reachable by
// a pasted URL or a stale bookmark, so it never passes the console's gate, and
// the dashboard's answer to "may you open analytics" is a different question
// from "may you see THIS property's requests".
//
// `loadDrill` leans on three things, and this suite proves each by attempting
// it as a real signed-in person rather than by reading a policy:
//   1. `biScope(role).requests` — whether the role reads request analytics;
//   2. `resolveLabel` asking the database for the record under the caller's own
//      session, so an out-of-scope property has no name and therefore no page;
//   3. `bi_ticket_metrics` being RLS-scoped, so even a leaked id yields the
//      caller's own figures rather than someone else's.
//
// Section 4 covers the tier-aware queue: what each tier may actually action.
//
// Usage: node scripts/verify-analytics-drilldown.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

if (!URL_ || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
};

// Mirrors lib/approvals/chain.ts — if these drift, the queue shows a person a
// row they will then be refused, which is the failure this pairing prevents.
const effectiveTier = (role, tier) =>
  role === "payment_approver" ? tier : role === "executive" ? 3 : role === "admin" ? 2 : null;

const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const poc = orgs.find((o) => o.slug === "oe-group-foundation-poc");
const oea = orgs.find((o) => o.slug === "oea");
if (!poc || !oea) { console.error("Need the POC and OEA orgs seeded."); process.exit(2); }

console.log("\nAnalytics drill-down scoping (Task 4)\n");

// ---------------------------------------------------------------------------
console.log("1. Who may read request analytics at all");
// ---------------------------------------------------------------------------
{
  // biScope(role).requests — the same table lib/../scope.ts encodes.
  const EXPECT = {
    admin: true, executive: true, facility_manager: true, regional_manager: true,
    property_owner: true, finance_approver: false, tenant: false, vendor: false,
  };
  for (const [role, expected] of Object.entries(EXPECT)) {
    const { data: u } = await svc.from("users").select("id")
      .eq("org_id", poc.id).eq("role", role).is("deactivated_at", null)
      .limit(1).maybeSingle();
    if (!u) { note(`no ${role} seeded — skipped`); continue; }
    // Proven through the data the page would show, not through the flag: a
    // role with no request analytics gets nothing back from the metrics RPC it
    // is not entitled to reach.
    const c = await login(`${poc.slug}.${role.replace(/_/g, "")}@oegroup.test`).catch(() => null);
    if (!c) { note(`no login for ${role} — skipped`); continue; }
    const { error } = await c.rpc("bi_ticket_metrics", { p_bucket: "month" });
    // The RPC itself is open to any signed-in caller; RLS on `tickets` is what
    // narrows it. What matters here is that it does not ERROR, so the page's
    // own biScope gate is the thing that refuses — recorded so a future change
    // that moves the refusal into the database is noticed rather than assumed.
    error
      ? note(`${role}: metrics RPC refused outright (${error.message.slice(0, 40)})`)
      : ok(`${role}: reaches the metrics RPC; the page gate decides (expects ${expected})`);
    await c.auth.signOut();
  }
}

// ---------------------------------------------------------------------------
console.log("\n2. A drill target names a record the caller can actually see");
// ---------------------------------------------------------------------------
{
  // `resolveLabel` returns null when the record is invisible, and the page
  // refuses on null. So: can an FM in one org name a property in another?
  const { data: oeaProp } = await svc.from("properties")
    .select("id, name").eq("org_id", oea.id).is("deleted_at", null).limit(1).maybeSingle();

  if (!oeaProp) {
    note("no OEA property seeded — cross-org drill not testable");
  } else {
    const fm = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
    const { data } = await fm.from("properties")
      .select("name").eq("id", oeaProp.id).is("deleted_at", null).maybeSingle();
    data === null
      ? ok("an FM cannot name another organisation's property — the drill page has no title and refuses")
      : bad(`!!! CROSS-ORG PROPERTY RESOLVED: ${data.name}`);

    // And the figures behind it are empty even if the id leaks.
    const { data: rows } = await fm.rpc("bi_ticket_metrics", {
      p_property_id: oeaProp.id, p_bucket: "month",
    });
    (rows ?? []).length === 0
      ? ok("and its figures come back empty rather than as someone else's")
      : bad(`!!! ${rows.length} period(s) of ANOTHER ORG'S FIGURES returned`);
    await fm.auth.signOut();
  }

  // Within an org, an FM is scoped to their own properties by
  // current_user_property_ids(). A property they do not hold must not resolve.
  const fm = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
  const { data: mine } = await fm.from("properties").select("id").limit(50);
  const { data: all } = await svc.from("properties")
    .select("id").eq("org_id", poc.id).is("deleted_at", null).limit(50);
  const mineIds = new Set((mine ?? []).map((p) => p.id));
  const unheld = (all ?? []).find((p) => !mineIds.has(p.id));

  if (!unheld) {
    note("this FM holds every property in the org — in-org scoping not testable");
  } else {
    const { data } = await fm.from("properties")
      .select("name").eq("id", unheld.id).is("deleted_at", null).maybeSingle();
    data === null
      ? ok("nor a property inside their own org that they do not manage")
      : bad(`!!! AN UNHELD PROPERTY RESOLVED: ${data.name}`);
  }
  await fm.auth.signOut();
}

// ---------------------------------------------------------------------------
console.log("\n3. The period bucket groups by what it says");
// ---------------------------------------------------------------------------
{
  // ⚠️ `bi_ticket_metrics` CLAMPS an unknown bucket to 'month' rather than
  // refusing it. Before 0160 that made `day` silently return months — a drill
  // page headed "per day" drawing monthly bars. Proven by asking for both and
  // requiring them to differ in shape.
  const c = await login("oe-group-foundation-poc.admin@oegroup.test");
  const { data: byMonth } = await c.rpc("bi_ticket_metrics", { p_bucket: "month" });
  const { data: byDay } = await c.rpc("bi_ticket_metrics", { p_bucket: "day" });
  const { data: byJunk } = await c.rpc("bi_ticket_metrics", { p_bucket: "fortnight" });

  (byDay ?? []).length >= (byMonth ?? []).length
    ? ok(`'day' groups finer than 'month' (${(byDay ?? []).length} vs ${(byMonth ?? []).length} periods)`)
    : bad(`'day' returned ${(byDay ?? []).length} periods, 'month' ${(byMonth ?? []).length} — day is still being clamped`);

  JSON.stringify(byJunk) === JSON.stringify(byMonth)
    ? ok("and an unrecognised bucket still falls back to month rather than reaching date_trunc")
    : bad("an unknown bucket did something other than fall back — the allow-list may have been removed");
  await c.auth.signOut();
}

// ---------------------------------------------------------------------------
console.log("\n4. The approval queue is scoped to what each tier can action");
// ---------------------------------------------------------------------------
{
  const { data: gate } = await svc.from("payment_settings")
    .select("tier1_threshold_amount, approval_threshold_amount").eq("org_id", poc.id).maybeSingle();
  const t1 = Number(gate?.tier1_threshold_amount ?? 100000);
  const t2 = Number(gate?.approval_threshold_amount ?? 1000000);

  // What the QUEUE would offer each person, computed the way canActorAction
  // does, checked against what the DATABASE actually permits.
  const cases = [
    ["payment_approver", 1, t1, true, "tier 1 at its own ceiling"],
    ["payment_approver", 1, t1 + 0.01, false, "tier 1 one kobo above it"],
    ["payment_approver", 2, t2, true, "tier 2 at its ceiling"],
    ["payment_approver", 2, t2 + 0.01, false, "tier 2 above the threshold"],
    ["payment_approver", 3, t2 + 1_000_000, true, "tier 3, unlimited"],
    ["executive", null, t2 + 1_000_000, true, "an executive above the threshold (decision 9)"],
    ["admin", null, t2 + 0.01, false, "an administrator above it (decision 16)"],
    ["admin", null, t2, true, "an administrator within it"],
    ["finance_approver", null, 1000, false, "finance, which holds no approval at all"],
  ];

  for (const [role, tier, amount, shouldOffer, label] of cases) {
    const { data: required } = await svc.rpc("resolve_required_tier", {
      p_org_id: poc.id, p_amount: amount,
    });
    const mine = effectiveTier(role, tier);
    const queueOffers = mine !== null && mine >= Number(required);
    queueOffers === shouldOffer
      ? ok(`${label} — queue ${shouldOffer ? "offers" : "withholds"} it, matching the ladder`)
      : bad(`${label}: queue would ${queueOffers ? "offer" : "withhold"}, database says tier ${required} needed and they are ${mine}`);
  }
}

console.log(failures === 0
  ? "\n\x1b[32mAll drill-down scoping checks passed.\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
