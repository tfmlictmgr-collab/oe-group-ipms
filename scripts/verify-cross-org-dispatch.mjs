// A ticket cannot be assigned out of its own organisation (build audit
// 0806-M2, migration 0144) — and the external notification cascade cannot be
// aimed out of it either (the lib/role-notify.ts half of the same finding).
//
// ⚠️ This suite deliberately sends NOTHING. `verify-cascade.mjs` exercises real
// WhatsApp/SMS/Email delivery; this one is about the boundary in front of that,
// and a test for "we must not message strangers" that messages strangers to
// prove it would be its own bug. The cascade half is checked by reading which
// recipients the org filter actually returns, not by dispatching to them.
//
// Runs entirely on the service role, which BYPASSES RLS — that is the point.
// The gap being closed was never an RLS gap: `tickets_update` restricts which
// ticket rows a caller may touch and has no WITH CHECK on the values written,
// so the invariant has to hold at the trigger or not at all. Testing it through
// a session that RLS already constrains would prove nothing.
//
// Usage: node scripts/verify-cross-org-dispatch.mjs
import path from "node:path";
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

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const MARK = "PROBEXORG";
const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeTickets = [];

// Start-of-run sweep — a run that dies before its own cleanup must not leave
// debris the next run cannot see (the lesson from verify-work-order-media).
{
  const { data: strays } = await svc.from("tickets").select("id").like("message_text", `${MARK}%`);
  if (strays?.length) {
    await svc.from("tickets").delete().in("id", strays.map((s) => s.id));
    console.log(`(swept ${strays.length} stray ticket(s))`);
  }
}

// Two DIFFERENT live tenant orgs, each with a user — the whole suite is about
// what happens across that line, so without two there is nothing to test.
const { data: orgs } = await svc.from("orgs")
  .select("id, slug, is_platform_operator").is("deleted_at", null);
const tenantOrgs = (orgs ?? []).filter((o) => !o.is_platform_operator);

const withUsers = [];
for (const o of tenantOrgs) {
  const { data: u } = await svc.from("users")
    .select("id, org_id").eq("org_id", o.id).is("deactivated_at", null).limit(1);
  if (u?.length) withUsers.push({ org: o, user: u[0] });
  if (withUsers.length === 2) break;
}

if (withUsers.length < 2) {
  console.log("need two live tenant orgs each with a user — cannot run");
  process.exit(1);
}

const [home, foreign] = withUsers;

console.log(
  `Cross-org dispatch — ${home.org.slug} may not dispatch into ${foreign.org.slug}\n`
);

// A ticket belonging to the HOME org. `sender_id` is a real home-org user so
// the row is legitimate in every respect except what we try to do to it next.
const mkTicket = async () => {
  const { data, error } = await svc.from("tickets").insert({
    org_id: home.org.id,
    sender_id: home.user.id,
    message_text: `${MARK}-${S} cross-org dispatch probe`,
    channel: "portal",
    status: "open",
  }).select("id").single();
  if (error) throw new Error(`fixture ticket: ${error.message}`);
  madeTickets.push(data.id);
  return data.id;
};

console.log("A. The assignment itself");
{
  const t = await mkTicket();

  const { error: xorg } = await svc.from("tickets")
    .update({ assigned_to_user_id: foreign.user.id, status: "assigned" }).eq("id", t);
  xorg
    ? ok("a ticket cannot be assigned to a user in another organisation")
    : bad("!!! A TICKET WAS ASSIGNED ACROSS ORGS — the assignee can never see it, and nobody is told");

  // The other direction matters just as much: this must not become a blanket
  // freeze on assignment. A same-org dispatch is the ordinary case and has to
  // keep working, or the fix is worse than the bug.
  //
  // This also covers the reason 0144's function is SECURITY DEFINER. A plain
  // invoker-rights trigger would answer its `exists` through the CALLER's view
  // of `users`, and `tickets.assign` is an unlocked capability the operator can
  // grant to a role that cannot read its colleagues' rows — so the failure mode
  // is a false REFUSAL of a legitimate dispatch, which is exactly what this
  // assertion catches.
  const { error: sameOrg } = await svc.from("tickets")
    .update({ assigned_to_user_id: home.user.id, status: "assigned" }).eq("id", t);
  !sameOrg
    ? ok("and an ordinary same-organisation dispatch still succeeds")
    : bad(`a legitimate same-org dispatch was refused: ${sameOrg.message}`);

  // Unassigning must stay possible — the null guard in the trigger.
  const { error: clearing } = await svc.from("tickets")
    .update({ assigned_to_user_id: null }).eq("id", t);
  !clearing
    ? ok("and a ticket can still be unassigned")
    : bad(`unassigning was refused: ${clearing.message}`);
}

console.log("\nB. The same rule for vendors");
{
  const { data: foreignVendor } = await svc.from("vendors")
    .select("id").eq("org_id", foreign.org.id).limit(1).maybeSingle();
  const { data: homeVendor } = await svc.from("vendors")
    .select("id").eq("org_id", home.org.id).limit(1).maybeSingle();

  if (!foreignVendor) { note(`no vendor on ${foreign.org.slug} — cross-org vendor check not testable`); }
  else {
    const t = await mkTicket();
    const { error } = await svc.from("tickets")
      .update({ assigned_vendor_id: foreignVendor.id, status: "assigned" }).eq("id", t);
    error
      ? ok("a ticket cannot be dispatched to another organisation's vendor")
      : bad("!!! A TICKET WAS DISPATCHED TO A FOREIGN-ORG VENDOR");
  }

  if (!homeVendor) { note(`no vendor on ${home.org.slug} — same-org vendor dispatch not testable`); }
  else {
    const t = await mkTicket();
    const { error } = await svc.from("tickets")
      .update({ assigned_vendor_id: homeVendor.id, status: "assigned" }).eq("id", t);
    !error
      ? ok("and an ordinary same-org vendor dispatch still succeeds")
      : bad(`a legitimate same-org vendor dispatch was refused: ${error.message}`);
  }
}

console.log("\nC. The notification cascade's own org filter");
{
  // The lib/role-notify.ts half of 0806-M2. `cascadeToUserIds` now filters its
  // recipient lookup by org, so a foreign-org id resolves to no recipient and
  // no send is attempted. Verified by running the same query shape the function
  // runs — not by calling it, because calling it would dispatch real messages.
  const { data: unfiltered } = await svc.from("users")
    .select("id").in("id", [home.user.id, foreign.user.id]).is("deactivated_at", null);
  const { data: filtered } = await svc.from("users")
    .select("id").eq("org_id", home.org.id)
    .in("id", [home.user.id, foreign.user.id]).is("deactivated_at", null);

  const unfilteredIds = (unfiltered ?? []).map((r) => r.id);
  const filteredIds = (filtered ?? []).map((r) => r.id);

  unfilteredIds.includes(foreign.user.id)
    ? ok("without the org filter the foreign user WOULD be a recipient — the bug was real")
    : bad("could not reproduce the pre-fix lookup; this test proves nothing as written");

  !filteredIds.includes(foreign.user.id) && filteredIds.includes(home.user.id)
    ? ok("with it, the foreign user is dropped and the home user is kept")
    : bad(`the org filter did not behave as expected: ${JSON.stringify(filteredIds)}`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────
if (madeTickets.length) {
  await svc.from("tickets").delete().in("id", madeTickets);
}
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a dispatch cannot cross an organisation, and an ordinary one still works."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
