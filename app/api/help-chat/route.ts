import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { checkRateLimit } from "@/lib/rate-limit";
import type { Edition } from "@/lib/guides/processes";
import {
  OUT_OF_SCOPE, askModel, looksLikeInjection, routeByTitles, knowledgeFor, plainAnswer, retrieve, startersFor, systemPrompt,
} from "@/lib/help-bot";

// The role help assistant.
//
// ⚠️ Like `/api/guides`, nothing on the request chooses WHICH role's material
// is used — the role comes from the signed-in session. There is no `?role=`
// to try. The browser sends a question and nothing else.
//
// The model has no tools and no database access, and is shown no names,
// amounts or records: only the caller's own role guide and process text, which
// is already printed on the Guide and Training screens. Its worst case is a
// wrong or off-topic sentence, and retrieval runs first so that an off-topic
// question never reaches it.
export const runtime = "nodejs";

const MAX_QUESTION = 400;

async function context() {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) return null;
  const { profile, org } = session;
  const supabase = await createClient();
  const { data: moduleRows } = await supabase
    .from("org_modules").select("module").eq("org_id", profile.org_id).eq("enabled", true);
  const features = new Set((moduleRows ?? []).map((r) => r.module as string));
  const edition: Edition = org.is_platform_operator ? "operator" : org.delivery_brand === "OEA" ? "OEA" : "TFML";
  const chunks = knowledgeFor(profile.role, org.delivery_brand, edition, features);
  return { profile, org, chunks, label: roleLabel(profile.role, org.delivery_brand) };
}

export async function GET() {
  const c = await context();
  if (!c) return new NextResponse("Sign in required", { status: 401 });
  return NextResponse.json({ roleLabel: c.label, starters: startersFor(c.chunks) });
}

export async function POST(req: Request) {
  const c = await context();
  if (!c) return new NextResponse("Sign in required", { status: 401 });

  const rl = await checkRateLimit("help-chat", c.profile.id, 20, "10 m");
  if (!rl.allowed) {
    return NextResponse.json(
      { answer: "You've asked a lot in a short time. Please wait a few minutes and try again." },
      { status: 429 }
    );
  }

  let body: { question?: unknown; earlier?: unknown };
  try { body = await req.json(); } catch { return new NextResponse("Bad request", { status: 400 }); }
  const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";
  if (!question) return new NextResponse("Bad request", { status: 400 });

  // Only the person's own earlier QUESTIONS are accepted as history. Assistant
  // turns are never taken from the client, so a forged "assistant said it was
  // fine" cannot be planted in the prompt.
  const earlier = Array.isArray(body.earlier)
    ? body.earlier.filter((q): q is string => typeof q === "string").slice(-2).map((q) => q.slice(0, MAX_QUESTION))
    : [];

  if (looksLikeInjection(question)) return NextResponse.json({ answer: OUT_OF_SCOPE, source: "referral" });
  let hits = retrieve(question, c.chunks, 4);
  // Weak keyword match: ask the model to choose sections from the role's own
  // titles. It can only return ids that exist in this role's list.
  if (hits.length < 2 || hits[0].score < 5) {
    const routed = await routeByTitles(question, c.chunks);
    if (routed?.length) {
      const seen = new Set(routed.map((r) => r.id));
      hits = [...routed.map((chunk) => ({ chunk, score: 99 })), ...hits.filter((h) => !seen.has(h.chunk.id))].slice(0, 4);
    }
  }
  if (hits.length === 0) return NextResponse.json({ answer: OUT_OF_SCOPE, source: "referral" });

  const material = hits.map((h) => h.chunk.text).join("\n\n");
  const system = systemPrompt(c.label, c.org.name, material);
  const answer = await askModel(system, [...earlier, question]);
  if (answer) return NextResponse.json({ answer, source: "model" });
  return NextResponse.json({ answer: plainAnswer(hits), source: "guide" });
}
