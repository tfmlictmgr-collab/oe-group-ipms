// Gives the demo orgs a dispatch history, so Day 10's console has something to
// measure.
//
// ⚠️ THIS WRITES RESOLUTION TIMESTAMPS DIRECTLY, which migration 0099 refuses to
// do — and the distinction matters. 0099 declines to backfill *real* history
// because the moment was never recorded and any value would be a guess presented
// as fact. This script populates a *synthetic* dataset that has no real history
// to misrepresent: CLAUDE.md B5 defines the POC as "synthetic/sample demo data
// (no live client data)".
//
// The guard is therefore about WHERE it runs, not whether writing timings is
// ever acceptable:
//   • it refuses unless --yes is passed,
//   • it refuses any org not in DEMO_SLUGS,
//   • it refuses outright if the database looks like production.
//
// Without it, "which vendor completes fastest this quarter?" cannot be answered
// on the demo at all: no ticket in any org carries an `assigned_vendor_id`, so
// every vendor panel is correctly, uselessly empty.
//
// Usage: node scripts/seed-dispatch-demo.mjs --yes
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

// Orgs whose contents are known to be fabricated for the demo.
const DEMO_SLUGS = ["oe-group-foundation-poc", "sc-client", "tfml", "oea"];

if (!process.argv.includes("--yes")) {
  console.error(
    "Refusing to run.\n\n" +
      "This writes synthetic resolution and response times onto demo tickets so the\n" +
      "analytics console has durations to report. It must never be pointed at an\n" +
      "environment holding real request history.\n\n" +
      `Demo orgs it will touch: ${DEMO_SLUGS.join(", ")}\n\n` +
      "Re-run with --yes if that is what you want."
  );
  process.exit(1);
}

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Distinct characteristic speeds, so "fastest" and "slowest" are a real finding
// rather than sampling noise. Hours-to-resolve is drawn around each mean.
const PROFILES = [
  { mean: 6, spread: 3 },
  { mean: 14, spread: 6 },
  { mean: 28, spread: 10 },
  { mean: 52, spread: 18 },
  { mean: 96, spread: 30 },
  { mean: 150, spread: 40 },
];

// Deterministic pseudo-randomness: re-running produces the same shape rather
// than drifting the demo's numbers every time someone runs the seed.
let seed = 20260803;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const HOUR = 3600 * 1000;
const now = Date.now();

const { data: orgs, error: orgErr } = await svc
  .from("orgs").select("id, slug, name").is("deleted_at", null);
if (orgErr) { console.error(orgErr.message); process.exit(1); }

const unknown = (orgs ?? []).filter((o) => !DEMO_SLUGS.includes(o.slug) && !o.slug.includes("oe-group"));
if (unknown.length) {
  console.log(`Skipping ${unknown.length} org(s) not on the demo list: ${unknown.map((o) => o.slug).join(", ")}`);
}

let dispatched = 0;
let resolved = 0;

for (const org of (orgs ?? []).filter((o) => DEMO_SLUGS.includes(o.slug))) {
  const { data: vendors } = await svc
    .from("vendors").select("id, name").eq("org_id", org.id).order("name");
  if (!vendors?.length) {
    console.log(`${org.slug}: no contractors — nothing to dispatch to.`);
    continue;
  }

  const { data: tickets } = await svc
    .from("tickets")
    .select("id, created_at, status, assigned_vendor_id, resolved_at")
    .eq("org_id", org.id)
    .is("assigned_vendor_id", null)
    // ⚠️ MAINTENANCE only. This used to dispatch every undispatched ticket
    // regardless of category, round-robin — so a `general` tenancy-renewal
    // enquiry and a `billing` query landed on a landscaping contractor's My
    // Work, which is exactly what was reported from the demo. The RLS was never
    // wrong (a vendor sees a ticket only when `assigned_vendor_id` is their
    // company); the FIXTURE was dispatching work no contractor performs.
    //
    // A person may still assign anything deliberately — an FM sending a
    // complaint about a broken gate to the gate contractor is legitimate. What
    // a seed must not do is manufacture that judgement at random.
    .eq("category", "maintenance")
    .order("created_at");

  if (!tickets?.length) {
    // "Nothing to do" has two causes and they are not the same news.
    const { count } = await svc
      .from("tickets").select("id", { count: "exact", head: true }).eq("org_id", org.id);
    console.log(
      count
        ? `${org.slug}: all ${count} ticket(s) already dispatched.`
        : `${org.slug}: no requests at all — nothing to dispatch.`
    );
    continue;
  }

  for (const [i, t] of tickets.entries()) {
    // A share stays undispatched. A queue with nothing waiting in it is not a
    // queue, and the console should show a real backlog.
    if (rnd() < 0.25) continue;

    const vendor = vendors[i % vendors.length];
    const profile = PROFILES[i % vendors.length % PROFILES.length];
    const created = new Date(t.created_at).getTime();

    // Acknowledged within a fraction of the eventual resolution time.
    const respondHours = Math.max(0.25, profile.mean * 0.2 * (0.5 + rnd()));
    const resolveHours = Math.max(
      respondHours + 0.5,
      profile.mean + (rnd() - 0.5) * 2 * profile.spread
    );

    const firstResponse = created + respondHours * HOUR;
    const resolvedAt = created + resolveHours * HOUR;

    // ⚠️ Never stamp a completion in the future. A ticket raised yesterday
    // cannot have been resolved in 96 hours, and a negative "age" would poison
    // every average it lands in.
    const canResolve = resolvedAt < now && t.status !== "open";
    const willResolve = canResolve || (resolvedAt < now && rnd() < 0.7);

    const patch = { assigned_vendor_id: vendor.id };
    if (firstResponse < now) patch.first_response_at = new Date(firstResponse).toISOString();

    if (willResolve) {
      patch.status = "resolved";
      patch.resolved_at = new Date(resolvedAt).toISOString();
    } else if (t.status === "open" && firstResponse < now) {
      patch.status = "in_progress";
    }

    const { error } = await svc.from("tickets").update(patch).eq("id", t.id);
    if (error) {
      console.error(`  ${t.id.slice(0, 8)}: ${error.message.slice(0, 70)}`);
      continue;
    }
    dispatched++;
    if (willResolve) resolved++;
  }

  console.log(`${org.slug}: dispatched across ${vendors.length} contractor(s).`);
}

console.log(
  `\nDispatched ${dispatched} ticket(s); ${resolved} of them carry a synthetic completion time.`
);
console.log(
  "These timings are fabricated for demonstration. Nothing here backfills real history —\n" +
    "tickets that were already complete before timestamping began are left untouched."
);
