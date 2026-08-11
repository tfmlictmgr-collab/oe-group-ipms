// Proves the channel-consent record and its gate (0148).
//
// The properties under test, in the order they matter:
//   1. Consent is a RECORD, not a flag — a grant carries its wording and a
//      timestamp, and a withdrawal is a NEW ROW rather than an edit.
//   2. The gate reads the LATEST row, so a withdrawal takes effect immediately.
//   3. Consent is identifier-bound — it does not carry to a different number.
//   4. It fails CLOSED: no record at all means no send.
//   5. The table is not readable or writable by a client role, and
//      `has_channel_consent` is not callable by one.
//
// (5) is the one that would be easy to regress and hard to notice: the whole
// point of a consent record is that it cannot be forged by the person it
// governs or read by anyone else in the org.
//
// Usage: node scripts/verify-channel-consent.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.");
  process.exit(1);
}

const svc = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

console.log("Channel consent — record, gate, and isolation (0148)\n");

// A real user to hang the records off. Read-only: nothing here modifies them.
const { data: subject } = await svc
  .from("users")
  .select("id, org_id")
  .is("deactivated_at", null)
  .limit(1)
  .maybeSingle();

if (!subject) {
  console.error("No active user found to test against. Seed a dev database first.");
  process.exit(1);
}

const CHANNEL = "whatsapp";
const NUMBER = "2348000000001";
const OTHER_NUMBER = "2348000000002";
const STATEMENT = "TEST — I agree to receive service messages on WhatsApp.";

// Everything this run writes, so it can be removed again. `channel_consents`
// has no DELETE policy for any client role by design; the service role bypasses
// RLS, which is the only way this cleanup can work — and is itself part of what
// the isolation checks below assert.
const written = [];

async function grant(identifier) {
  const { data, error } = await svc
    .from("channel_consents")
    .insert({
      org_id: subject.org_id, user_id: subject.id, channel: CHANNEL,
      action: "granted", statement: STATEMENT, channel_identifier: identifier,
      recorded_via: "import",
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not seed a grant: ${error.message}`);
  written.push(data.id);
  return data.id;
}

async function withdraw() {
  const { data, error } = await svc
    .from("channel_consents")
    .insert({
      org_id: subject.org_id, user_id: subject.id, channel: CHANNEL,
      action: "withdrawn", recorded_via: "import",
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not seed a withdrawal: ${error.message}`);
  written.push(data.id);
  return data.id;
}

const gate = async (identifier) => {
  const { data, error } = await svc.rpc("has_channel_consent", {
    p_user_id: subject.id, p_channel: CHANNEL, p_identifier: identifier,
  });
  if (error) throw new Error(`gate errored: ${error.message}`);
  return data === true;
};

try {
  // ── 4. Fails closed when there is no record ──────────────────────────────
  // Checked FIRST, before anything is written, because it is the only moment
  // this user is guaranteed to have no history.
  const { count: preexisting } = await svc
    .from("channel_consents")
    .select("id", { count: "exact", head: true })
    .eq("user_id", subject.id)
    .eq("channel", CHANNEL);

  if (preexisting === 0) {
    (await gate(NUMBER))
      ? bad("no consent on record, but the gate allowed the send")
      : ok("no record at all → refused (fails closed)");
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m the subject already has ${preexisting} consent row(s); cannot test the empty case`);
  }

  // ── 1 & 2. A grant permits; a later withdrawal revokes ───────────────────
  await grant(NUMBER);
  (await gate(NUMBER))
    ? ok("a recorded grant → allowed")
    : bad("a recorded grant was not honoured");

  // ── 3. Identifier-bound ──────────────────────────────────────────────────
  // Consent for one number must not carry to another: numbers get recycled, and
  // a message to a reassigned number discloses the previous holder's business.
  (await gate(OTHER_NUMBER))
    ? bad("consent recorded for one number was honoured for a DIFFERENT number")
    : ok("consent does not carry to a different number");

  await withdraw();
  (await gate(NUMBER))
    ? bad("a withdrawal did not take effect — the gate still allows the send")
    : ok("a later withdrawal → refused");

  // The grant must still be there. A withdrawal that erased it would destroy
  // the evidence of what was permitted on the day something was sent.
  {
    const { data: rows } = await svc
      .from("channel_consents")
      .select("action, statement")
      .eq("user_id", subject.id)
      .eq("channel", CHANNEL)
      .order("recorded_at", { ascending: false });
    const grants = (rows ?? []).filter((r) => r.action === "granted");
    grants.length > 0
      ? ok("the original grant survives the withdrawal (append-only)")
      : bad("withdrawing destroyed the grant — the audit history is gone");
    grants.every((r) => r.statement && r.statement.trim().length > 0)
      ? ok("every grant carries the wording that was shown")
      : bad("a grant exists with no statement — that is a tick box, not consent");
  }

  // ── 5. Isolation ─────────────────────────────────────────────────────────
  // An anonymous caller holding the public key is what an attacker actually
  // has. Test by doing it, per verify-security-posture's own lesson: read the
  // behaviour, not the grant tables.
  {
    const { data, error } = await anon.from("channel_consents").select("id").limit(1);
    (error || (data ?? []).length === 0)
      ? ok("anon reads no consent rows")
      : bad(`anon read ${data.length} consent row(s)`);
  }
  {
    const { error } = await anon.from("channel_consents").insert({
      org_id: subject.org_id, user_id: subject.id, channel: CHANNEL,
      action: "granted", statement: "forged",
    });
    error
      ? ok("anon cannot forge a consent record")
      : bad("anon INSERTED a consent record — consent can be forged");
  }
  {
    const { error } = await anon
      .from("channel_consents")
      .delete()
      .eq("user_id", subject.id);
    // A refusal OR zero rows affected both satisfy this; what must not happen
    // is rows actually disappearing.
    const { count } = await svc
      .from("channel_consents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", subject.id);
    count > 0
      ? ok(`anon cannot delete consent history (${count} row(s) intact)${error ? "" : " — refused silently"}`)
      : bad("consent history was deleted by an anonymous caller");
  }
  {
    const { error } = await anon.rpc("has_channel_consent", {
      p_user_id: subject.id, p_channel: CHANNEL, p_identifier: NUMBER,
    });
    error
      ? ok("anon cannot call has_channel_consent (no probing who is contactable)")
      : bad("anon executed has_channel_consent — anyone can probe contactability");
  }
} catch (e) {
  bad(e instanceof Error ? e.message : String(e));
} finally {
  if (written.length > 0) {
    await svc.from("channel_consents").delete().in("id", written);
    console.log(`\n  cleaned up ${written.length} test row(s)`);
  }
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll consent checks passed.\x1b[0m"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
