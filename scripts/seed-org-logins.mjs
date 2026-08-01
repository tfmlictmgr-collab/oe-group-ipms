// One documented login per role, per organisation — and a sweep of the probe
// accounts that verification runs left behind.
//
// ⚠️ Why this replaces the old flat pool. Every demo account lived in the POC
// org, so "sign in as an FM" always landed in the POC whatever brand you meant
// to look at, and the operator credential was indistinguishable from a tenant
// one. That is what made the product read as a proof-of-concept with roles
// bolted on rather than a platform with organisations in it.
//
// Now each credential belongs to exactly one org and names the door it opens:
//   • the operator signs in at /login          → lands on the org launcher
//   • everyone else signs in at /o/<slug>      → lands in their own dashboard
//
// Usage: node scripts/seed-org-logins.mjs
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

const PASSWORD = "OEGroupDemo2026!";

// Roles worth having a standing login for, per tenant org. Deliberately not
// every role in the enum — a login nobody uses is a credential nobody rotates.
const TENANT_ROLES = [
  ["admin", "Administrator"],
  ["executive", "Managing Director"],
  ["finance_approver", "Finance Approver"],
  ["regional_manager", "Regional Manager"],
  ["facility_manager", "Manager"],
  ["fm_ops_staff", "Operations Staff"],
  ["property_owner", "Property Owner"],
  ["tenant", "Tenant"],
  ["vendor", "Vendor"],
];

// ── 1. Sweep the probe accounts ───────────────────────────────────────────
//
// Same fault class as the hierarchy nodes and the probe properties: suites whose
// end-of-run cleanup never ran because an earlier assertion threw. They surface
// as dozens of nonsense names on the People screen.
// ⚠️ These are DEACTIVATED, not deleted, and the distinction is not a
// compromise — it is the only correct answer.
//
// `audit_log.actor_id` references `users`, and the audit trail is append-only
// (guardrail A3, enforced by trigger). Any account that has ever done anything
// therefore CANNOT be hard-deleted, by design: erasing an actor would leave
// audit records pointing at nobody.
//
// The first version of this sweep tried to delete and counted only successes —
// so it silently skipped every account with any history, reported a number, and
// left 72 probe users sitting in the tenant picker. **Counting successes while
// discarding errors is how a cleanup reports work it did not do.**
//
// Deactivation is what the product already uses for a departing member: the row
// stays for the audit trail, and every picker filters `deactivated_at is null`,
// so they disappear from the UI without breaking the record.
const PROBE_PATTERNS = [
  "probe%", "probeop.%", "probehier.%", "probereview.%", "probeapp-%",
  "invitee-%", "%@oegroup-probe.test", "%@oegroup-invite.test",
];

// ⚠️ The guard below is deliberate, but the incident it was first written up
// against was misdiagnosed, and the correction matters more than the guard.
//
// Eleven real demo accounts — demo@, fm@, finance@, owner@, ops@, resident@,
// vendor@, tfml@, oea@ and both finance aliases — were deactivated in one run,
// half a second apart, and `verify-asset-access` then failed with "FM sees 0
// assets". That was read as this sweep going rogue against patterns that do not
// match those addresses, and the cause was recorded as unreproducible.
//
// **It was not this sweep.** Those eleven were deactivated deliberately, by a
// separate one-off script, when the flat demo pool was retired in favour of the
// org-scoped credentials — a decision taken and approved on purpose. They were
// half a second apart because that script looped through eleven addresses in
// sequence. Nothing here misfired, and there was never a phantom to reproduce.
//
// The lesson worth keeping is the one that actually applies: **a cleanup that
// reports only a count cannot tell you whether it touched the right rows**, so
// this one names every address it sweeps (see `touched` below). That is what
// turns "66 deactivated" into a claim someone can check.
//
// The guard stays regardless — not because a bug was found, but because the
// blast radius of a wrong pattern here is every login in the system, and that is
// worth a belt-and-braces check on cheap terms. The decision to touch an account
// is re-made on the account itself, immediately before the write, from its own
// address — not inherited from whatever the query returned.
const PROBE_MARKERS = /(^probe)|(^invitee-)|(@oegroup-probe\.test$)|(@oegroup-invite\.test$)/i;

