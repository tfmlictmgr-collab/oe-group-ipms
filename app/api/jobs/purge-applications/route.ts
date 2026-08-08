import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/webhook-security";

// The retention purge — the job that makes a locked NDPA decision actually
// happen.
//
// ⚠️ Found during the Day 12 compliance review, and it is the sharpest kind of
// gap: everything was built except the thing that runs it.
//
//   * The OEA expansion locked retention as decision 3 — "rejected/withdrawn
//     purged after **90 days**, approved kept tenancy + **6 years**".
//   * `0082` sets `purge_after = now() + interval '90 days'` on every rejection.
//   * `0062` wrote `purge_expired_applications()`, which nulls the PII and keeps
//     an anonymised stub proving a decision was made.
//   * `verify-application-review` asserts the purge date is set correctly.
//   * And **nothing ever called the function.** `vercel.json` carried two crons,
//     neither of them this one.
//
// So every rejected applicant's identity documents, address, employment details
// and next-of-kin would have been retained indefinitely, by a system whose own
// consent copy promises otherwise. Deletion that is scheduled but never executed
// is not a retention policy; it is a record of one.
//
// Idempotent by construction: the function selects on `purge_after < now()` and
// nulls the columns, so a second run finds nothing left to do. A retry, a manual
// run and a doubled schedule are all safe.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means the endpoint is CLOSED, not open — the same
  // posture as the other job routes. An unauthenticated endpoint that deletes
  // personal data is worse than one that never runs.
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

async function run(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  // How many are due, recorded BEFORE the purge — afterwards there is by
  // definition nothing left to count, and a run that reports "0 purged" is
  // indistinguishable from a run that did nothing. A DPO asked "did retention
  // execute last month?" needs an answer.
  const { count: due } = await supabaseAdmin
    .from("tenant_applications")
    .select("id", { count: "exact", head: true })
    .not("purge_after", "is", null)
    .lt("purge_after", new Date().toISOString());

  const { error } = await supabaseAdmin.rpc("purge_expired_applications");

  if (error) {
    // Loud, because a silent failure here is a compliance breach that accrues
    // quietly for as long as nobody looks.
    console.error("retention purge FAILED:", error.message);
    return NextResponse.json(
      { ok: false, due: due ?? 0, error: error.message },
      { status: 500 }
    );
  }

  console.log(`retention purge: ${due ?? 0} application(s) were due and have been purged`);
  return NextResponse.json({ ok: true, purged: due ?? 0 });
}
