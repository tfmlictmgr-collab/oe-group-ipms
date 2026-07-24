// Proves migration 0010: the payment gate is enforced by the DATABASE, not just
// by the server actions. Signs in as real users (anon key + password) and issues
// direct PostgREST PATCHes — exactly the bypass an authenticated staff member
// could attempt with a fetch call, skipping the UI entirely.
//
// Every case here MUST be rejected. A "PASS" means the database refused.
// Usage: node scripts/verify-payment-gate.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

async function asUser(email) {
  const c = createClient(URL, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

// Asserts the PATCH was refused. PostgREST surfaces a trigger `raise exception`
// as an error; RLS refusal instead reports zero rows affected — both are a
// successful block, so we treat "no error AND row changed" as the only failure.
async function mustReject(client, id, patch, label) {
  const { data, error } = await client
    .from("payments").update(patch).eq("id", id).select("id, status");
  if (error) return ok(`${label} → blocked (${error.message.split("\n")[0].slice(0, 80)})`);
  if (!data || data.length === 0) return ok(`${label} → blocked (no rows / RLS)`);
  bad(`${label} → ALLOWED, status is now "${data[0].status}"`);
}

const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });

console.log("Direct-PATCH bypass attempts against the payment gate (0010)\n");

// A payment still at the very first stage: nothing verified, nothing validated.
const { data: fresh } = await svc
  .from("payments").select("id, status, amount")
  .eq("status", "pending_verification").limit(1).single();

if (!fresh) {
  console.log("No pending_verification payment in the DB — run `npm run seed` first.");
  process.exit(1);
}
console.log(`Target: payment ${fresh.id.slice(0, 8)} (status=${fresh.status}, ₦${Number(fresh.amount).toLocaleString()})\n`);

const finance = await asUser("finance@oegroup.test");
const fm = await asUser("fm@oegroup.test");

console.log("A. ILLEGAL TRANSITIONS — skipping stages of the B4 gate");
await mustReject(finance, fresh.id, { status: "approved" }, "finance: pending_verification → approved");
await mustReject(finance, fresh.id, { status: "remitted" }, "finance: pending_verification → remitted");
await mustReject(finance, fresh.id, { status: "recommended" }, "finance: pending_verification → recommended");

console.log("\nB. FORGED GATE FLAGS — self-certifying the gate in the same PATCH");
await mustReject(
  finance, fresh.id,
  { status: "approved", performance_validated: true, service_verified_at: new Date().toISOString() },
  "finance: forge both gate flags + approve"
);

console.log("\nC. ROLE ENFORCEMENT — non-finance attempting a money move");
await mustReject(fm, fresh.id, { status: "approved" }, "facility_manager: → approved");
await mustReject(fm, fresh.id, { status: "remitted" }, "facility_manager: → remitted");

// The payment must be exactly as we found it.
const { data: after } = await svc
  .from("payments").select("status, performance_validated, service_verified_at, approved_at")
  .eq("id", fresh.id).single();

console.log("\nD. POST-STATE — the target payment is unchanged");
if (after.status === fresh.status) ok(`status still "${after.status}"`);
else bad(`status drifted to "${after.status}"`);
if (after.performance_validated !== true) ok("performance_validated not forged");
else bad("performance_validated was set to true");
if (!after.approved_at) ok("approved_at still null");
else bad(`approved_at was set to ${after.approved_at}`);

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the gate holds against direct API calls."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m — the gate is bypassable.`
);
process.exit(failures === 0 ? 0 : 1);
