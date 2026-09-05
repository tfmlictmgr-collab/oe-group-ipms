// A regional manager supersedes the FM/PM below them, and the operational desk
// sees the budget on a building it holds (0236).
//
// The claims that matter:
//   • the regional manager holds sc.manage, leases.write and hierarchy.write
//   • and STILL does not hold sc.read_all — the org-wide read decision 9 denies
//     them. The whole design rests on this: their reach is the place, not a
//     capability that ignores place.
//   • the FM/PM hold hierarchy.write, which decision 8 has specified since
//     29 July 2026 and which was granted to nobody but an administrator
//   • what any of them READS is exactly the budgets on properties they hold —
//     which has been true in the policy since 0055 and was hidden by the nav
//   • the new write is BOUNDED: a regional manager may raise a budget on a
//     property they hold and is refused on one they do not. Without this,
//     granting sc.manage would have reached the whole organisation.
//   • admin, the payment officer and the executive are unchanged
//   • a tenant gained nothing
//
// Usage: node scripts/verify-regional-authority.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) { bad(`could not sign in as ${email}: ${error.message}`); return null; }
  return c;
};

const { data: orgs } = await svc.from("orgs").select("id, slug").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");

const reg = await login("oea.regional@oegroup.test");
const pm = await login("oea.pm@oegroup.test");
const fm = await login("oea.fmgr@oegroup.test");
const fin = await login("oea.finance@oegroup.test");
const exec = await login("oea.executive@oegroup.test");
const ten = await login("oea.tenant@oegroup.test");
if (!reg || !pm || !fm || !fin || !exec || !ten) {
  console.log("\n\x1b[31mfixtures missing — run the brand seeds first\x1b[0m");
  process.exit(1);
}

const holds = async (c, cap) => Boolean((await c.rpc("has_permission", { p_capability: cap })).data);

// ── A ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§A What each desk now holds\x1b[0m");
for (const cap of ["sc.manage", "leases.write", "hierarchy.write"]) {
  (await holds(reg, cap))
    ? ok(`the regional manager holds ${cap}`)
    : bad(`the regional manager does not hold ${cap}`);
}
// ⚠️ The load-bearing negative. sc.read_all means "read every service charge,
// not only their own" — org-wide, which decision 9 denies this role. If this
// ever passes, the scoping below has been replaced by a blanket grant and the
// rest of this suite is measuring the wrong thing.
(await holds(reg, "sc.read_all"))
  ? bad("the regional manager holds sc.read_all — that is the ORG-WIDE read, denied by decision 9")
  : ok("the regional manager does NOT hold sc.read_all — their reach is the place, not a blanket");

for (const [label, c] of [["a property manager", pm], ["a facilities manager", fm]]) {
  (await holds(c, "hierarchy.write"))
    ? ok(`${label} holds hierarchy.write — decision 8 delivered`)
    : bad(`${label} does not hold hierarchy.write`);
}

// ⚠️ AMENDED by decision 29 (5 Sept 2026). This block asserted that NEITHER the
// property manager nor the facilities manager holds `sc.manage`, which was
// exactly right on 30 Aug: decision 26 granted it to the regional manager
// alone. Decision 29 then gave it — and `leases.write` — to the PROPERTY
// manager as well, and deliberately not to the facilities manager, the first
// divergence between the two decision-18 peers.
//
// So the assertion is not weakened, it is SPLIT. The half that still carries
// the weight is the facilities manager's, because the whole risk in decision 29
// is granting a lettings capability to the wrong peer, and an accident there
// would be silent.
(await holds(pm, "sc.manage"))
  ? ok("a property manager holds sc.manage — decision 29")
  : bad("a property manager does not hold sc.manage — decision 29 was not delivered");
(await holds(pm, "leases.write"))
  ? ok("a property manager holds leases.write — decision 29")
  : bad("a property manager does not hold leases.write — decision 29 was not delivered");

for (const cap of ["sc.manage", "leases.write"]) {
  (await holds(fm, cap))
    ? bad(`a facilities manager holds ${cap} — it was granted to the wrong peer`)
    : ok(`a facilities manager does not hold ${cap} — TFML's FM stays maintenance-scoped`);
}
(await holds(pm, "sc.read_all"))
  ? bad("a property manager holds sc.read_all — that is the ORG-WIDE read")
  : ok("a property manager does NOT hold sc.read_all — their reach is the place");

// ── B ──────────────────────────────────────────────────────────────────────
//
// Not "sees budgets": a manager assigned to nothing correctly sees nothing.
// The claim is that what they see is EXACTLY the budgets on the properties
// they hold, so a fixture with no assignment still proves the rule.
console.log("\n\x1b[1m§B What they read is what they hold\x1b[0m");
const { data: allBudgets } = await svc
  .from("sc_budgets").select("id, property_id").eq("org_id", oea.id);

