// Finding a request by the reference the reporter was actually given.
//
// Every acknowledgement quotes `shortRef()` — the first eight hex characters
// of the ticket id ("C1AF0AF7"). The dashboard could not be searched by it,
// and did not even display it, so a reference read off a WhatsApp thread had
// to be matched by scrolling.
//
// ⚠️ The security question this raises, and why the suite leads with it: a
// reference is a PREFIX, and a short one. Four hex characters is 65,536
// possibilities — trivially enumerable. So a lookup that takes a prefix is
// only safe if RLS still scopes the result exactly as the list does. Section
// C is the real test here; A and B are just correctness.
//
// Usage: node scripts/verify-ticket-reference-search.mjs
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

async function login(email) {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: "OEGroupDemo2026!" });
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return c;
}

const MARK = "PROBEREF";
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = [];
const shortRef = (id) => id.replace(/-/g, "").slice(0, 8).toUpperCase();

// Start-of-run sweep.
{
  const { data: strays } = await svc.from("tickets").select("id").like("message_text", `${MARK}%`);
  if (strays?.length) {
    await svc.from("tickets").delete().in("id", strays.map((s) => s.id));
    console.log(`(swept ${strays.length} stray ticket(s))`);
  }
}

const { data: poc } = await svc.from("orgs").select("id").eq("slug", "oe-group-foundation-poc").single();
const { data: tenantA } = await svc.from("users").select("id, email")
  .eq("email", "oe-group-foundation-poc.tenant@oegroup.test").single();
const { data: othersB } = await svc.from("users").select("id, email")
  .eq("org_id", poc.id).eq("role", "tenant").is("deactivated_at", null)
  .neq("id", tenantA.id).limit(1);
const tenantB = othersB?.[0] ?? null;

// A ticket belonging to tenant A, filed against a property.
const { data: filedProp } = await svc.from("tickets")
  .select("property_id").not("property_id", "is", null).eq("org_id", poc.id).limit(1).single();

const { data: t } = await svc.from("tickets").insert({
  org_id: poc.id, channel: "whatsapp", channel_sender_ref: `234700${MARK}`,
  message_text: `${MARK}-${S} the lift is stuck between floors`,
  category: "maintenance", urgency: "high", status: "open",
  sender_id: tenantA.id, property_id: filedProp.property_id,
}).select("id").single();
made.push(t.id);
const ref = shortRef(t.id);

console.log(`Ticket reference search — reference ${ref}\n`);

console.log("A. A quoted reference finds the request");
{
  const c = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
  const { data, error } = await c.rpc("find_tickets_by_reference", { p_ref: ref });
  if (error) bad(`the lookup failed: ${error.message}`);
  (data ?? []).some((r) => r.id === t.id)
    ? ok(`the FM/PM finds it by the reference the reporter was given (${ref})`)
    : bad("THE REFERENCE DID NOT FIND ITS OWN TICKET");
  await c.auth.signOut();
}

console.log("\nB. However the person happens to type it");
{
  const c = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
  for (const [label, q] of [
    ["lowercase", ref.toLowerCase()],
    ["with a leading #", `#${ref}`],
    ["with spaces around it", `  ${ref}  `],
    ["a 4-character prefix", ref.slice(0, 4)],
    ["the full UUID, dashes and all", t.id],
  ]) {
    const { data } = await c.rpc("find_tickets_by_reference", { p_ref: q });
    (data ?? []).some((r) => r.id === t.id)
      ? ok(`${label} — found`)
      : bad(`${label} (${q}) DID NOT FIND IT`);
  }
  await c.auth.signOut();
}

console.log("\nC. A prefix is guessable — so RLS must still scope the answer");
if (tenantB) {
  const c = await login(tenantB.email);
  const { data, error } = await c.rpc("find_tickets_by_reference", { p_ref: ref });
  if (error) bad(`the lookup errored for an unrelated tenant: ${error.message}`);
  (data ?? []).some((r) => r.id === t.id)
    ? bad("!!! AN UNRELATED TENANT FOUND SOMEONE ELSE'S REQUEST BY QUOTING ITS REFERENCE")
    : ok("an unrelated tenant gets nothing back for a reference that is not theirs");

  // And the same person genuinely cannot see it by the ordinary route either,
  // so the two answers agree — the lookup is not a second, looser door.
  const { data: direct } = await c.from("tickets").select("id").eq("id", t.id);
  (direct ?? []).length === 0
    ? ok("consistent with the list itself — the lookup is not a wider door than tickets_select")
    : bad("the tenant CAN see the ticket normally, so this section proved nothing");
  await c.auth.signOut();
} else {
  console.log("  (skipped — no second tenant to test isolation with)");
}

console.log("\nD. The reporter finds their OWN request by its reference");
{
  const c = await login(tenantA.email);
  const { data } = await c.rpc("find_tickets_by_reference", { p_ref: ref });
  (data ?? []).some((r) => r.id === t.id)
    ? ok("the tenant who raised it finds it — the reference works for the person holding it")
    : bad("THE REPORTER COULD NOT FIND THEIR OWN REQUEST BY ITS REFERENCE");
  await c.auth.signOut();
}

console.log("\nE. Too short to be a reference returns nothing, rather than everything");
{
  const c = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
  for (const q of ["", "a", "ab", "   "]) {
    const { data } = await c.rpc("find_tickets_by_reference", { p_ref: q });
    (data ?? []).length === 0
      ? ok(`"${q}" returns nothing — a stray keystroke is not a query for every ticket`)
      : bad(`"${q}" returned ${data.length} row(s) — too loose`);
  }
  // Non-hex text is not a reference at all.
  const { data: words } = await c.rpc("find_tickets_by_reference", { p_ref: "the lift" });
  (words ?? []).length === 0
    ? ok('ordinary words ("the lift") return nothing — text search is the list\'s job, not this')
    : bad("a plain-text query was treated as a reference");
  await c.auth.signOut();
}

console.log("\nF. Bounded, so one character cannot ask for the whole table");
{
  const c = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
  const { data } = await c.rpc("find_tickets_by_reference", { p_ref: ref.slice(0, 4) });
  (data ?? []).length <= 20
    ? ok(`a 4-character prefix returns at most 20 rows (${(data ?? []).length})`)
    : bad(`unbounded: ${data.length} rows`);
  await c.auth.signOut();
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("tickets").delete().in("id", made);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a quoted reference finds its request, and only for someone already entitled to see it."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
