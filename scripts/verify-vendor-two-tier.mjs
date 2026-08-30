// A vendor is recommended by one desk and approved by another (0238).
//
// The claims that matter:
//   • the FM/PM may RECOMMEND and may NOT approve — the decision they used to
//     hold single-handed is gone
//   • the regional manager and the administrator approve
//   • an application cannot be approved before it has been recommended
//   • the recommender may not approve their own recommendation, per
//     application and per person — the control that actually prevents one
//     person admitting their own contractor
//   • a recommendation must say something
//   • refusing is a final decision too, and obeys the same rules
//   • B1 holds: the other brand cannot see or touch it
//
// Usage: node scripts/verify-vendor-two-tier.mjs
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

const pm = await login("oea.pm@oegroup.test");
const fm = await login("oea.fmgr@oegroup.test");
const reg = await login("oea.regional@oegroup.test");
const admin = await login("oea.admin@oegroup.test");
const tfmlReg = await login("tfml.regional@oegroup.test");
if (!pm || !fm || !reg || !admin) process.exit(1);

const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = [];
const newApp = async (name) => {
  const { data, error } = await svc.from("vendor_applications").insert({
    org_id: oea.id, business_name: name, service_category: "Cleaning",
    contact_name: "Probe Contact", contact_email: `probe-${S}-${made.length}@example.com`,
    status: "submitted",
  }).select("id").single();
  if (error) throw new Error(error.message);
  made.push(data.id);
  return data.id;
};
const statusOf = async (id) =>
  (await svc.from("vendor_applications").select("status, recommended_by").eq("id", id).single()).data;

const holds = async (c, cap) => Boolean((await c.rpc("has_permission", { p_capability: cap })).data);

// ── A ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§A Who holds which half\x1b[0m");
for (const [label, c] of [["a property manager", pm], ["a facilities manager", fm]]) {
  (await holds(c, "vendors.recommend"))
    ? ok(`${label} holds vendors.recommend`)
    : bad(`${label} does not hold vendors.recommend`);
  (await holds(c, "vendors.approve"))
    ? bad(`${label} holds vendors.approve — the FM/PM decision was supposed to go`)
    : ok(`${label} does NOT hold vendors.approve — they recommend upward`);
}
for (const [label, c] of [["the regional manager", reg], ["the administrator", admin]]) {
  (await holds(c, "vendors.approve"))
    ? ok(`${label} holds vendors.approve`)
    : bad(`${label} does not hold vendors.approve`);
}

// ── B ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§B An application cannot skip the first review\x1b[0m");
const a1 = await newApp(`PROBE Vendor A ${S}`);
{
  const { error } = await reg.rpc("approve_vendor_application", { p_application_id: a1, p_notes: null });
  error && /not been recommended/.test(error.message)
    ? ok("the regional manager cannot approve one nobody has recommended")
    : bad(`approved without a recommendation, or wrong error: ${error?.message ?? "no error"}`);
}
{
  const { error } = await pm.rpc("approve_vendor_application", { p_application_id: a1, p_notes: null });
  error && /vendors\.approve/.test(error.message)
    ? ok("and a property manager is refused on the capability")
    : bad(`PM approval gave: ${error?.message ?? "NO ERROR — the PM approved a vendor"}`);
}

