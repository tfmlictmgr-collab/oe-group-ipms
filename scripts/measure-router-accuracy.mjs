// Which model should route inbound messages? Measured, not asserted.
//
// The 20 cases below are REAL — every one is a message a tenant actually sent to
// the OEA WhatsApp number between 8 and 28 August 2026, or the direct shape of
// one. Four of them became tickets they should never have become, and one is the
// exchange where we asked an open question and read the answer as a new report.
//
// This is deliberately NOT a `verify-*` suite: it is not pass/fail
// infrastructure, it costs real money per run, and `verify-all` must not sweep
// it up. It exists to answer one question with evidence when a new model ships
// or someone proposes a cheaper one — the same job
// `measure-classifier-accuracy.mjs` does for category and priority.
//
// ⚠️ Read SECTION G first, always. Overall accuracy is the interesting number;
// section G is the load-bearing one. Every change to this router narrows what
// counts as a request, and the failure mode of narrowing too far is a person
// reporting a leak and being told "noted" — silent, and far worse than a
// duplicate ticket. A model that scores 20/20 overall and 5/6 on G is
// disqualified, not a close second.
//
// The router calls a model directly here — no HTTP, no database, no webhook —
// so what is measured is the DECISION and nothing else.
//
// Usage:
//   npx tsx scripts/measure-router-accuracy.mjs                       (the resolved chain)
//   ANTHROPIC_MODEL=claude-haiku-4-5 npx tsx scripts/measure-router-accuracy.mjs
//
// Measured 28 Aug 2026, five runs each, on these cases:
//
//   claude-opus-5 (effort low)   98/100  98%   30/30 G   median 3350ms   $5/$25 per MTok
//   claude-sonnet-5             129/140  92%   42/42 G   median 2330ms   $2/$10 per MTok
//   claude-haiku-4-5              57/60  95%   18/18 G   median 1489ms   $1/$5  per MTok
//
// No model ever lost a section-G case, on any run. What separates them is the
// CONTINUATION cases — is this about the open request, or a new one — which is
// exactly the defect this router was rewritten to fix. Opus 5 leads the chain in
// `lib/llm.ts` on that basis; Sonnet's failures are all in the tolerable
// direction (a duplicate, visible and closeable), so it is a legitimate cheaper
// choice rather than a dangerous one.
//
// ⚠️ Three runs said something different from five. The first sample had Sonnet
// at 95% and Opus at 98%, close enough to call noise and pick the cheaper; two
// more runs each moved Sonnet to 92% and left Opus unmoved. **Run this at least
// five times per model before concluding anything** — a single run of twenty
// cases cannot tell a two-point gap from a six-point one.
//
// 📌 Haiku's numbers above were impossible to obtain until the run that produced
// them. `claude-haiku-4-5` returns HTTP 400 for `output_config.effort`, so with
// that parameter sent unconditionally every Haiku call failed and the whole run
// silently answered on Gemini — an operator dialling down cost would have
// changed vendor without a word anywhere. `lib/llm.ts` now retries the same
// model without the parameter. **A cheaper model is not a config change you can
// make on trust; run this.**

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local"), override: false });

const { routeInboundMessage } = await import("../lib/inbound-router.ts");

const THREAD = {
  ticketId: "11111111-1111-1111-1111-111111111111",
  reference: "D4F73524",
  category: "maintenance",
  urgency: "critical",
  status: "open",
  awaiting: null,
  messageText: "My roof seems to be dropping water, don't know might be from the HVAC. Send your guys.",
  createdAt: "2026-08-20T12:00:00Z",
  isOpen: true,
  fromReference: false,
  transcript: [
    { author: "reporter", body: "My roof seems to be dropping water, don't know might be from the HVAC. Send your guys.", createdAt: "2026-08-20T12:00:00Z" },
    { author: "system", body: "Thanks — your request has been logged. Ref: D4F73524", createdAt: "2026-08-20T12:00:05Z" },
  ],
};

const ACK = "Thanks — your request has been logged.\n\nRef: D4F73524\nCategory: Maintenance\nPriority: Normal";
const INVITE = "Hello. You have D4F73524 open — tell us more about it, or describe something new and we'll log it separately.";