for (const [label, c] of [
  ["the regional manager", reg], ["a property manager", pm], ["a facilities manager", fm],
]) {
  const { data: props } = await c.from("properties").select("id");
  const held = new Set((props ?? []).map((p) => p.id));
  const expected = (allBudgets ?? []).filter((b) => held.has(b.property_id)).length;
  const { data: seen } = await c.from("sc_budgets").select("id");
  (seen ?? []).length === expected
    ? ok(`${label} reads ${seen.length} budget(s) — exactly those on the ${held.size} propert(ies) they hold`)
    : bad(`${label} reads ${(seen ?? []).length}, expected ${expected} for ${held.size} held propert(ies)`);
  if (expected === 0) note(`${label} is assigned no property carrying a budget; the rule is proved by the zero, not weakened by it`);
}

const { data: tenB } = await ten.from("sc_budgets").select("id");
(tenB ?? []).length === 0
  ? ok("a tenant reads no budgets — nothing here opened the read side")
  : bad(`a tenant reads ${tenB.length} budget(s)`);

// ── C ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§C The place clause bounds the new write\x1b[0m");
const { data: myProps } = await reg.from("properties").select("id, name");
const held = new Set((myProps ?? []).map((p) => p.id));
const { data: everyProp } = await svc
  .from("properties").select("id, name").eq("org_id", oea.id).is("deleted_at", null);
note(`the regional manager holds ${held.size} of ${(everyProp ?? []).length} OEA properties`);

const outside = (everyProp ?? []).find((p) => !held.has(p.id));
if (outside) {
  const { data: made, error } = await reg.from("sc_budgets").insert({
    org_id: oea.id, property_id: outside.id, period: "PROBE0236-OUT",
    total_amount: 1000, status: "draft",
  }).select("id").maybeSingle();
  error
    ? ok(`refused a budget on "${outside.name}" — a property they do not hold`)
    : bad(`ALLOWED a budget on "${outside.name}" — the place clause did not bind`);
  if (made) await svc.from("sc_budgets").delete().eq("id", made.id);
} else {
  note("this manager holds every property; the outside-the-region case cannot be tested here");
}

const inside = (myProps ?? [])[0];
if (inside) {
  const { data: made, error } = await reg.from("sc_budgets").insert({
    org_id: oea.id, property_id: inside.id, period: "PROBE0236-IN",
    total_amount: 500000, status: "draft",
  }).select("id").maybeSingle();
  error
    ? bad(`refused a budget on "${inside.name}", which they DO hold: ${error.message}`)
    : ok(`raised a budget on "${inside.name}" — a property they hold`);
  if (made) await svc.from("sc_budgets").delete().eq("id", made.id);
}

// ── D ──────────────────────────────────────────────────────────────────────
//
// The place clause was added to policies finance already satisfied. Both admin
// and the payment officer sit in oversight_roles(), so their reach must be
// byte-identical to before — if this section moves, the clause was written
// wrong.
console.log("\n\x1b[1m§D Oversight is exactly where it was\x1b[0m");
for (const [label, c] of [["the payment officer", fin], ["the executive", exec]]) {
  const { data: seen } = await c.from("sc_budgets").select("id");
  (seen ?? []).length === (allBudgets ?? []).length
    ? ok(`${label} still reads all ${seen.length} budget(s), org-wide`)
    : bad(`${label} reads ${(seen ?? []).length} of ${(allBudgets ?? []).length} — oversight was narrowed`);
}
(await holds(fin, "sc.manage"))
  ? ok("the payment officer still holds sc.manage")
  : bad("the payment officer lost sc.manage");
(await holds(exec, "sc.manage"))
  ? bad("the executive holds sc.manage — oversight authorises, it does not administer")
  : ok("the executive still does not hold sc.manage");

// ── E ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§E B1 still holds across the brands\x1b[0m");
const tfmlReg = await login("tfml.regional@oegroup.test");
if (tfmlReg) {
  const { data: seen } = await tfmlReg.from("sc_budgets").select("id, org_id");
  (seen ?? []).some((b) => b.org_id === oea.id)
    ? bad("TFML's regional manager reads an OEA budget — B1 broken")
    : ok(`TFML's regional manager reads ${(seen ?? []).length} budget(s), none of them OEA's`);
}

console.log(
  failures
    ? `\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m`
    : "\n\x1b[32m✔ regional authority: all checks passed\x1b[0m"
);
process.exit(failures ? 1 : 0);
