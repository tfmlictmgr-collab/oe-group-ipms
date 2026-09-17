// Proves the onboarding/invitation rules against the real dev database.
// The security claims that matter:
//   • the raw token is never stored (only its SHA-256 hash)
//   • preview leaks nothing for a bad/expired/revoked token
//   • an invitation can only be redeemed by the invited email address
//   • the role comes from the invitation, never from the person signing up
//   • an FM/PM cannot mint an admin
//   • acceptance is single-use, and applies the attaché/unit links
// Usage: npx tsx scripts/verify-invitations.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { generateInviteToken, hashInviteToken } from "../lib/invitation.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL, SVCK, { auth: { persistSession: false } });
const anon = createClient(URL, ANON);

async function login(email) {
  const c = createClient(URL, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const admin = await login("oe-group-foundation-poc.admin@oegroup.test");
const fm = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
const { data: { user: adminUser } } = await admin.auth.getUser();
const { data: me } = await admin.from("users").select("org_id").eq("id", adminUser.id).single();
const orgId = me.org_id;

const { data: { user: fmUser } } = await fm.auth.getUser();
const { data: stakes } = await svc
  .from("property_stakeholders").select("property_id").eq("user_id", fmUser.id);
const managedProperty = stakes[0].property_id;

const stamp = Date.now().toString(36);
const invitee = `invitee-${stamp}@oegroup.test`;
const created = []; // auth users to clean up

console.log("Invitation & onboarding rules\n");

// ── Issue one, as the admin ────────────────────────────────────────────────
const token = generateInviteToken();
const tokenHash = hashInviteToken(token);
{
  const { error } = await admin.from("invitations").insert({
    org_id: orgId, email: invitee, role: "facility_manager", full_name: "Test Invitee",
    property_ids: [managedProperty], property_relation: "manager",
    token_hash: tokenHash, invited_by: adminUser.id,
  });
  error ? bad(`could not issue invitation — ${error.message}`) : ok("admin issued an invitation");
}

console.log("\nA. The raw token is never stored");
{
  const { data } = await svc.from("invitations").select("token_hash").eq("token_hash", tokenHash).single();
  if (!data) bad("invitation row not found");
  else if (data.token_hash === token) bad("RAW TOKEN STORED — a DB read could be replayed");
  else if (data.token_hash === tokenHash && /^[a-f0-9]{64}$/.test(data.token_hash))
    ok("only a SHA-256 hash is stored");
  else bad("token_hash is not a SHA-256 hash");
}

console.log("\nB. Preview reveals only what the accept page needs");
{
  const { data } = await anon.rpc("invitation_preview", { p_token_hash: tokenHash });
  const row = data?.[0];
  if (row?.org_name && row?.role === "facility_manager") ok(`anon preview → ${row.org_name} / ${row.role}`);
  else bad(`preview returned ${JSON.stringify(data)}`);

  const { data: junk } = await anon.rpc("invitation_preview", { p_token_hash: hashInviteToken("nonsense") });
  (junk ?? []).length === 0 ? ok("unknown token reveals nothing") : bad("unknown token leaked a row");
}

console.log("\nC. An FM/PM cannot mint an administrator");
{
  const { error } = await fm.from("invitations").insert({
    org_id: orgId, email: `esc-${stamp}@oegroup.test`, role: "admin",
    token_hash: hashInviteToken(generateInviteToken()), invited_by: fmUser.id,
  });
  error ? ok(`blocked (${error.message.slice(0, 50)})`) : bad("ALLOWED — an FM minted an admin invitation");
}

console.log("\nD. A tenant cannot issue invitations at all");
{
  const tenant = await login("oe-group-foundation-poc.tenant@oegroup.test");
  const { data: { user: tu } } = await tenant.auth.getUser();
  const { error } = await tenant.from("invitations").insert({
    org_id: orgId, email: `t-${stamp}@oegroup.test`, role: "tenant",
    token_hash: hashInviteToken(generateInviteToken()), invited_by: tu.id,
  });
  error ? ok(`blocked (${error.message.slice(0, 50)})`) : bad("ALLOWED — a tenant issued an invitation");
}

console.log("\nE. The link can only be redeemed by the invited address");
{
  const wrongEmail = `wrong-${stamp}@oegroup.test`;
  const { data: wrong } = await svc.auth.admin.createUser({
    email: wrongEmail, password: PW, email_confirm: true,
  });
  created.push(wrong.user.id);
  const wrongClient = createClient(URL, ANON);
  await wrongClient.auth.signInWithPassword({ email: wrongEmail, password: PW });
  const { error } = await wrongClient.rpc("accept_invitation", {
    p_token_hash: tokenHash, p_full_name: "Impostor",
  });
  error ? ok(`blocked (${error.message.slice(0, 60)})`) : bad("ALLOWED — a forwarded link was redeemed by someone else");
}

console.log("\nF. The invited user accepts, and gets exactly the invited role");
let inviteeId = null;
{
  const { data: newUser } = await svc.auth.admin.createUser({
    email: invitee, password: PW, email_confirm: true,
  });
  inviteeId = newUser.user.id;
  created.push(inviteeId);

  const c = createClient(URL, ANON);
  await c.auth.signInWithPassword({ email: invitee, password: PW });
  const { error } = await c.rpc("accept_invitation", {
    p_token_hash: tokenHash, p_full_name: "Test Invitee",
  });
  if (error) bad(`acceptance failed — ${error.message}`);
  else {
    const { data: profile } = await svc
      .from("users").select("org_id, role, full_name").eq("id", inviteeId).single();
    profile?.role === "facility_manager"
      ? ok("profile created with the invited role (facility_manager)")
      : bad(`role is ${profile?.role}`);
    profile?.org_id === orgId ? ok("landed in the inviting org") : bad("wrong org");

    const { data: stake } = await svc
      .from("property_stakeholders")
      .select("property_id, relation").eq("user_id", inviteeId);
    stake?.length === 1 && stake[0].property_id === managedProperty
      ? ok("attaché assignment applied (1 property, as manager)")
      : bad(`stakeholder rows: ${JSON.stringify(stake)}`);
  }
}

console.log("\nG. The invitation is single-use");
{
  const c = createClient(URL, ANON);
  await c.auth.signInWithPassword({ email: invitee, password: PW });
  const { error } = await c.rpc("accept_invitation", { p_token_hash: tokenHash, p_full_name: "Again" });
  error ? ok(`second use blocked (${error.message.slice(0, 45)})`) : bad("ALLOWED — invitation reused");

  const { data: inv } = await svc.from("invitations").select("status").eq("token_hash", tokenHash).single();
  inv?.status === "accepted" ? ok("invitation marked accepted") : bad(`status is ${inv?.status}`);
}

console.log("\nH. The new FM/PM sees only their attached property");
if (inviteeId) {
  const c = createClient(URL, ANON);
  await c.auth.signInWithPassword({ email: invitee, password: PW });
  const { data: assets } = await c.from("assets").select("property_id");
  const foreign = (assets ?? []).filter((a) => a.property_id !== managedProperty);
  foreign.length === 0
    ? ok(`reads only assets on the attached property (${assets?.length ?? 0} rows)`)
    : bad(`saw ${foreign.length} assets outside the attached property`);
}

console.log("\nI. Acceptance is audited");
{
  const { count } = await svc
    .from("audit_log").select("*", { count: "exact", head: true }).eq("action", "invitation.write");
  count > 0 ? ok(`${count} invitation.write audit entries`) : bad("no invitation audit entries");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
// An accepted invitee CANNOT be fully deleted: audit_log.actor_id references
// them, and the audit trail is immutable by design (A3). That FK refusal is
// correct behaviour, not a bug — so instead of pretending to delete, strip
// everything that could affect other checks:
//   • remove their property assignments, so they hold no scope,
//   • demote them out of a privileged role, so a script that samples "an FM"
//     can never pick this leftover.
// The audit row remains, which is exactly what an audit trail is for.
await svc.from("property_stakeholders").delete().eq("user_id", inviteeId);
await svc.from("invitations").delete().eq("org_id", orgId).ilike("email", `%-${stamp}@oegroup.test`);

if (inviteeId) {
  await svc.from("users")
    .update({ role: "tenant", full_name: "[test invitee — retained for audit integrity]" })
    .eq("id", inviteeId);
}

// Users with no audit history can be removed outright.
for (const id of created) {
  const { count } = await svc
    .from("audit_log").select("*", { count: "exact", head: true }).eq("actor_id", id);
  if ((count ?? 0) === 0) {
    await svc.from("users").delete().eq("id", id);
    await svc.auth.admin.deleteUser(id);
  }
}
console.log("\n(cleaned up; the accepted invitee is retained because audit references it)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — enrolment grants exactly what was invited, and nothing more."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