// [label, text, thread, state, acceptable intents]
const CASES = [
  // ── The four questions that became tickets ──────────────────────────────
  ["Q1 the headline case", "Tell me about my raised requests", null, null, ["list_requests"]],
  ["Q2 rephrased", "what's outstanding on my side?", null, null, ["list_requests"]],
  ["Q3 with a thread", "Has this been assigned yet?", THREAD, null, ["ask_status", "list_requests"]],
  ["Q4 quoted ref", "This ought to be a fix for my toilet, what's the stats now?", { ...THREAD, fromReference: true }, null, ["ask_status", "follow_up"]],

  // ── The answer-to-our-own-question split ────────────────────────────────
  ["A1 answering our invite", "It's about a broken ceiling in my room", THREAD,
    { awaiting: "describe_problem", lastPrompt: INVITE, lastTicketId: THREAD.ticketId }, ["follow_up"]],
  ["A2 objecting to our ack", "But that wasn't a request", THREAD,
    { awaiting: "urgency_confirmation", lastPrompt: ACK, lastTicketId: THREAD.ticketId },
    ["pleasantry", "follow_up", "unclear", "question"]],
  ["A3 answering 'what is wrong'", "My ceiling is broken in the back room", null,
    { awaiting: "describe_problem", lastPrompt: "Tell us what needs attention.", lastTicketId: null }, ["new_request"]],

  // ── Genuine enquiries ───────────────────────────────────────────────────
  ["E1 how to pay", "How do I pay my service charge?", null, null, ["question", "list_requests"]],
  ["E2 process", "when is the next building inspection?", null, null, ["question", "list_requests"]],

  // ── Pleasantries the old code got wrong ─────────────────────────────────
  ["P1 good morning", "Good morning", null, null, ["pleasantry"]],
  ["P2 typo greeting", "Hu", null, null, ["pleasantry", "unclear"]],
  ["P3 thanks with thread", "thanks for the update", THREAD, null, ["pleasantry"]],

  // ── MUST STILL BE A REQUEST (section G — the line that must not move) ───
  ["G1 the real roof leak", "My roof seems to be dropping water, don't know might be from the HVAC. Send your guys.", null, null, ["new_request"]],
  ["G2 pidgin", "Light don go for the whole compound since yesterday night", null, null, ["new_request"]],
  ["G3 terse", "AC not working", null, null, ["new_request"]],
  ["G4 question-shaped request", "Can you send someone to fix my toilet?", null, null, ["new_request"]],
  ["G5 no water", "No water in the whole block since morning", null, null, ["new_request"]],
  ["G6 second problem", "Separately, the water pump in Block B is making a loud noise and leaking.", THREAD, null, ["new_request"]],

  // ── Continuations ───────────────────────────────────────────────────────
  ["C1 worse now", "it's worse now, water is coming through the light fitting", THREAD, null, ["follow_up", "correct_priority"]],
  ["C2 escalation", "No please, this is actually urgent — the whole stairwell is dark and someone fell yesterday.", THREAD, null, ["correct_priority", "follow_up"]],
];

const model = process.env.ANTHROPIC_MODEL ?? "(default)";
console.log(`\nMODEL: ${model}\n${"=".repeat(60)}`);

let hits = 0, misses = [], gHits = 0, gTotal = 0;
const t0 = Date.now();
const latencies = [];

for (const [label, text, thread, state, accept] of CASES) {
  const s = Date.now();
  const r = await routeInboundMessage(text, thread, state);
  latencies.push(Date.now() - s);
  const ok = accept.includes(r.intent);
  if (ok) hits++; else misses.push(`${label}: got "${r.intent}" want ${accept.join("|")} — "${text.slice(0, 50)}"`);
  if (label.startsWith("G")) { gTotal++; if (ok) gHits++; }
  process.stdout.write(ok ? "." : "X");
}

const total = CASES.length;
latencies.sort((a, b) => a - b);
console.log(`\n\n  overall     ${hits}/${total}  (${Math.round((hits / total) * 100)}%)`);
console.log(`  section G   ${gHits}/${gTotal}  ← a real problem must always be a request`);
console.log(`  latency     median ${latencies[Math.floor(latencies.length / 2)]}ms · p90 ${latencies[Math.floor(latencies.length * 0.9)]}ms · total ${Math.round((Date.now() - t0) / 1000)}s`);
if (misses.length) { console.log("\n  misses:"); for (const m of misses) console.log(`    - ${m}`); }
