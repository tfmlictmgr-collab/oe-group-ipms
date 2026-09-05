// The board's 29 July governance decision, enforced.
//
//   An executive (MD of TFML, Managing Partner of OEA) sees what finance sees and
//   co-holds payment approval — including above the threshold — and MUST NOT be
//   able to execute a remittance. Authorising and disbursing stay in different
//   hands, which is the whole point of the audit trail.
//
// The claims that matter:
//   • an executive can approve a payment, and one above the threshold
//   • an executive CANNOT move it to remitted — proven against the database, not
//     the UI, because that is where a bypass would be attempted
//   • an executive can read the ledger, the audit trail and the bank accounts
//   • an executive CANNOT write bank configuration, post to the ledger, or raise
//     the approval threshold they approve against
//   • a regional manager holds operational capabilities and nothing financial
//   • nobody else gained anything from the rewrite of 18 read policies
//
// Usage: node scripts/verify-oversight-roles.mjs
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

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const orgRes = await svc.from("orgs").select("id, name, slug, delivery_brand").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }

// ⚠️ By SLUG, which is the org's identifier, not by `delivery_brand === 'direct'`.
//
// Every user this suite signs in as is an `oe-group-foundation-poc.*` account, so
// the org has to be that exact one. 'direct' only means "no single brand delivers
// this" — it is equally true of the platform operator and of every independent
// client, so the old `.find()` returned whichever row came back first. Onboarding
// the service-charge client (0094) was enough to make it pick an org with no
// vendors, and the suite died on `vendor.id` of null midway through section C.
const poc = orgRes.data.find((o) => o.slug === "oe-group-foundation-poc");
if (!poc) {
  console.error("The Foundation POC org is missing — run npm run seed.");
  process.exit(1);
}

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeUsers = [];
const madePayments = [];

// Create an executive and a regional manager to test with.
async function makeUser(email, role) {
  const { data: created, error } = await svc.auth.admin.createUser({
    email, password: PW, email_confirm: true,
  });
  if (error) throw new Error(`${email}: ${error.message}`);
  await svc.from("users").upsert({
    id: created.user.id, org_id: poc.id, email, full_name: email.split("@")[0], role,
  });
  madeUsers.push(created.user.id);
  return created.user.id;
}
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

// Any probe account a previous crashed run left behind. A verification script
// that litters the database it measures eventually measures its own litter.
{
  const { data: stale } = await svc.from("users")
    .select("id, email").like("email", "probe.%@oegroup.test");
  for (const u of stale ?? []) {
    await svc.from("users").delete().eq("id", u.id);
    await svc.auth.admin.deleteUser(u.id).catch(() => {});
  }
  if ((stale ?? []).length) console.log(`(swept ${stale.length} stale probe account(s) from an earlier run)
`);
}

const execEmail = `probe.exec.${S}@oegroup.test`;
const rmEmail = `probe.rm.${S}@oegroup.test`;
await makeUser(execEmail, "executive");
await makeUser(rmEmail, "regional_manager");

console.log("Oversight and regional roles\n");

console.log("A. An executive sees what finance sees");
{
  const c = await login(execEmail);
  for (const [table, label] of [
    ["ledger_entries", "the client-funds ledger"],
    ["audit_log", "the audit trail"],
    ["bank_accounts", "bank accounts"],
    ["reconciliations", "reconciliations"],
    ["remittances", "remittances"],
    ["payments", "payments"],
  ]) {
    const { error } = await c.from(table).select("id").limit(1);
    !error ? ok(`reads ${label}`) : bad(`CANNOT read ${label} — ${error.message.slice(0, 50)}`);
  }
  await c.auth.signOut();
}

