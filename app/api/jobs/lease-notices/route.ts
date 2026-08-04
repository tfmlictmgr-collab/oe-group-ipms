import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { secretMatches } from "@/lib/webhook-security";

// The daily renewal-notice run.
//
// Called by a scheduler (Vercel Cron), not by a person, so it authenticates on a
// shared secret rather than a session. Every org is walked, because a scheduler
// has no org context and the notice thresholds are per-org configuration.
//
// ⚠️ **Idempotency is in the database, not in the schedule.** A row in
// `lease_notices` keyed on (lease, threshold) is written BEFORE the email is
// attempted, and `leases_needing_notice` excludes anything already recorded. A
// scheduler that retries, a manual re-run, or two deploys racing therefore
// cannot tell a tenant the same thing twice — which reads as chaos rather than
// diligence.
//
// The write-then-send order is deliberate. Sending first and recording after
// would, on a crash between the two, re-send on the next run; recording first
// risks a notice marked sent that failed to leave. The second is the better
// failure: `delivered` stays false and the row says what happened, so an
// operator can see it and re-send deliberately. Silently mailing someone three
// times is not recoverable by anyone.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means the endpoint is closed, not open. An
  // unauthenticated job route that mails tenants is worse than a broken one.
  if (!secret) return false;

  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  // Constant-time, matching the discipline `lib/webhook-security.ts` documents
  // for every other shared secret in this codebase (audit 0804 E1).
  return secretMatches(bearer, secret);
}

// Vercel Cron invokes with a **GET** and an `Authorization: Bearer $CRON_SECRET`
// header. POST is kept so an operator can trigger a run by hand with the same
// credential — the work is identical and idempotent either way, so there is no
// reason for the two to diverge.
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
    .select("id, name, portal_name")
    .is("deleted_at", null);
  if (orgErr) {
    return NextResponse.json({ error: orgErr.message }, { status: 500 });
  }

  let considered = 0;
  let sent = 0;
  let failed = 0;
  const problems: string[] = [];

  for (const org of orgs ?? []) {
    const { data: due, error } = await supabaseAdmin.rpc("leases_needing_notice", {
      p_org_id: org.id,
    });
    if (error) {
      problems.push(`${org.name}: ${error.message}`);
      continue;
    }

    for (const lease of (due ?? []) as {
      lease_id: string;
      tenant_user_id: string | null;
      tenant_name: string | null;
      tenant_email: string | null;
      property_name: string;
      unit_label: string;
      end_date: string;
      days_remaining: number;
      rent_amount: number;
      proposed_rent: number;
    }[]) {
      considered++;
      const brandName = org.portal_name || org.name;

      // Claim it first. The unique (lease, threshold) constraint means a second
      // concurrent run loses this insert and skips the lease entirely, rather
      // than both runs deciding to send.
      const { error: claimErr } = await supabaseAdmin.from("lease_notices").insert({
        org_id: org.id,
        lease_id: lease.lease_id,
        threshold_days: lease.days_remaining,
        recipient: lease.tenant_email,
        channel: "email",
      });
      if (claimErr) {
        // Already claimed by another run — not a failure, just nothing to do.
        if (!claimErr.message.includes("lease_notices_once")) {
          problems.push(`${lease.unit_label}: ${claimErr.message.slice(0, 60)}`);
        }
        continue;
      }

      // In-portal notification, which needs no address and always works.
      if (lease.tenant_user_id) {
        await supabaseAdmin.rpc("notify_user", {
          p_user_id: lease.tenant_user_id,
          p_kind: "system",
          p_title: `Your tenancy ends in ${lease.days_remaining} days`,
          p_body:
            `${lease.unit_label} at ${lease.property_name}. ` +
            `Speak to the letting team if you would like to renew.`,
          p_link: "/dashboard",
          p_entity_type: "lease",
          p_entity_id: lease.lease_id,
        });
      }

      if (!lease.tenant_email) {
        await supabaseAdmin.from("lease_notices")
          .update({ detail: "No email address on file; notified in the portal only." })
          .eq("lease_id", lease.lease_id).eq("threshold_days", lease.days_remaining);
        continue;
      }

      const money = (n: number) => `₦${Number(n).toLocaleString("en-NG")}`;
      const ends = new Date(lease.end_date).toLocaleDateString("en-NG", {
        day: "numeric", month: "long", year: "numeric",
      });

      const result = await sendEmail({
        to: lease.tenant_email,
        orgId: org.id,
        category: "account",
        entityType: "lease",
        entityId: lease.lease_id,
        subject: () => `Your tenancy at ${lease.property_name} ends on ${ends}`,
        text: () =>
          [
            `Hello ${lease.tenant_name ?? "there"},`,
            ``,
            `Your tenancy of ${lease.unit_label} at ${lease.property_name} ends on ${ends} —`,
            `${lease.days_remaining} days from today.`,
            ``,
            `The current rent is ${money(lease.rent_amount)}.`,
            Number(lease.proposed_rent) > Number(lease.rent_amount)
              ? `On renewal it would be ${money(lease.proposed_rent)}.`
              : `A renewal would continue at the same rent.`,
            ``,
            `If you would like to renew, reply to this email or speak to the letting`,
            `team and they will prepare the papers. If you are not renewing, this note`,
            `is simply so the date does not take you by surprise.`,
            ``,
            `— ${brandName}`,
          ].join("\n"),
      });

      // `sent` means the PROVIDER accepted it — whether it arrived is decided
      // later by the delivery webhook, exactly as invitations already treat it.
      const accepted = result.sent;
      await supabaseAdmin.from("lease_notices")
        .update({
          delivered: accepted,
          detail: accepted ? null : result.reason ?? "The mail provider did not accept this message.",
        })
        .eq("lease_id", lease.lease_id).eq("threshold_days", lease.days_remaining);

      if (accepted) sent++;
      else failed++;
    }
  }

  return NextResponse.json({
    considered,
    sent,
    failed,
    problems: problems.slice(0, 10),
  });
}
