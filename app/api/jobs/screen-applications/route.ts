import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/webhook-security";
import { sectionsFor } from "@/lib/application-form";

// The automated completeness check, and the 24-hour nudge behind it.
//
// Board direction, 30 Aug 2026: an application whose documents are all
// attached and whose compulsory fields are all filled is passed automatically
// to a human reviewer — the regional manager for the property's own location
// — who reviews and decides. The administrator is the fill-in once it has sat
// unattended for 24 hours.
//
// ⚠️ WHAT THIS CHECKS, AND WHAT IT REFUSES TO.
//
// It counts documents and it counts filled fields. It does not read what an
// answer SAYS, does not weigh anything, and produces no score, ranking or
// opinion about a person — the recommendation it records means precisely
// "this envelope is complete", and `0225` writes it with no human actor so
// the review history can never pass it off as somebody's judgement. The
// locked decision that screening stays human is about judging an applicant;
// nothing here does that, and `record_application_approval` is untouched, so
// a person still assigns the unit and still states their own reason.
//
// ⚠️ AND WHY THE CHECK LIVES HERE RATHER THAN IN SQL. The compulsory fields
// are declared in `lib/application-form.ts` — one declaration that already
// drives the form, its validation, the reviewer's read-only rendering and the
// printable template. Restating them in a SQL function would be a fifth copy
// that must agree with the other four, and this codebase has been bitten by
// two lists that must agree often enough to have written the rule down. So
// the job reads the same declaration the form does, and `0225` takes the
// finding as an argument.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means CLOSED, not open — the same posture as every
  // other job route here.
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  return secretMatches(bearer, secret);
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}

/** Filled means present and not blank. `false` on a checkbox is an answer. */
function filled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

async function run(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  // Only ever the front of the queue, and `screened_at` is what stops a retry
  // or two overlapping runs speaking twice about the same application.
  const { data: apps, error: appsErr } = await supabaseAdmin
    .from("tenant_applications")
    .select("id, org_id, type, form, property_id")
    .eq("status", "submitted")
    .is("screened_at", null)
    .is("purged_at", null)
    .limit(200);

  if (appsErr) {
    console.error("application screening failed:", appsErr.message);
    return NextResponse.json({ ok: false, error: appsErr.message }, { status: 500 });
  }

  let recommended = 0;
  let incomplete = 0;

  for (const app of apps ?? []) {
    // ── Required documents, as THIS organisation defines them for THIS type.
    const [{ data: reqs }, { data: attached }] = await Promise.all([
      supabaseAdmin
        .from("application_document_requirements")
        .select("kind, label, required")
        .eq("org_id", app.org_id)
        .eq("type", app.type),
      supabaseAdmin
        .from("application_attachments")
        .select("kind")
        .eq("application_id", app.id),
    ]);

    const have = new Set((attached ?? []).map((a) => a.kind));
    const required = (reqs ?? []).filter((r) => r.required);
    const missingDocs = required.filter((r) => !have.has(r.kind));

    // ── Compulsory fields, from the one declaration the form itself uses.
    // `sensitive` fields are optional by design (NDPA special-category, 0062)
    // and live in a different column entirely, so they are never counted.
    const form = (app.form ?? {}) as Record<string, unknown>;
    const compulsory = sectionsFor(app.type)
      .flatMap((s) => s.fields)
      .filter((f) => f.required && !f.sensitive);
    const missingFields = compulsory.filter((f) => !filled(form[f.key]));

    if (missingDocs.length > 0 || missingFields.length > 0) {
      incomplete++;
      continue;
    }

    // Says exactly what was verified, and exactly what was not. This is the
    // text a reviewer reads in the history and an auditor reads afterwards,
    // so it states the limit of the check rather than leaving it implied.
    const basis =
      `Automated completeness check: all ${required.length} required document` +
      `${required.length === 1 ? "" : "s"} attached, and all ${compulsory.length} ` +
      `compulsory field${compulsory.length === 1 ? "" : "s"} completed. ` +
      `This confirms the application is complete — it is not an assessment of ` +
      `the applicant, and the decision remains the reviewer's.`;

    const { data: took, error: recErr } = await supabaseAdmin.rpc(
      "system_recommend_application",
      { p_application_id: app.id, p_basis: basis }
    );
    if (recErr) {
      console.error(`screening ${app.id} failed:`, recErr.message);
      continue;
    }
    if (took) recommended++;
  }

  // The fill-in. Separate from the loop above deliberately: an application can
  // be complete and still go unanswered, and an application can be incomplete
  // and still need somebody to chase it. Both are "nobody has acted".
  const { data: escalatedRaw, error: escErr } = await supabaseAdmin.rpc(
    "escalate_stale_applications"
  );
  if (escErr) {
    console.error("application escalation failed:", escErr.message);
  }
  const escalated = Number(escalatedRaw ?? 0);

  if (recommended > 0 || escalated > 0) {
    console.log(
      `application screening: ${recommended} passed to a reviewer, ` +
      `${incomplete} still incomplete, ${escalated} escalated to administrators`
    );
  }

  return NextResponse.json({ ok: true, recommended, incomplete, escalated });
}