// ── C ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§C The recommendation itself\x1b[0m");
{
  const { error } = await pm.rpc("recommend_vendor_application", { p_application_id: a1, p_notes: "ok" });
  error && /say something/.test(error.message)
    ? ok("a recommendation of two characters is refused — no rubber stamps")
    : bad(`short reason gave: ${error?.message ?? "NO ERROR"}`);
}
{
  const { error } = await pm.rpc("recommend_vendor_application", {
    p_application_id: a1, p_notes: "CAC and TIN checked against the certificate supplied.",
  });
  error ? bad(`the PM could not recommend: ${error.message}`) : ok("the property manager recommends it");
}
{
  const st = await statusOf(a1);
  st.status === "under_review"
    ? ok("the application moves to under_review — a status nothing had ever set")
    : bad(`status is ${st.status}, expected under_review`);
  st.recommended_by ? ok("and records who put it forward") : bad("recommended_by is null");
}
{
  const { error } = await fm.rpc("recommend_vendor_application", {
    p_application_id: a1, p_notes: "Trying to recommend it a second time over.",
  });
  error && /already been recommended/.test(error.message)
    ? ok("it cannot be recommended twice")
    : bad(`second recommendation gave: ${error?.message ?? "NO ERROR"}`);
}

// ── D ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§D The second pair of hands\x1b[0m");
{
  const { data, error } = await reg.rpc("approve_vendor_application", {
    p_application_id: a1, p_notes: "Documents verified, references taken.",
  });
  if (error) bad(`the regional manager could not approve: ${error.message}`);
  else {
    ok("the regional manager approves what the PM recommended");
    const { data: v } = await svc.from("vendors").select("id, approval_status").eq("id", data).maybeSingle();
    v?.approval_status === "approved" ? ok("and the vendor record is created, approved") : bad("no vendor row");
    if (v) await svc.from("vendors").delete().eq("id", v.id);
  }
}

// ── E ──────────────────────────────────────────────────────────────────────
//
// The control that actually prevents one person admitting their own
// contractor. Per application, per person — not merely per role.
console.log("\n\x1b[1m§E The recommender may not decide their own\x1b[0m");
const a2 = await newApp(`PROBE Vendor B ${S}`);
{
  const { error } = await reg.rpc("recommend_vendor_application", {
    p_application_id: a2, p_notes: "Introduced by this region, papers look right.",
  });
  error ? bad(`the regional manager could not recommend: ${error.message}`)
        : ok("the regional manager recommends one themselves");
}
{
  const { error } = await reg.rpc("approve_vendor_application", { p_application_id: a2, p_notes: "Approving my own." });
  error && /may not also approve/.test(error.message)
    ? ok("and is then REFUSED their own approval — this is the whole control")
    : bad(`self-approval gave: ${error?.message ?? "NO ERROR — they approved their own recommendation"}`);
}
{
  const { error } = await reg.rpc("reject_vendor_application", { p_application_id: a2, p_notes: "Refusing my own." });
  error && /may not also refuse/.test(error.message)
    ? ok("nor their own refusal — refusing is a final decision too")
    : bad(`self-refusal gave: ${error?.message ?? "NO ERROR"}`);
}
{
  const { error } = await admin.rpc("approve_vendor_application", {
    p_application_id: a2, p_notes: "Second pair of hands, as the rule requires.",
  });
  if (error) bad(`the administrator could not approve: ${error.message}`);
  else {
    ok("the administrator can — a second person is the answer, not an exception");
    const { data: v } = await svc.from("vendors").select("id").eq("name", `PROBE Vendor B ${S}`).maybeSingle();
    if (v) await svc.from("vendors").delete().eq("id", v.id);
  }
}

// ── F ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§F B1 holds\x1b[0m");
if (tfmlReg) {
  const a3 = await newApp(`PROBE Vendor C ${S}`);
  const { error } = await tfmlReg.rpc("recommend_vendor_application", {
    p_application_id: a3, p_notes: "Reaching across the brand boundary on purpose.",
  });
  error && /another organisation/.test(error.message)
    ? ok("TFML cannot recommend an OEA application")
    : bad(`cross-brand recommend gave: ${error?.message ?? "NO ERROR"}`);
}

for (const id of made) await svc.from("vendor_applications").delete().eq("id", id);
console.log("\n(cleaned up)");

console.log(
  failures
    ? `\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m`
    : "\n\x1b[32m✔ vendor two-tier: all checks passed\x1b[0m"
);
process.exit(failures ? 1 : 0);