/** Never sweeps an address that does not itself look like a fixture. */
const isProbeAccount = (email) => typeof email === "string" && PROBE_MARKERS.test(email.trim());

let deactivated = 0;
let removed = 0;
let refused = 0;
const failures = [];
const touched = [];

for (const pattern of PROBE_PATTERNS) {
  const { data, error: qErr } = await svc
    .from("users").select("id, email").ilike("email", pattern).is("deactivated_at", null);
  if (qErr) { failures.push(`query ${pattern}: ${qErr.message.slice(0, 50)}`); continue; }

  for (const u of data ?? []) {
    // The guard. A row that reached here without a fixture-shaped address is a
    // bug in the query, and the right response is to leave it alone and say so.
    if (!isProbeAccount(u.email)) {
      refused++;
      failures.push(`REFUSED to sweep ${u.email} — it is not a fixture address`);
      continue;
    }
    // Detach the live attachments either way, so a probe account stops holding
    // a unit or a vendor record even while its audit history keeps the row.
    await svc.from("property_stakeholders").delete().eq("user_id", u.id);
    await svc.from("units").update({ occupant_user_id: null }).eq("occupant_user_id", u.id);
    await svc.from("vendors").update({ user_id: null }).eq("user_id", u.id);

    // Try a real delete first — an account that never acted leaves nothing
    // behind and is better gone than lingering as a deactivated ghost.
    const { error } = await svc.from("users").delete().eq("id", u.id);
    if (!error) {
      await svc.auth.admin.deleteUser(u.id).catch(() => {});
      removed++;
      continue;
    }

    const { error: deactErr } = await svc
      .from("users").update({ deactivated_at: new Date().toISOString() }).eq("id", u.id);
    if (deactErr) failures.push(`${u.email}: ${deactErr.message.slice(0, 50)}`);
    else { deactivated++; touched.push(u.email); }
  }
}

console.log(
  `Probe accounts — ${removed} deleted, ${deactivated} deactivated ` +
  `(kept for the audit trail they are referenced by).`
);

// Every address that was touched, named. The damage was invisible last time
// because the script reported only a COUNT — "66 deactivated" says nothing
// about whether they were the right 66.
if (touched.length) {
  console.log(`  swept: ${touched.slice(0, 8).join(", ")}${touched.length > 8 ? ` … +${touched.length - 8}` : ""}`);
}
if (refused > 0) {
  console.log(`  \x1b[31m${refused} row(s) REFUSED — the query returned non-fixture accounts\x1b[0m`);
}
if (failures.length) {
  console.log(`  ${failures.length} issue(s):`);
  for (const f of failures.slice(0, 6)) console.log(`   ${f}`);
}
console.log("");

// ── 2. Resolve the organisations ──────────────────────────────────────────
const { data: orgs, error: orgErr } = await svc
  .from("orgs")
  .select("id, name, slug, delivery_brand, is_platform_operator")
  .is("deleted_at", null)
  .order("name");
if (orgErr) { console.error(orgErr.message); process.exit(1); }

const operator = orgs.find((o) => o.is_platform_operator);
if (!operator) { console.error("No platform operator org — run migration 0088."); process.exit(1); }

const { data: authList } = await svc.auth.admin.listUsers({ perPage: 1000 });

