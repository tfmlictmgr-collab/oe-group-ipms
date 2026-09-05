-- The vendor's own half of a work order: decline it, finish it, invoice it.
--
-- The documented vendor journey is: receive a work order → accept or decline
-- → mark complete → submit an invoice → see the scorecard and payment
-- history. Three of those five had nothing behind them.
--
--   * ACCEPT existed (`acknowledgeJob`).
--   * DECLINE did not exist at all. A vendor given a job they cannot take had
--     no way to say so — the job sat "assigned" to someone who was never
--     coming, and the FM/PM had no signal.
--   * MARK COMPLETE was permitted by RLS (`tickets_update` already admits
--     `assigned_vendor_id in (... where user_id = auth.uid())`) and never
--     offered by the UI — the status card is admin/FM only. So the capability
--     existed and was unreachable.
--   * SUBMIT INVOICE was refused outright: `payments_insert` admits only
--     admin/facility_manager/regional_manager. A vendor could SEE their
--     payments (`payments_select` already includes them) but never raise one.
--
-- ⚠️ Written as SECURITY DEFINER functions rather than by widening
-- `payments_insert` to vendors. Widening the policy would let a vendor write
-- any column on any payment row — including `service_verified_at`,
-- `performance_validated` and `approved_by`, which are the B4 gate itself.
-- An invoice is a CLAIM; the gate is what turns it into money. These functions
-- let a vendor state the claim and nothing else.

-- ── An invoice belongs to a job ───────────────────────────────────────────
--
-- Nullable: a vendor may legitimately invoice for something with no ticket
-- (a retainer, a scheduled service). But when there IS a job, the link is
-- what lets a verifier see what they are paying for without asking.
alter table payments add column if not exists ticket_id uuid references tickets(id);
create index if not exists payments_ticket_idx on payments (ticket_id) where ticket_id is not null;

comment on column payments.ticket_id is
  'The work order this invoice is for, when there is one. Nullable because a retainer or scheduled service has no ticket -- but when present it is what lets a verifier see what they are paying for.';