console.log("\nB. …and cannot write what oversight must not write");
{
  const c = await login(execEmail);

  const bank = await c.from("bank_accounts").insert({
    org_id: poc.id, bank_name: `PROBE-${S}`, account_number: "0000000000",
    account_name: "Probe", purpose: "client_funds",
  });
  bank.error ? ok("cannot add a bank account — configuration stays with an administrator")
             : bad("AN EXECUTIVE WROTE BANK CONFIGURATION");

  const thr = await c.from("payment_settings")
    .update({ approval_threshold_amount: 999_999_999 }).eq("org_id", poc.id).select("org_id");
  (thr.error || (thr.data ?? []).length === 0)
    ? ok("cannot raise the threshold they approve against")
    : bad("AN EXECUTIVE RAISED THEIR OWN APPROVAL THRESHOLD");

  const led = await c.from("ledger_entries").insert({
    org_id: poc.id, entry_type: "collection", description: `PROBE-${S}`, occurred_at: new Date().toISOString(),
  });
  led.error ? ok("cannot post to the ledger by hand")
            : bad("AN EXECUTIVE POSTED A LEDGER ENTRY");

  await c.auth.signOut();
}

console.log("\nC. Payment approval — the co-held function");
{
  const { data: settings } = await svc.from("payment_settings")
    .select("approval_threshold_amount").eq("org_id", poc.id).maybeSingle();
  const threshold = Number(settings?.approval_threshold_amount ?? 1_000_000);
  const { data: vendor } = await svc.from("vendors").select("id").eq("org_id", poc.id).limit(1).single();

  const mkPayment = async (amount) => {
    const { data, error } = await svc.from("payments").insert({
      org_id: poc.id, vendor_id: vendor.id, amount,
      invoice_reference: `PROBE-${S}-${amount}`, status: "recommended",
      service_verified_at: new Date().toISOString(), performance_validated: true,
    }).select("id").single();
    if (error) throw new Error(error.message);
    madePayments.push(data.id);
    return data.id;
  };

  const small = await mkPayment(threshold / 2);
  const large = await mkPayment(threshold * 2);

  const c = await login(execEmail);

  // ⚠️ REWRITTEN FOR THE APPROVAL CHAIN (0151). The claim is unchanged — an
  // executive approves below the threshold AND above it, decision 9 — but
  // approval is no longer a status a role may set. It is stage 3 of a chain,
  // so the executive now proves the same thing through the path that actually
  // exists, with their own session. Stages 1–2 are fixtures, recorded by
  // service role as two other people so separation of duties is satisfied
  // rather than dodged.
  const preStages = async (paymentId) => {
    const pick = async (role) => (await svc.from("users").select("id")
      .eq("org_id", poc.id).eq("role", role).is("deactivated_at", null)
      .limit(1).maybeSingle()).data?.id;
    const fm = await pick("facility_manager");
    const auditor = await pick("payment_audit_approver");
    if (!fm || !auditor) return false;
    for (const [stage, actor] of [[1, fm], [2, auditor]]) {
      const { error } = await svc.from("payment_approvals").insert({
        org_id: poc.id, payable_type: "vendor_payment", payable_id: paymentId,
        stage_order: stage, actor_id: actor,
        actor_role: "viewer", actor_tier: null, amount: 1, decision: "approved",
      });
      if (error) return false;
    }
    return true;
  };

  const stagedSmall = await preStages(small);
  const stagedLarge = await preStages(large);

  const a1 = stagedSmall
    ? await c.rpc("record_payment_approval", {
        p_payable_type: "vendor_payment", p_payable_id: small,
        p_stage: 3, p_decision: "approved", p_reason: null })
    : { error: { message: "could not stage the earlier approvals" } };
  !a1.error
    ? ok("approves a payment below the threshold")
    : bad(`could not approve — ${a1.error?.message.slice(0, 70)}`);

  const a2 = stagedLarge
    ? await c.rpc("record_payment_approval", {
        p_payable_type: "vendor_payment", p_payable_id: large,
        p_stage: 3, p_decision: "approved", p_reason: null })
    : { error: { message: "could not stage the earlier approvals" } };
  !a2.error
    ? ok("and one ABOVE it — escalation reaches a principal, which is what it is for")
    : bad(`could not approve above threshold — ${a2.error?.message.slice(0, 70)}`);

  await c.auth.signOut();
}