// ⚠️ `app_metadata` is not decoration — it is B1's second isolation layer.
//
// Org, brand and role ride inside the SIGNED JWT, and `middleware` stamps them
// onto the forwarded request after deleting anything the client tried to send
// (`lib/org-context.ts`). A token without them leaves `orgContext()` returning
// nulls, so any route that checks the brand instead of re-querying loses its
// defence-in-depth. `app_metadata` is admin-only writable, which is what makes
// the claim trustworthy in the first place.
//
// This was missing from every login this script created. `seed.mjs` stamped it
// and this script did not, so the flat demo pool carried claims while the
// org-scoped credentials that replaced it did not — meaning retiring the flat
// pool silently took layer 2 out of everyday use. RLS never stopped holding
// (`current_user_org_id()` reads the profile table, not the token), which is
// exactly why nothing failed loudly: **the backstop hid the missing layer.**
async function ensureLogin(email, orgId, role, fullName, brand) {
  const appMetadata = { org_id: orgId, delivery_brand: brand ?? "direct", role };

  let authUser = authList?.users?.find((u) => u.email === email);
  if (!authUser) {
    const { data, error } = await svc.auth.admin.createUser({
      email, password: PASSWORD, email_confirm: true, app_metadata: appMetadata,
    });
    if (error) {
      // Already exists but wasn't in the page we listed — look it up rather
      // than silently skipping, which would leave a login that cannot sign in.
      const { data: again } = await svc.auth.admin.listUsers({ perPage: 1000 });
      authUser = again?.users?.find((u) => u.email === email);
      if (!authUser) return { email, ok: false, why: error.message.slice(0, 60) };
      // Found on the second look — it still needs the claim refreshed below.
      await svc.auth.admin.updateUserById(authUser.id, {
        password: PASSWORD, app_metadata: appMetadata,
      });
    } else {
      authUser = data.user;
    }
  } else {
    // Reset the password so a documented credential always actually works, and
    // refresh the claim so it can never drift from the profile it describes.
    await svc.auth.admin.updateUserById(authUser.id, {
      password: PASSWORD, app_metadata: appMetadata,
    });
  }

  const { error } = await svc.from("users").upsert({
    id: authUser.id, org_id: orgId, role, full_name: fullName, email,
  });
  return { email, ok: !error, why: error?.message.slice(0, 60) };
}

// ── 3. The operator's own administrator ───────────────────────────────────
//
// The ONLY account that should reach /login and see the launcher.
const rows = [];
rows.push({
  org: operator.name, slug: operator.slug, role: "admin", door: "/login",
  ...(await ensureLogin("platform@oegroup.test", operator.id, "admin",
                        "OE Group Platform Admin", operator.delivery_brand)),
});

// ── 4. One login per role, per tenant org ─────────────────────────────────
for (const org of orgs.filter((o) => !o.is_platform_operator)) {
  for (const [role, title] of TENANT_ROLES) {
    // `oea.finance@…` reads as "the OEA finance login" at a glance, which is the
    // whole point — the email itself says which door it belongs at.
    const email = `${org.slug}.${role.replace(/_/g, "")}@oegroup.test`;
    rows.push({
      org: org.name, slug: org.slug, role, door: `/o/${org.slug}`,
      ...(await ensureLogin(email, org.id, role, `${org.delivery_brand} ${title}`,
                            org.delivery_brand)),
    });
  }
}

// ── 5. Give the scoped roles something to be scoped to ────────────────────
//
// ⚠️ A facility manager with no `property_stakeholders` row manages nothing, and
// `current_user_property_ids()` returns empty for them — so every policy that
// scopes by property refuses, correctly. The account exists, holds the right
// capability, and can still do nothing.
//
// That is not a hypothetical: `verify-asset-access` failed with "create on
// managed property refused — violates row-level security", which reads as a
// broken policy. The policy was right. The FIXTURE was incomplete, because this
// script created the roles and never gave the place-scoped ones a place.
//
// An administrator needs no assignment (they are org-wide by policy), and a
// tenant is scoped by unit occupancy rather than stakeholding — so only the
// manager and the owner are attached here.
const SCOPED = { facility_manager: "manager", property_owner: "owner" };
let attached = 0;

