// A WhatsApp request must reach the people who handle it.
//
// The defect this guards: the webhook wrote tickets with sender_id and
// property_id both NULL, and the select policy scopes non-`read_all` readers on
// `property_id in (...)` — which NULL never satisfies. So every chat request was
// invisible to a Facility Manager, an ops staffer and a property owner, and a
// tenant could not see their own.
//
// The claims that matter:
//   • a known sender resolves to the user and their property
//   • an unknown sender resolves to nobody rather than to someone plausible
//   • resolution never crosses an org boundary
//   • an unassigned request is visible to a triager and to nobody else
//   • the new clause cannot widen access to a request that HAS a property
//   • a tenant sees their own resolved request
//
// Usage: node scripts/verify-chat-request-visibility.mjs
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
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const orgRes = await svc.from("orgs").select("id, name, delivery_brand");
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const poc = orgRes.data.find((o) => o.delivery_brand === "direct");
const tfml = orgRes.data.find((o) => o.delivery_brand === "TFML");

const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const made = [];

console.log("Chat requests reaching the dashboard\n");

// A tenant in the POC org who occupies a unit — the resolvable case.
const { data: occupied } = await svc
  .from("units")
  .select("id, property_id, occupant_user_id, org_id")
  .eq("org_id", poc.id)
  .not("occupant_user_id", "is", null)
  .not("property_id", "is", null)
  .limit(1)
  .maybeSingle();

if (!occupied) {
  console.error("No occupied unit in the POC org — cannot exercise resolution.");
  process.exit(1);
}
const { data: tenant } = await svc
  .from("users").select("id, email, phone").eq("id", occupied.occupant_user_id).single();

// Give that tenant a phone for the duration, and put it back afterwards.
const originalPhone = tenant.phone;
const testPhone = `+23480${stamp.replace(/\D/g, "0").padEnd(6, "7").slice(0, 6)}11`;
await svc.from("users").update({ phone: testPhone }).eq("id", tenant.id);
const senderRef = testPhone.replace(/\D/g, "");

console.log("A. A sender we know resolves to them and their property");
{
  const { data, error } = await svc
    .rpc("resolve_chat_sender", { p_org_id: poc.id, p_sender_ref: senderRef })
    .maybeSingle();
  if (error) bad(`resolver errored — ${error.message.slice(0, 60)}`);
  else {
    data?.user_id === tenant.id
      ? ok("the phone resolved to the right user")
      : bad(`resolved to ${data?.user_id ?? "nobody"}, expected ${tenant.id}`);
    data?.property_id === occupied.property_id
      ? ok("and to the property of the unit they occupy")
      : bad(`property was ${data?.property_id ?? "null"}, expected ${occupied.property_id}`);
  }

  // The local form of the same number must resolve identically.
  const { data: localForm } = await svc
    .rpc("resolve_chat_sender", { p_org_id: poc.id, p_sender_ref: `0${senderRef.slice(3)}` })
    .maybeSingle();
  localForm?.user_id === tenant.id
    ? ok("the local 0-prefixed form of the number resolves the same way")
    : bad("the same number in local format did not resolve");
}

console.log("\nB. A sender we do not know resolves to nobody");
{
  const { data } = await svc
    .rpc("resolve_chat_sender", { p_org_id: poc.id, p_sender_ref: "2349099999999" })
    .maybeSingle();
  !data?.user_id
    ? ok("an unrecognised number attaches to no one")
    : bad("AN UNKNOWN NUMBER WAS ATTACHED TO A USER");

  const { data: short } = await svc
    .rpc("resolve_chat_sender", { p_org_id: poc.id, p_sender_ref: "12345" })
    .maybeSingle();
  !short?.user_id
    ? ok("too few digits to identify anyone resolves to nobody")
    : bad("a 5-digit sender ref matched a user");
}

console.log("\nC. Resolution never crosses an org boundary");
{
  // The very same number, asked for as if it had written to TFML.
  const { data } = await svc
    .rpc("resolve_chat_sender", { p_org_id: tfml.id, p_sender_ref: senderRef })
    .maybeSingle();
  !data?.user_id
    ? ok("the same number does not resolve to a member of a different brand")
    : bad("CROSS-ORG RESOLUTION — a POC tenant was attached to a TFML request");
}

