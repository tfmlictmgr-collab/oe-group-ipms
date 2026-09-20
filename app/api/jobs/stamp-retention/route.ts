import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/webhook-security";

// The approved-application retention clock — the job that starts it.
//
// `NDPA_COMPLIANCE_PACK.md` §5 carried "approved: tenancy + 6 years — has no
// job yet" as its last open retention row. This is that job, and what it does
// is narrower than the row suggests: it **stamps a date**. It deletes nothing.
//
// `purge_expired_applications()` (0062) is still the only code in this system
// that removes applicant PII, and it fires on `purge_after < now()` alone. The
// 90-day rejection rule has always worked because `0082` sets that date on
// rejection. The 6-year rule never worked because nothing set it on approval.
// So the fix is the missing date, not a second deletion path — see `0299`.
//
// ⚠️ Why this runs daily when the thing it schedules is six years away. The
// clock cannot be started at approval: it runs from the END of the tenancy,
// which is not known then and changes every time the lease is renewed. The job
// is therefore a reconciliation, not an event handler — it re-derives the
// answer for every approved application on every run, stamps the ones whose
// tenancy has since ended, and **withdraws the stamp** from any whose tenancy
// has been reopened by a renewal recorded after the fact.
//
// That withdrawal is the reason the design stamps rather than purges. A stamp
// that is wrong has six years in which to be corrected. A purge that is wrong
// has none.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means the endpoint is CLOSED, not open — the same
  // posture as every other job route.
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

  const { data, error } = await supabaseAdmin.rpc(
    "stamp_approved_application_retention"
  );

  if (error) {
    // Loud, for the same reason the purge job is loud: a retention job that
    // fails quietly accrues a breach for as long as nobody looks.
    console.error("retention stamp FAILED:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // `returns table` arrives as a one-row array.
  const row = Array.isArray(data) ? data[0] : data;
  const stamped = Number(row?.stamped ?? 0);
  const withdrawn = Number(row?.withdrawn ?? 0);

  // The population the clock CANNOT cover: approved, but no lease was ever
  // linked, so there is no tenancy end to count from. Reported on every run
  // rather than left to be discovered — an approved application that quietly
  // has no retention date is exactly the shape of the gap this whole job
  // exists to close, and it would otherwise be invisible.
  const { data: orphaned, error: orphanError } = await supabaseAdmin.rpc(
    "approved_applications_without_tenancy"
  );
  if (orphanError) {
    console.warn(
      `retention stamp: could not count approved applications without a tenancy — ${orphanError.message}`
    );
  }
  const withoutTenancy = orphanError ? null : Number(orphaned ?? 0);

  console.log(
    `retention stamp: ${stamped} clock(s) started, ${withdrawn} withdrawn (tenancy reopened), ` +
      `${withoutTenancy ?? "unknown"} approved application(s) have no linked tenancy and so no clock`
  );

  return NextResponse.json({
    ok: true,
    stamped,
    withdrawn,
    approvedWithoutTenancy: withoutTenancy,
  });
}