console.log("\nD. …and remittance execution is refused — the board's explicit call");
{
  const c = await login(execEmail);
  const { error, data } = await c.from("payments")
    .update({ status: "remitted" }).eq("id", madePayments[0]).select("id");

  (error || (data ?? []).length === 0)
    ? ok(`an executive cannot move money: "${(error?.message ?? "refused").slice(0, 58)}"`)
    : bad("AN EXECUTIVE EXECUTED A REMITTANCE — separation of duties is broken");
  await c.auth.signOut();

  // And finance still can, so the gate was narrowed rather than jammed shut.
  const f = await login("oe-group-foundation-poc.financeapprover@oegroup.test");
  const { error: fe, data: fd } = await f.from("payments")
    .update({ status: "remitted" }).eq("id", madePayments[0]).select("id");
  (!fe && (fd ?? []).length === 1)
    ? ok("and finance still can — the gate was narrowed, not jammed")
    : bad(`finance can no longer remit — ${fe?.message.slice(0, 60) ?? "no row"}`);
  await f.auth.signOut();
}

console.log("\nE. A regional manager is operational, never financial");
{
  const c = await login(rmEmail);
  const holds = {};
  for (const cap of ["tickets.assign", "tickets.close", "properties.write",
                     "units.assign_occupant", "people.invite", "assets.write",
                     "sc.manage", "sc.read_all", "tickets.read_all"]) {
    const { data } = await c.rpc("has_permission", { p_capability: cap });
    holds[cap] = data;
  }
  holds["tickets.assign"] && holds["people.invite"] && holds["properties.write"]
    ? ok("holds the operational capabilities, including inviting staff for their region")
    : bad(`missing operational capabilities: ${JSON.stringify(holds)}`);
  !holds["sc.manage"] && !holds["sc.read_all"]
    ? ok("holds nothing financial")
    : bad("A REGIONAL MANAGER HOLDS A FINANCIAL CAPABILITY");
  !holds["tickets.read_all"]
    ? ok("and no org-wide read — they are bounded to their own region")
    : bad("A REGIONAL MANAGER READS THE WHOLE ORGANISATION");

  const led = await c.from("ledger_entries").select("id").limit(1);
  (led.error || (led.data ?? []).length === 0)
    ? ok("cannot read the client-funds ledger")
    : bad("A REGIONAL MANAGER READ THE LEDGER");
  await c.auth.signOut();
}

console.log("\nF. The 18 rewritten read policies gave nobody else anything");
{
  for (const [email, label] of [
    ["oe-group-foundation-poc.tenant@oegroup.test", "a tenant"],
    ["oe-group-foundation-poc.vendor@oegroup.test", "a vendor"],
    ["oe-group-foundation-poc.facilitymanager@oegroup.test", "a facility manager"],
  ]) {
    const c = await login(email);
    const { data: me } = await c.auth.getUser();

    const led = await c.from("ledger_entries").select("id").limit(1);
    (led.error || (led.data ?? []).length === 0)
      ? ok(`${label} still cannot read the client-funds ledger`)
      : bad(`${label.toUpperCase()} GAINED THE LEDGER`);

    // The audit trail is NOT all-or-nothing. `audit_log_select` has always
    // admitted `actor_id = auth.uid()` — B7 gives an FM "Own scope" on the audit
    // trail, and a tenant their own actions. So the claim worth testing is not
    // "sees nothing", it is "sees nothing that is not theirs". Asserting the
    // blunter thing reported a leak that was B7 working correctly.
    const aud = await c.from("audit_log").select("id, actor_id").limit(200);
    const foreign = (aud.data ?? []).filter((r) => r.actor_id !== me?.user?.id);
    foreign.length === 0
      ? ok(`${label} sees only their own audit entries (${(aud.data ?? []).length}), never anyone else's`)
      : bad(`${label.toUpperCase()} READ ${foreign.length} AUDIT ENTRIES THAT ARE NOT THEIRS`);
    await c.auth.signOut();
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("payments").delete().in("id", madePayments);
for (const id of madeUsers) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id);
}
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — an executive authorises and oversees; finance disburses."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
