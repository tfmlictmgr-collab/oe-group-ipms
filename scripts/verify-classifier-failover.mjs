// Classifier failover and conversation memory (0113 + lib/llm.ts).
//
// ⚠️ The hard part of testing a failover is that it only matters during an
// outage, and you cannot have one on demand. So the providers are INJECTABLE
// (`completeWithFailover(req, parse, providers)`), and this suite passes in
// deliberately-failing ones. That tests the actual shipped failover logic —
// not a copy of it, and not a mock of the thing under test — and it runs
// with no GEMINI_API_KEY, which is the state the project is in today.
//
// Section F is the one that matters most: it proves the suite would CATCH a
// broken failover, by removing the fallback and confirming the result changes.
// A green failover test that stays green when failover is deleted is worth
// nothing.
//
// Usage: node scripts/verify-classifier-failover.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const { completeWithFailover, llmProviderStatus } = await import("../lib/llm.ts");

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const REQ = { system: "s", user: "u", maxTokens: 10 };
const parseJson = (t) => { try { const p = JSON.parse(t); return p?.ok ? p : null; } catch { return null; } };

/** A provider that behaves however the test needs it to. */
const stub = (name, behaviour) => ({
  name,
  configured: () => behaviour !== "unconfigured",
  complete: async () => {
    if (behaviour === "down") return { ok: false, provider: name, error: "simulated outage" };
    if (behaviour === "garbage") return { ok: true, text: "I'm sorry, I can't help with that.", provider: name };
    if (behaviour === "unconfigured") return { ok: false, provider: name, error: "not configured" };
    return { ok: true, text: JSON.stringify({ ok: true, by: name }), provider: name };
  },
});

const MARK = "PROBEFAILOVER";
const made = [];

console.log("Classifier failover and conversation memory\n");

console.log("A. The primary answers, and the fallback is never consulted");
{
  let fallbackCalls = 0;
  const countingFallback = {
    ...stub("gemini", "up"),
    complete: async () => { fallbackCalls++; return { ok: true, text: '{"ok":true,"by":"gemini"}', provider: "gemini" }; },
  };
  const r = await completeWithFailover(REQ, parseJson, [stub("anthropic", "up"), countingFallback]);
  r.provider === "anthropic" && r.value?.by === "anthropic"
    ? ok("the primary's answer is used")
    : bad(`expected anthropic, got ${r.provider}`);
  fallbackCalls === 0
    ? ok("and the fallback was not called at all — no double spend on a healthy path")
    : bad(`the fallback was called ${fallbackCalls} time(s) despite the primary succeeding`);
}

console.log("\nB. The primary is down — the fallback answers");
{
  const r = await completeWithFailover(REQ, parseJson, [stub("anthropic", "down"), stub("gemini", "up")]);
  r.provider === "gemini" && r.value?.by === "gemini"
    ? ok("an outage on the primary is answered by Gemini, not degraded to human review")
    : bad(`expected gemini to answer, got provider=${r.provider} value=${JSON.stringify(r.value)}`);
}

console.log("\nC. A 200 carrying unusable content counts as a failure");
{
  // The subtle one. An overloaded model answering with prose instead of JSON
  // used to be accepted as an answer, because the parse failure returned a
  // DEFAULT rather than null — so the fallback was never asked.
  const r = await completeWithFailover(REQ, parseJson, [stub("anthropic", "garbage"), stub("gemini", "up")]);
  r.provider === "gemini"
    ? ok("prose instead of JSON fails over rather than being accepted as a classification")
    : bad(`unusable content from the primary was accepted: provider=${r.provider}`);
}

console.log("\nD. Both unavailable — the safe default, and it is recorded as such");
{
  const r = await completeWithFailover(REQ, parseJson, [stub("anthropic", "down"), stub("gemini", "down")]);
  r.value === null && r.provider === "none"
    ? ok("returns null/none so the caller applies its own safe default — intake never breaks")
    : bad(`expected null/none, got ${JSON.stringify(r)}`);
}

console.log("\nE. An unconfigured fallback is skipped, not treated as an error");
{
  // Today's actual state: no GEMINI_API_KEY. Behaviour must be exactly what it
  // was before failover existed.
  const r = await completeWithFailover(REQ, parseJson, [stub("anthropic", "up"), stub("gemini", "unconfigured")]);
  r.provider === "anthropic"
    ? ok("with no fallback key, the primary still answers normally")
    : bad(`unconfigured fallback disturbed the healthy path: ${r.provider}`);

  const r2 = await completeWithFailover(REQ, parseJson, [stub("anthropic", "down"), stub("gemini", "unconfigured")]);
  r2.provider === "none" && r2.value === null
    ? ok("and with the primary down too, it degrades exactly as it did before — no crash")
    : bad(`expected none, got ${JSON.stringify(r2)}`);

  const status = llmProviderStatus();
  typeof status.primary === "boolean" && typeof status.fallback === "boolean"
    ? ok(`llmProviderStatus reports primary=${status.primary} fallback=${status.fallback} — the key state is inspectable`)
    : bad("llmProviderStatus did not report a usable shape");
}

