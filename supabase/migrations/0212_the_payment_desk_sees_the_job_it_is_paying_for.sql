-- The payment officer could not see the request they were being asked to pay
-- for, and a request nobody picks up waits for ever. (Board direction,
-- 28 Aug 2026 — decision 23.)
--
-- ── 1. Why the payment officer saw nothing ────────────────────────────────
--
-- Reported from the demo as *"payment officer couldn't see fm's request for
-- payment"*. Two causes, both in `current_user_payable_ticket_ids()` (0184),
-- and the second is the one that actually bit:
--
--   ⚠️ **A. The resolver only ever looked at `payments`.** An FM/PM asking for
--   money raises an OPS REQUISITION (0170), not a vendor invoice.
--   `ops_requisitions.ticket_id` is the same link `payments.ticket_id` is, and
--   this function has no branch for it — so the requisition itself was visible
--   (`ops_requisitions_select` admits oversight and the chain roles) while the
--   service request it names was not. The payment officer got a requisition
--   referring to a job they could not open. That is precisely "couldn't see the
--   FM's request for payment", and it is a gap 0170 opened and 0184 did not know
--   to close: 0184 was written three payables ago, when a payable meant a
--   vendor invoice.
--
--   **B. Finance was gated behind the WHOLE chain.** 0184 gave
--   `finance_approver` `chain_cleared_before(..., 4)` — every stage approved —
--   on the reasoning that disbursement is the action that reaches their desk.
--   Decision 23 replaces that reading: the four roles are now ONE FLOW, and a
--   payment officer who cannot see the job until the moment before they release
--   the money cannot query it, cannot chase it, and cannot answer the vendor
--   ringing them about it. Visibility now begins when the payable enters the
--   chain.
--
-- 📌 What is deliberately NOT done: `tickets.read_all` is not given back to
-- finance. 0184/0185 removed it because B7's cell for them is their own desk,
-- not the organisation's queue, and that stands — this branch still shows only
-- requests with money attached that is genuinely theirs to handle. The
-- difference is WHEN, and WHICH payables count.
--
-- 📌 `payment_audit_approver` and `executive` never reach this function: both
-- hold org-wide sight through `request_read_all_roles()` (0185), the auditor
-- because stage 2 of the old chain — stage 1 of OEA's — checks an invoice
-- against the job card and the evidence. Decision 23's *"audit should see every
-- detail in payment requests, invoices and attachments"* is therefore already
-- true, and `scripts/verify-request-visibility.mjs` proves it rather than this
-- file re-granting it.

create or replace function current_user_payable_ticket_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  -- Vendor invoices.
  select distinct p.ticket_id
    from payments p
   where p.ticket_id is not null
     and p.org_id = current_user_org_id()
     and p.status <> 'rejected'
     and current_user_role() in ('payment_approver', 'finance_approver')

  union

  -- ⚠️ NEW (0212). An FM/PM's own request for money. The branch whose absence
  -- was reported from the demo.
  select distinct q.ticket_id
    from ops_requisitions q
   where q.ticket_id is not null
     and q.org_id = current_user_org_id()
     and q.status <> 'rejected'
     and current_user_role() in ('payment_approver', 'finance_approver');
$$;

revoke all on function current_user_payable_ticket_ids() from public, anon;
grant execute on function current_user_payable_ticket_ids() to authenticated, service_role;

comment on function current_user_payable_ticket_ids is
  'The service requests this caller may see BECAUSE money attached to them is theirs to handle — never the operational queue. Covers vendor invoices AND ops requisitions (0212: the requisition branch was missing, so an FM''s own request for payment named a job the payment officer could not open). Visible from the moment the payable enters the chain rather than only once it has climbed to them (decision 23): the four chain roles are one flow, and a payment officer who first sees the job at the instant they release the money cannot query it. Empty for every role that is not payment_approver or finance_approver — admin, executive and the payment auditor see requests outright through request_read_all_roles().';