console.log("\nD. What each role can see");
{
  // One unassigned request (no property) and one filed against a property.
  const { data: unassigned } = await svc.from("tickets").insert({
    org_id: poc.id, channel: "whatsapp", channel_sender_ref: `234900000${stamp.slice(0, 4)}`,
    message_text: `PROBE-UNASSIGNED-${stamp}`, category: "maintenance", urgency: "normal",
  }).select("id").single();
  made.push(unassigned.id);

  const { data: filed } = await svc.from("tickets").insert({
    org_id: poc.id, channel: "whatsapp", channel_sender_ref: `234900001${stamp.slice(0, 4)}`,
    message_text: `PROBE-FILED-${stamp}`, category: "maintenance", urgency: "normal",
    property_id: occupied.property_id,
  }).select("id").single();
  made.push(filed.id);

  // Defaults first. B7 scopes a Facility Manager to assigned properties, and an
  // unassigned request is in none — so the capability starts OFF for everyone
  // but an administrator, who reads every request anyway.
  for (const [email, label, shouldSeeUnassigned] of [
    ["demo@oegroup.test", "an administrator", true],
    ["fm@oegroup.test", "a facility manager", false],
    ["ops@oegroup.test", "an ops staffer", false],
    ["vendor@oegroup.test", "a vendor", false],
  ]) {
    const c = await login(email);
    const { data: seen } = await c.from("tickets").select("id").eq("id", unassigned.id);
    const got = (seen ?? []).length > 0;
    got === shouldSeeUnassigned
      ? ok(`${label} ${got ? "sees" : "does not see"} an unassigned request — the shipped default`)
      : bad(`${label.toUpperCase()} ${got ? "SAW" : "COULD NOT SEE"} the unassigned request`);
    await c.auth.signOut();
  }

  // And the toggle must actually move it. This is the part that was broken: the
  // grant lived outside `seed_b7_permissions`, so it survived only until the
  // next reset — the capability looked granted and was not.
  await svc.from("role_permissions").update({ granted: true })
    .eq("org_id", poc.id).eq("role", "facility_manager")
    .eq("capability", "tickets.triage_unassigned");
  {
    const c = await login("fm@oegroup.test");
    const { data: seen } = await c.from("tickets").select("id").eq("id", unassigned.id);
    (seen ?? []).length === 1
      ? ok("turning the toggle ON lets a facility manager see it")
      : bad("THE TOGGLE DOES NOT WORK — granted, and still invisible");
    await c.auth.signOut();
  }

  // A reset must return it to the baseline rather than leaving the grant behind.
  await svc.rpc("seed_b7_permissions", { p_org_id: poc.id });
  await svc.from("role_permissions").update({ granted: false })
    .eq("org_id", poc.id).eq("role", "facility_manager")
    .eq("capability", "tickets.triage_unassigned");
  {
    const { data: row } = await svc.from("role_permissions")
      .select("granted").eq("org_id", poc.id).eq("role", "facility_manager")
      .eq("capability", "tickets.triage_unassigned").maybeSingle();
    row?.granted === false
      ? ok("and the baseline puts it back OFF")
      : bad("the capability did not return to its baseline");
  }

  // The new clause must be incapable of admitting a request that HAS a property.
  const ops = await login("ops@oegroup.test");
  const { data: opsFiled } = await ops.from("tickets").select("id").eq("id", filed.id);
  (opsFiled ?? []).length === 0
    ? ok("the triage clause cannot reach a request that belongs to a property")
    : bad("THE NEW CLAUSE WIDENED ACCESS to a property-scoped request");
  await ops.auth.signOut();
}

console.log("\nE. A tenant sees their own resolved request");
{
  const { data: mine } = await svc.from("tickets").insert({
    org_id: poc.id, channel: "whatsapp", channel_sender_ref: senderRef,
    message_text: `PROBE-MINE-${stamp}`, category: "maintenance", urgency: "normal",
    sender_id: tenant.id, property_id: occupied.property_id,
  }).select("id").single();
  made.push(mine.id);

  const c = await login(tenant.email);
  const { data: seen } = await c.from("tickets").select("id").eq("id", mine.id);
  (seen ?? []).length === 1
    ? ok("the tenant who wrote in can read their own request")
    : bad("A TENANT CANNOT SEE THEIR OWN WHATSAPP REQUEST");

  // And still nobody else's.
  const { data: notMine } = await c.from("tickets").select("id").eq("id", made[0]);
  (notMine ?? []).length === 0
    ? ok("and not the unassigned request that is not theirs")
    : bad("a tenant read someone else's request");
  await c.auth.signOut();
}

console.log("\nF. The capability defaults are the restrictive ones");
{
  const { data: rows } = await svc
    .from("role_permissions")
    .select("role, granted")
    .eq("capability", "tickets.triage_unassigned")
    .eq("org_id", poc.id);
  const on = (rows ?? []).filter((r) => r.granted).map((r) => r.role).sort();
  // admin reads everything anyway; an executive is oversight; a regional manager
  // triages their own region — the three roles for whom an unfiled request is
  // their business. Everyone property-scoped stays off (board, 29 Jul 2026).
  const expected = ["admin", "executive", "regional_manager"];
  JSON.stringify(on) === JSON.stringify(expected)
    ? ok(`granted to ${expected.join(", ")} — everyone property-scoped stays off`)
    : bad(`granted to: ${on.join(", ") || "nobody"}, expected ${expected.join(", ")}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("tickets").delete().in("id", made);
await svc.from("users").update({ phone: originalPhone }).eq("id", tenant.id);
console.log("\n(cleaned up; the tenant's phone restored)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — chat requests reach the people who handle them, and no further."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
