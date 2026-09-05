// The approval limit is the operator's to set, not the organisation's (0149).
//
// ⚠️ Why this suite exists. Decision 16 stopped an administrator approving a
// payment and then releasing it. It did not stop the administrator RAISING the
// limit that decides whether the payment needed anyone else's approval at all.
// Those are the same concentration: an admin meeting a payment above the
// threshold could edit the threshold, then approve alone, and every step was
// legal. `enforce_payment_transition` reads `approval_threshold_amount` to make
// that decision, so whoever writes that column governs the escalation.
//
// Verified by ATTEMPTING each write with a real signed-in session, never by
// reading a policy or a grant table — reading grants is what produced the "68
// tables writable by anon" false alarm on this project.
//
// Usage: node scripts/verify-payment-gate-authority.mjs
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "ProbePassw0rd!";

if (!URL_ || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
if (/prod/i.test(URL_)) {
  console.error("Refusing to run: target looks like production. This writes fixture rows.");
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const { data: orgs, error: orgErr } = await svc
  .from("orgs").select("id, slug, is_platform_operator").is("deleted_at", null);
if (orgErr) { console.error("db unreachable:", orgErr.message); process.exit(1); }

const brand = orgs.find((o) => o.slug === "oe-group-foundation-poc");
const operator = orgs.find((o) => o.is_platform_operator);
if (!brand || !operator) {
  console.error("Need the POC org and the platform operator org seeded.");
  process.exit(2);
}

const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = [];

// Start-of-run sweep. End-of-run cleanup cannot repair end-of-run cleanup —
// an earlier failure throws before it is ever reached (the verify-application-
// review lesson).
{
  const { data: stale } = await svc.from("users").select("id").like("email", "probegate.%@oegroup.test");
  for (const u of stale ?? []) {
    await svc.from("users").delete().eq("id", u.id);
    await svc.auth.admin.deleteUser(u.id).catch(() => {});
  }
  await svc.from("operator_actions").delete().like("reason", "PROBE 0149%");
}

async function makeUser(orgId, role, tag) {
  const email = `probegate.${tag}.${S}@oegroup.test`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message}`);
  await svc.from("users").upsert({
    id: created.user.id, org_id: orgId, email, full_name: `Probe ${tag}`, role,
  });
  made.push(created.user.id);
  return { id: created.user.id, email };
}

// The settings row must exist before an UPDATE can be attempted against it.
await svc.from("payment_settings").upsert({
  org_id: brand.id,
  approval_threshold_amount: 1000000,
  min_performance_score: 70,
  updated_at: new Date().toISOString(),
});

const readGate = async () => {
  const { data } = await svc.from("payment_settings")
    .select("approval_threshold_amount, min_performance_score, admin_fee_percent")
    .eq("org_id", brand.id).single();
  return data;
};

const brandAdmin = await makeUser(brand.id, "admin", "brandadmin");
const brandFinance = await makeUser(brand.id, "finance_approver", "brandfinance");
const operatorAdmin = await makeUser(operator.id, "admin", "opadmin");

console.log("\nPayment gate authority (0149)\n");

// ---------------------------------------------------------------------------
console.log("A. A brand administrator cannot move the limit they approve against");
// ---------------------------------------------------------------------------
{
  const c = await login(brandAdmin.email);
  const before = await readGate();

  const { error } = await c.from("payment_settings")
    .update({ approval_threshold_amount: 10000000 })
    .eq("org_id", brand.id);
  error
    ? ok(`refused raising the approval limit — ${error.message.slice(0, 72)}`)
    : bad("AN ADMINISTRATOR RAISED THEIR OWN APPROVAL LIMIT");

  const after = await readGate();
  Number(after.approval_threshold_amount) === Number(before.approval_threshold_amount)
    ? ok("the stored limit is unchanged")
    : bad(`the limit moved: ${before.approval_threshold_amount} -> ${after.approval_threshold_amount}`);

  const { error: e2 } = await c.from("payment_settings")
    .update({ min_performance_score: 5 })
    .eq("org_id", brand.id);
  e2 ? ok("refused lowering the KPI gate") : bad("AN ADMINISTRATOR LOWERED THE PERFORMANCE GATE");

  // Both at once — a change that hides one control column behind another.
  const { error: e3 } = await c.from("payment_settings")
    .update({ approval_threshold_amount: 9999999, min_performance_score: 1 })
    .eq("org_id", brand.id);
  e3 ? ok("refused both together") : bad("BOTH CONTROLS CHANGED IN ONE WRITE");
}

// ---------------------------------------------------------------------------
console.log("\nB. …but the fee columns are still theirs (decision 14)");
// ---------------------------------------------------------------------------
{
  const c = await login(brandAdmin.email);
  const { error } = await c.from("payment_settings")
    .update({ admin_fee_percent: 3.5 })
    .eq("org_id", brand.id);
  error
    ? bad(`an administrator was blocked from a FEE they negotiate — ${error.message.slice(0, 60)}`)
    : ok("the admin fee is still the organisation's to set");

  const after = await readGate();
  Number(after.admin_fee_percent) === 3.5
    ? ok("and the fee change actually landed")
    : bad(`fee did not persist: ${after.admin_fee_percent}`);
}

// ---------------------------------------------------------------------------
console.log("\nC. Nobody below an administrator gets there either");
// ---------------------------------------------------------------------------
{
  const c = await login(brandFinance.email);

  // ⚠️ Assert on the STORED VALUE, not on the error. `payment_settings_write`
  // filters finance out at the RLS layer, so their UPDATE matches zero rows and
  // returns SUCCESS — no error, nothing changed. An earlier version of this
  // check read that success as "finance raised the limit" and reported a
  // failure that was not real. A refused write and a write that hit nothing
  // look identical from the client; only the data distinguishes them.
  const before = await readGate();
  await c.from("payment_settings")
    .update({ approval_threshold_amount: 10000000 })
    .eq("org_id", brand.id);
  const after = await readGate();
  Number(after.approval_threshold_amount) === Number(before.approval_threshold_amount)
    ? ok("finance did not move the approval limit")
    : bad(`FINANCE RAISED THE APPROVAL LIMIT to ${after.approval_threshold_amount}`);

  const { error: e2 } = await c.rpc("operator_set_payment_gate", {
    p_org_id: brand.id, p_threshold: 10000000, p_min_score: 70,
    p_reason: "PROBE 0149 finance should not reach this",
  });
  e2 ? ok("finance refused the operator function") : bad("FINANCE CALLED THE OPERATOR FUNCTION");
}

// ---------------------------------------------------------------------------
console.log("\nD. The brand administrator cannot use the operator's own door");
// ---------------------------------------------------------------------------
{
  const c = await login(brandAdmin.email);
  const { error } = await c.rpc("operator_set_payment_gate", {
    p_org_id: brand.id, p_threshold: 50000000, p_min_score: 70,
    p_reason: "PROBE 0149 brand admin attempting the crossing",
  });
  error
    ? ok(`refused — ${error.message.slice(0, 72)}`)
    : bad("A BRAND ADMINISTRATOR SET ITS OWN GATE THROUGH THE OPERATOR FUNCTION");
}

// ---------------------------------------------------------------------------
console.log("\nE. The operator can, and it is recorded");
// ---------------------------------------------------------------------------
{
  const c = await login(operatorAdmin.email);

  const { error: eNoReason } = await c.rpc("operator_set_payment_gate", {
    p_org_id: brand.id, p_threshold: 2500000, p_min_score: 75, p_reason: "too short",
  });
  eNoReason ? ok("refused a change with no stated reason") : bad("AN UNEXPLAINED LIMIT CHANGE WAS ACCEPTED");

  const { error: eZero } = await c.rpc("operator_set_payment_gate", {
    p_org_id: brand.id, p_threshold: 0, p_min_score: 75,
    p_reason: "PROBE 0149 zero threshold should be refused",
  });
  eZero ? ok("refused a zero approval limit") : bad("A ZERO APPROVAL LIMIT WAS ACCEPTED");

  const { error } = await c.rpc("operator_set_payment_gate", {
    p_org_id: brand.id, p_threshold: 2500000, p_min_score: 75,
    p_reason: "PROBE 0149 board raised the TFML limit for Q3 capital works",
  });
  error ? bad(`the operator was refused — ${error.message.slice(0, 72)}`) : ok("the operator set the gate");

  const after = await readGate();
  Number(after.approval_threshold_amount) === 2500000 && Number(after.min_performance_score) === 75
    ? ok("both control values landed")
    : bad(`stored ${after.approval_threshold_amount} / ${after.min_performance_score}`);

  const { data: act } = await svc.from("operator_actions")
    .select("action, target_org, reason, metadata, actor_id")
    .eq("action", "set_payment_gate").eq("target_org", brand.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();

  act ? ok("an operator_actions row was written") : bad("NO OPERATOR ACTION RECORDED");
  act?.actor_id === operatorAdmin.id
    ? ok("attributed to the operator administrator who did it")
    : bad(`actor_id is ${act?.actor_id ?? "null"}`);
  Number(act?.metadata?.approval_threshold_before) === 1000000 &&
  Number(act?.metadata?.approval_threshold_after) === 2500000
    ? ok("with the before and after both on the record")
    : bad(`metadata is ${JSON.stringify(act?.metadata)}`);
}

// ---------------------------------------------------------------------------
console.log("\nF. The organisation can see what was done to it (0079's rule)");
// ---------------------------------------------------------------------------
{
  const c = await login(brandAdmin.email);
  const { data } = await c.from("operator_actions")
    .select("action, reason").eq("action", "set_payment_gate").eq("target_org", brand.id);
  (data?.length ?? 0) > 0
    ? ok("the affected organisation reads the operator's action against it")
    : bad("THE ORGANISATION CANNOT SEE ITS OWN GATE BEING CHANGED");
}

// ---------------------------------------------------------------------------
// Restore the gate and tear down.
// ---------------------------------------------------------------------------
await svc.from("payment_settings").update({
  approval_threshold_amount: 1000000, min_performance_score: 70, admin_fee_percent: 0,
}).eq("org_id", brand.id);
await svc.from("operator_actions").delete().like("reason", "PROBE 0149%");
for (const id of made) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id).catch(() => {});
}

console.log(failures === 0
  ? "\n\x1b[32mAll payment gate authority checks passed.\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