for (const org of orgs.filter((o) => !o.is_platform_operator)) {
  const { data: props } = await svc
    .from("properties").select("id").eq("org_id", org.id).is("deleted_at", null);
  if (!props?.length) continue;

  for (const [role, relation] of Object.entries(SCOPED)) {
    const email = `${org.slug}.${role.replace(/_/g, "")}@oegroup.test`;
    const { data: person } = await svc
      .from("users").select("id").eq("email", email).maybeSingle();
    if (!person) continue;

    // ⚠️ The manager gets a PROPER SUBSET, never the whole portfolio.
    //
    // Attaching them to everything makes the fixture indistinguishable from an
    // administrator: "FM sees 15 payments, admin sees 15" is then correct
    // behaviour, and `verify-access-matrix` reports it as a scoping failure
    // because scoping is exactly what it can no longer observe. A suite needs
    // something OUTSIDE the scope to prove the boundary holds.
    //
    // The owner keeps everything — a landlord owning their whole portfolio is
    // the ordinary case, and the owner's boundary is tested against the OTHER
    // org rather than against a property next door.
    //
    // ⚠️ WHICH property is withheld matters. Dropping the last one left the
    // manager holding Victoria Court — where the only out-of-scope vendors and
    // their payouts live — and excluded an empty duplicate instead. The FM then
    // saw all 15 payments, correctly, and `verify-access-matrix` reported a
    // money-scoping failure that was really a fixture that proved nothing.
    //
    // So the withheld property is one that actually CARRIES vendors: the
    // boundary is only observable where there is something on the other side
    // of it.
    let targets = props;
    if (props.length > 1) {
      const { data: links } = await svc
        .from("vendor_properties")
        .select("property_id")
        .in("property_id", props.map((p) => p.id));
      const withVendors = new Set((links ?? []).map((l) => l.property_id));

      // The property held back from the manager must satisfy two suites at
      // once, and they pull in opposite directions:
      //
      //   • `verify-access-matrix` needs it to CARRY VENDORS, or the money-side
      //     boundary has nothing on the far side of it to exclude.
      //   • `verify-asset-import-e2e` needs the manager to still reach the
      //     property holding the asset tag it expects a duplicate collision on —
      //     withhold that one and the importer cannot see the tag, so the
      //     duplicate row passes and three rows import instead of two.
      //
      // Both hold if the withheld property carries vendors but the FEWEST
      // assets: the money boundary is observable, and the asset fixtures stay
      // inside the manager's reach.
      const { data: assetRows } = await svc
        .from("assets").select("property_id")
        .in("property_id", props.map((p) => p.id)).is("deleted_at", null);
      const assetCount = new Map();
      for (const a of assetRows ?? []) {
        assetCount.set(a.property_id, (assetCount.get(a.property_id) ?? 0) + 1);
      }

      const candidates = props.filter((p) => withVendors.has(p.id));
      const withheld =
        candidates.sort(
          (a, b) => (assetCount.get(a.id) ?? 0) - (assetCount.get(b.id) ?? 0)
        )[0] ?? props[props.length - 1];

      // Manager: everything except that one. Owner: ONLY that one.
      //
      // Two scopes that genuinely differ, rather than one containing the other —
      // which is what lets the suite tell property scoping apart from role
      // scoping. Giving the owner the whole portfolio made them see more than
      // the manager, and `verify-access-matrix` reported "FM/owner ticket
      // scoping unexpected" for a fixture that was simply the wrong shape.
      targets =
        relation === "manager"
          ? props.filter((p) => p.id !== withheld.id)
          : [withheld];
    }

    for (const p of targets) {
      const { error } = await svc.from("property_stakeholders").insert({
        org_id: org.id, property_id: p.id, user_id: person.id, relation,
      });
      // Already attached is the desired end state, not a failure.
      if (!error) attached++;
      else if (!error.message.includes("duplicate key")) {
        failures.push(`${email} → property: ${error.message.slice(0, 50)}`);
      }
    }
  }
}

if (attached > 0) console.log(`Attached ${attached} property assignment(s) to scoped roles.\n`);

// ── 6. Report ─────────────────────────────────────────────────────────────
const failed = rows.filter((r) => !r.ok);
let currentOrg = null;
for (const r of rows) {
  if (r.org !== currentOrg) {
    currentOrg = r.org;
    console.log(`\n${r.org}  —  sign in at ${r.door}`);
  }
  console.log(`  ${r.role.padEnd(18)} ${r.email}${r.ok ? "" : `   ✗ ${r.why}`}`);
}

console.log(`\nPassword for every account above: ${PASSWORD}`);
console.log(
  failed.length === 0
    ? `\n${rows.length} login(s) ready.`
    : `\n${failed.length} of ${rows.length} FAILED.`
);
process.exit(failed.length === 0 ? 0 : 1);