-- ── 2. A request nobody picks up reaches the administrator ────────────────
--
-- Board direction: the administrator *"assigns job requests flagged as
-- unassigned after 24 hours of a vendor/tenant/landlord/fm/pm/regional job
-- request raise"*.
--
-- ⚠️ This has to be built without undoing 0178. That migration stopped an
-- administrator being the person who both RECEIVES a request and DISPATCHES it
-- with nobody operational in between — the intake-path twin of decision 16 —
-- and put the escape hatch behind `tickets.assign_without_review`, off by
-- default for every role including admin, turned on per org by an operator.
--
-- Granting that capability to admin would be the easy reading and the wrong
-- one: it is permanent, org-wide, and would let an administrator dispatch a
-- request that arrived ninety seconds ago. What the board described is
-- narrower — a rescue for work that has been sitting.
--
-- So the exception is per-ticket and bounded by time, and it is computed from
-- `created_at` by the trigger itself:
--
--   • an administrator, and only an administrator;
--   • on a request that is still unreviewed AND still unassigned;
--   • that has been waiting more than 24 hours.
--
-- 📌 **The trigger does the arithmetic, not the job below.** Decision 15's rule
-- — "the record decides, never the schedule" — applies exactly: if the cron
-- never runs, an administrator can still rescue a stale request, because the
-- condition is a fact about the row rather than a flag something else had to
-- set. The job's only job is to TELL them.
--
-- 📌 **24 hours is hardwired, deliberately.** Every other cadence in this system
-- is per-org configuration (decision 15), and this one is not, because it is not
-- a cadence — it is the width of an exception to a separation-of-duties control.
-- An organisation that could set it to zero would have turned 0178 off through
-- the settings form. Decision 7: non-delegable controls never appear as toggles.
--
-- The rescue STAMPS the review with the administrator's own name, so the trail
-- says who took the operational decision and that it came this way — an
-- administrator who dispatches under this rule owns that dispatch.

alter table tickets add column if not exists escalated_at timestamptz;

comment on column tickets.escalated_at is
  'When this request was flagged to the administrators for having sat unassigned past the 24-hour mark (0212). Set once, by escalate_stale_unassigned_requests, so a retrying job cannot tell them the same thing twice. It is a NOTIFICATION record only — the administrator''s authority to rescue the request is computed from created_at by the dispatch trigger, so it does not depend on this job ever having run.';

create index if not exists tickets_unassigned_escalation_idx
  on tickets (org_id, created_at)
  where assigned_to_user_id is null
    and assigned_vendor_id is null
    and escalated_at is null;

-- ── The gate, with the rescue written into it ─────────────────────────────
--
-- ⚠️ Rewritten from the LIVE definition (0178). The service-role allowance and
-- the "only the first attachment matters" condition are carried across
-- unchanged; one branch is added between the review check and its refusal.
create or replace function tickets_require_review_before_dispatch()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_stale boolean;
begin
  -- Service role: seeding and migrations, not a person at a keyboard. Same
  -- allowance this codebase already makes throughout (e.g. set_org_domain).
  if auth.uid() is null then
    return new;
  end if;

  -- Only the moment a vendor or an ops person is FIRST attached matters —
  -- reassigning an already-dispatched ticket is a different action, already
  -- gated by tickets_update's own policy, and re-requiring review on every
  -- edit would make correcting a wrong dispatch harder, not safer.
  if (old.assigned_vendor_id is null and new.assigned_vendor_id is not null)
     or (old.assigned_to_user_id is null and new.assigned_to_user_id is not null)
  then
    if new.reviewed_at is null and not has_permission('tickets.assign_without_review') then

      -- ── The 24-hour administrator rescue (decision 23) ────────────────
      --
      -- Computed here, from the row, so it holds whether or not anything has
      -- flagged the ticket. `old` deliberately, not `new`: the question is
      -- whether this request was UNASSIGNED BEFORE this statement, which is
      -- what "nobody picked it up" means.
      v_stale := current_user_role() = 'admin'
        and old.assigned_vendor_id is null
        and old.assigned_to_user_id is null
        and old.reviewed_at is null
        and old.created_at < now() - interval '24 hours';

      if not v_stale then
        raise exception
          'This request has not been reviewed yet — an FM (or regional manager) needs to look at it before it can be dispatched to a vendor or an ops person.';
      end if;

      -- The administrator becomes the reviewer of record. A rescue is still a
      -- review; what it is not is anonymous.
      new.reviewed_at := now();
      new.reviewed_by := auth.uid();

      insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                             before_state, after_state)
      values (new.org_id, auth.uid(), 'ticket.escalated_dispatch', 'ticket', new.id,
              jsonb_build_object('reviewed_at', null,
                                 'created_at', old.created_at,
                                 'hours_unassigned',
                                 round(extract(epoch from (now() - old.created_at)) / 3600)),
              jsonb_build_object('reviewed_by', auth.uid()::text,
                                 'reason',
                                 'Unassigned for more than 24 hours; dispatched by an administrator under decision 23'));
    end if;
  end if;

  return new;
end;
$$;

revoke all on function tickets_require_review_before_dispatch() from public;