-- ── Decline ──────────────────────────────────────────────────────────────
create or replace function decline_work_order(p_ticket_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  t tickets%rowtype;
  v_vendor uuid;
begin
  select * into t from tickets where id = p_ticket_id;
  if t.id is null then raise exception 'that request could not be found'; end if;

  -- Standing: the caller must be the login of the vendor this job is on.
  select id into v_vendor from vendors
   where id = t.assigned_vendor_id and user_id = auth.uid();
  if v_vendor is null then
    raise exception 'only the vendor this job is assigned to can decline it';
  end if;

  if t.status in ('resolved', 'closed') then
    raise exception 'that job is already finished';
  end if;

  -- A decline with no reason tells the FM/PM nothing they can act on, and
  -- "no reason given" is what makes a queue impossible to triage.
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'give a reason of at least 10 characters so the team can re-assign it properly';
  end if;

  -- Back to unassigned and open. NOT left 'assigned' with the vendor cleared:
  -- that is precisely the nobody-holds-it state 0117 exists to forbid, and the
  -- trigger would refuse the write anyway.
  update tickets
     set assigned_vendor_id = null,
         assigned_to_user_id = null,
         assigned_at = null,
         acknowledged_at = null,
         status = 'open'
   where id = p_ticket_id;

  -- The reason goes on the ticket's own conversation, where whoever re-assigns
  -- it will be reading. `author = 'system'` because it is a recorded event,
  -- not something the vendor typed to the tenant.
  insert into ticket_messages (org_id, ticket_id, author, body)
  values (t.org_id, p_ticket_id,
          'system',
          'Declined by the assigned contractor: ' || trim(p_reason));

  -- And tell the people who dispatch. Silence here is how a declined job sits
  -- unnoticed for a week.
  perform notify_role(
    t.org_id,
    array['admin', 'facility_manager', 'regional_manager']::user_role[],
    'assignment',
    'A contractor declined a job',
    trim(p_reason),
    '/dashboard/tickets/' || p_ticket_id::text
  );
end;
$$;

revoke all on function decline_work_order(uuid, text) from public, anon, authenticated;
grant execute on function decline_work_order(uuid, text) to authenticated;

comment on function decline_work_order is
  'The assigned vendor refuses a job, with a reason. Returns it to open and unassigned -- never "assigned to nobody" (0117) -- records the reason on the ticket conversation, and tells whoever dispatches.';

-- ── Mark complete ────────────────────────────────────────────────────────
create or replace function complete_work_order(p_ticket_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  t tickets%rowtype;
  v_vendor uuid;
begin
  select * into t from tickets where id = p_ticket_id;
  if t.id is null then raise exception 'that request could not be found'; end if;

  select id into v_vendor from vendors
   where id = t.assigned_vendor_id and user_id = auth.uid();
  if v_vendor is null then
    raise exception 'only the vendor this job is assigned to can mark it complete';
  end if;

  if t.status in ('resolved', 'closed') then
    raise exception 'that job is already marked complete';
  end if;

  -- `resolved`, not `closed`. Closing is the organisation's call once the work
  -- has been checked; the vendor is reporting that they have finished, which
  -- is what opens the evaluation and the tenant's satisfaction prompt (0104).
  -- `resolved_at` is stamped by tickets_stamp_lifecycle (0099), not here --
  -- one writer for that timestamp.
  update tickets set status = 'resolved' where id = p_ticket_id;

  if length(trim(coalesce(p_note, ''))) > 0 then
    insert into ticket_messages (org_id, ticket_id, author, body)
    values (t.org_id, p_ticket_id, 'system',
            'Marked complete by the contractor: ' || trim(p_note));
  end if;

  perform notify_role(
    t.org_id,
    array['admin', 'facility_manager', 'regional_manager']::user_role[],
    'request',
    'A contractor marked a job complete',
    coalesce(nullif(trim(p_note), ''), 'Ready for your verification.'),
    '/dashboard/tickets/' || p_ticket_id::text
  );
end;
$$;

revoke all on function complete_work_order(uuid, text) from public, anon, authenticated;
grant execute on function complete_work_order(uuid, text) to authenticated;

comment on function complete_work_order is
  'The assigned vendor reports the work finished. Sets resolved (not closed -- closing is the organisation''s call after verification), which is also what opens vendor evaluation and the tenant satisfaction prompt.';

-- ── Submit an invoice ────────────────────────────────────────────────────
create or replace function submit_vendor_invoice(
  p_amount numeric,
  p_invoice_reference text,
  p_ticket_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_vendor vendors%rowtype;
  t tickets%rowtype;
  v_id uuid;
begin
  select * into v_vendor from vendors where user_id = auth.uid();
  if v_vendor.id is null then
    raise exception 'only a vendor can submit an invoice';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'an invoice must be for a positive amount';
  end if;
  if length(trim(coalesce(p_invoice_reference, ''))) < 3 then
    raise exception 'give the invoice a reference of your own so you can reconcile it';
  end if;

  -- If it names a job, it must be THIS vendor's job. Otherwise a vendor could
  -- attach their invoice to somebody else's completed work and make it look
  -- verified.
  if p_ticket_id is not null then
    select * into t from tickets where id = p_ticket_id;
    if t.id is null or t.assigned_vendor_id is distinct from v_vendor.id then
      raise exception 'that job is not yours to invoice';
    end if;
    if t.status not in ('resolved', 'closed') then
      raise exception 'finish the job before invoicing for it';
    end if;
  end if;

  -- One live invoice per job, for the same reason there is one live payment
  -- link per rent demand: two claims for one piece of work is how it gets paid
  -- twice.
  if p_ticket_id is not null and exists (
    select 1 from payments
     where ticket_id = p_ticket_id and status <> 'rejected'
  ) then
    raise exception 'an invoice for that job has already been submitted';
  end if;

  -- ⚠️ Enters at `pending_verification` — the FIRST gate of B4, never past it.
  -- The vendor states an amount; service verification and the performance
  -- check are what move it, and both belong to somebody else.
  insert into payments (
    org_id, vendor_id, ticket_id, invoice_reference, amount, status
  ) values (
    v_vendor.org_id, v_vendor.id, p_ticket_id,
    trim(p_invoice_reference), p_amount, 'pending_verification'
  )
  returning id into v_id;

  perform notify_role(
    v_vendor.org_id,
    array['admin', 'facility_manager', 'finance_approver']::user_role[],
    'payment',
    'A contractor submitted an invoice',
    v_vendor.name || ' submitted ' || trim(p_invoice_reference),
    '/dashboard/payments/' || v_id::text
  );

  return v_id;
end;
$$;

revoke all on function submit_vendor_invoice(numeric, text, uuid) from public, anon, authenticated;
grant execute on function submit_vendor_invoice(numeric, text, uuid) to authenticated;

comment on function submit_vendor_invoice is
  'A vendor raises their own invoice. Enters at pending_verification -- the first B4 gate -- never past it: the vendor states a claim, and verification plus the performance check (somebody else''s job) are what turn it into money. Written as a definer function rather than by widening payments_insert, which would also hand a vendor the gate columns themselves.';