console.log("\nF. THE CONTROL — would this suite notice if failover were removed?");
{
  // Same outage as section B, but with only the primary in the list: this is
  // what the code did BEFORE failover existed. If this still produced an
  // answer, sections B and C would be proving nothing.
  const r = await completeWithFailover(REQ, parseJson, [stub("anthropic", "down")]);
  r.provider === "none" && r.value === null
    ? ok("without a fallback the same outage yields nothing — so B and C are real tests")
    : bad("REMOVING THE FALLBACK CHANGED NOTHING — this suite does not test failover");
}

console.log("\nG. The conversation memory the router reads");
{
  const { data: poc } = await svc.from("orgs").select("id").eq("slug", "oe-group-foundation-poc").single();
  const { data: tenant } = await svc.from("users").select("id")
    .eq("email", "oe-group-foundation-poc.tenant@oegroup.test").single();

  const { data: t } = await svc.from("tickets").insert({
    org_id: poc.id, channel: "whatsapp", channel_sender_ref: `234700${MARK}`,
    message_text: `${MARK} the kitchen tap drips`, category: "maintenance",
    urgency: "normal", status: "open", sender_id: tenant.id,
  }).select("id").single();
  made.push(t.id);

  // A real exchange, in order.
  for (const [author, body] of [
    ["reporter", `${MARK} the kitchen tap drips`],
    ["system", "Logged as reference ABC12345."],
    ["reporter", "it is worse now, water on the floor"],
    ["staff", "A plumber is booked for tomorrow morning."],
  ]) {
    await svc.from("ticket_messages").insert({
      org_id: poc.id, ticket_id: t.id, author, body,
      ...(author === "staff" ? { author_id: tenant.id } : {}),
    });
  }

  const { data: rows, error } = await svc.rpc("conversation_transcript", { p_ticket_id: t.id, p_limit: 8 });
  if (error) bad(`conversation_transcript failed: ${error.message}`);
  (rows ?? []).length === 4
    ? ok("returns the whole exchange, not just the opening message")
    : bad(`expected 4 messages, got ${(rows ?? []).length}`);

  const bodies = (rows ?? []).map((r) => r.body);
  bodies[0]?.includes("drips") && bodies[bodies.length - 1]?.includes("plumber")
    ? ok("oldest first — the model reads them in the order they were said")
    : bad(`wrong order: ${JSON.stringify(bodies)}`);

  (rows ?? []).some((r) => r.author === "staff") && (rows ?? []).some((r) => r.author === "reporter")
    ? ok("and each turn says who spoke — our own reply cannot be misread as the tenant's words")
    : bad("author labels missing — the model cannot tell the two sides apart");

  // Bounded, so a long thread cannot grow the prompt without limit.
  const { data: capped } = await svc.rpc("conversation_transcript", { p_ticket_id: t.id, p_limit: 2 });
  (capped ?? []).length === 2 && capped[capped.length - 1].body.includes("plumber")
    ? ok("bounded to the most recent turns — a long thread cannot grow the prompt without limit")
    : bad(`limit not honoured: ${(capped ?? []).length}`);
}

console.log("\nH. The transcript is not reachable from a client session");
{
  // SECURITY DEFINER over a caller-supplied ticket id. If `authenticated`
  // could call it, any signed-in user could read any ticket's conversation by
  // passing its id — the exact shape of the storage-RLS finding in audit 0805.
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error: anonErr } = await anon.rpc("conversation_transcript", { p_ticket_id: made[0], p_limit: 8 });
  anonErr
    ? ok("an anonymous caller is refused")
    : bad("!!! conversation_transcript IS CALLABLE ANONYMOUSLY");

  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  await c.auth.signInWithPassword({
    email: "oe-group-foundation-poc.tenant@oegroup.test", password: "OEGroupDemo2026!",
  });
  const { error: authErr } = await c.rpc("conversation_transcript", { p_ticket_id: made[0], p_limit: 8 });
  authErr
    ? ok("and so is a signed-in user — service_role only, like conversation_context")
    : bad("!!! A SIGNED-IN USER CAN READ ANY TICKET'S TRANSCRIPT BY ID");
  await c.auth.signOut();
}

console.log("\nI. Tickets record which model classified them");
{
  const { data: cols } = await svc.from("tickets").select("classified_by").limit(1);
  cols !== null
    ? ok("tickets.classified_by exists and is readable")
    : bad("classified_by is missing");

  await svc.from("tickets").update({ classified_by: "gemini" }).eq("id", made[0]);
  const { data: check } = await svc.from("tickets").select("classified_by").eq("id", made[0]).single();
  check.classified_by === "gemini"
    ? ok("and records the answering provider — 'are we quietly on the fallback?' is a query, not a hunch")
    : bad(`did not persist: ${check.classified_by}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("ticket_messages").delete().in("ticket_id", made);
await svc.from("tickets").delete().in("id", made);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — an outage fails over instead of degrading, and a reply is read in context."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