comment on trigger tickets_review_before_dispatch on tickets is
  'Blocks assigning a vendor or ops person to a request nobody operational has reviewed yet (0178), with two exceptions: tickets.assign_without_review (off by default, operator-toggle per org), and — since decision 23 — an ADMINISTRATOR on a request that has sat unreviewed and unassigned for more than 24 hours. The second is per-ticket, time-bounded, computed from created_at rather than from a flag, and stamps the administrator as the reviewer of record with an audit entry.';

-- ── What is still sitting ─────────────────────────────────────────────────
--
-- Read by the escalation job and by anything that wants to show an
-- administrator their rescue queue. SECURITY INVOKER: `tickets_select` decides
-- which rows come back, so this cannot become a way to read another
-- organisation's queue.
create or replace function stale_unassigned_requests()
returns table (
  id uuid,
  org_id uuid,
  summary text,
  urgency ticket_urgency,
  created_at timestamptz,
  hours_waiting numeric,
  escalated_at timestamptz
)
language sql stable set search_path = public as $$
  select t.id, t.org_id, t.summary, t.urgency, t.created_at,
         round(extract(epoch from (now() - t.created_at)) / 3600, 1),
         t.escalated_at
    from tickets t
   where t.assigned_to_user_id is null
     and t.assigned_vendor_id is null
     and t.reviewed_at is null
     and t.status not in ('resolved', 'closed')
     and t.created_at < now() - interval '24 hours'
   order by t.created_at;
$$;

revoke all on function stale_unassigned_requests() from public, anon;
grant execute on function stale_unassigned_requests() to authenticated, service_role;

comment on function stale_unassigned_requests is
  'Requests that have sat more than 24 hours with nobody operational reviewing or picking them up — the administrator''s rescue queue (decision 23). SECURITY INVOKER, so tickets_select still decides what the caller sees.';

-- ── Telling the administrators, once ──────────────────────────────────────
--
-- ⚠️ Fires ONCE per request, and `escalated_at` is what makes that true — the
-- same shape decision 15 requires of renewal notices, for the same reason: a
-- retrying job must not tell somebody the same thing three times. The record
-- decides; the schedule never does.
--
-- Service-role only. It notifies across organisations in one pass, which is
-- exactly what `notify_role` permits a service-role caller to do (0122) and
-- what no signed-in caller may do.
create or replace function escalate_stale_unassigned_requests()
returns integer language plpgsql security definer set search_path = public as $$
declare
  t record;
  n integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'this job runs unattended, not as a signed-in user';
  end if;

  for t in
    select tk.id, tk.org_id, tk.summary, tk.urgency, tk.created_at
      from tickets tk
     where tk.assigned_to_user_id is null
       and tk.assigned_vendor_id is null
       and tk.reviewed_at is null
       and tk.escalated_at is null
       and tk.status not in ('resolved', 'closed')
       and tk.created_at < now() - interval '24 hours'
     order by tk.created_at
     limit 500
  loop
    -- Stamp FIRST, then notify. The opposite order would, on a crash between
    -- the two, re-notify on the next run — and the whole point of the column is
    -- that an administrator is told once. A crash here loses one notification;
    -- the request is still in `stale_unassigned_requests()` and still on the
    -- rescue queue, so nothing is lost that the screen does not still show.
    update tickets set escalated_at = now() where id = t.id;

    perform notify_role(
      t.org_id,
      array['admin']::user_role[],
      'request',
      'Unassigned for over 24 hours',
      coalesce(t.summary, 'A service request') ||
        ' has been waiting since ' || to_char(t.created_at, 'DD Mon') ||
        ' with nobody assigned.',
      '/dashboard/tickets/' || t.id::text,
      'ticket',
      t.id
    );

    insert into audit_log (org_id, actor_id, action, entity_type, entity_id, after_state)
    values (t.org_id, null, 'ticket.escalated_unassigned', 'ticket', t.id,
            jsonb_build_object('urgency', t.urgency,
                               'created_at', t.created_at,
                               'reason', 'Unassigned past 24 hours — administrators notified (decision 23)'));

    n := n + 1;
  end loop;

  return n;
end;
$$;

revoke all on function escalate_stale_unassigned_requests() from public, anon, authenticated;
grant execute on function escalate_stale_unassigned_requests() to service_role;

comment on function escalate_stale_unassigned_requests is
  'Flags every request that has sat unassigned and unreviewed past 24 hours and tells the organisation''s administrators, once each (decision 23). Service-role only. The administrator''s AUTHORITY to then dispatch it does not come from here — the dispatch trigger computes the 24 hours from created_at itself, so an unrun job delays the notification and never the rescue.';
