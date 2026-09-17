import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/webhook-security";

// The daily lease-expiry sweep.
//
// Flips a live tenancy past its end date to `expired`, so the rent roll shows
// what has actually run out rather than a column of `active` rows whose dates
// disagree with them. Every org is walked, because a scheduler has no org
// context.
//
// ⚠️ **It does not free the unit, and that is the design.** A tenant holding
// over past expiry is ordinary here, and marking the flat vacant on the
// strength of a date would advertise an occupied home and offer it to a second
// applicant. The lease going `expired` is what puts it in front of a person;
// `end_tenancy` — one click on the rent roll — is what that person calls when
// the keys actually come back, and that is what raises the vacancy count.
//
// The work is idempotent by its own WHERE clause: a lease already `expired` is
// not `active` or `renewed`, so a retry, a manual re-run or two deploys racing
// change nothing on the second pass.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means the endpoint is closed, not open.
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

  const { data: orgs, error: orgErr } = await supabaseAdmin
    .from("orgs")
    .select("id, name")
    .is("deleted_at", null);
  if (orgErr) {
    return NextResponse.json({ error: orgErr.message }, { status: 500 });
  }

  let expired = 0;
  const problems: string[] = [];

  for (const org of orgs ?? []) {
    // One org failing must not stop the rest — the sweep is per-org work and a
    // single bad row should not leave every other portfolio unswept.
    const { data, error } = await supabaseAdmin.rpc("expire_due_leases", {
      p_org_id: org.id,
    });
    if (error) {
      problems.push(`${org.name}: ${error.message}`);
      continue;
    }
    expired += Number(data ?? 0);
  }

  return NextResponse.json({
    ok: problems.length === 0,
    orgs: orgs?.length ?? 0,
    expired,
    ...(problems.length > 0 ? { problems } : {}),
  });
}
