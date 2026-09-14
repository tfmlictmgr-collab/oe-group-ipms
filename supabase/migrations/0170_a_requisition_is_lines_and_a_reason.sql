-- An FM/PM ops requisition: what staff spend money on, itemised.
--
-- ⚠️ Deliberately NOT modelled on `payments`. Two reasons, both structural:
--   * `payments.vendor_id` is NOT NULL — a requisition has no single vendor,
--     it has zero or more, one per line.
--   * B4's verification + KPI gate is about a VENDOR'S service quality. A
--     requisition is staff's own spend; there is no vendor to score. The
--     three-stage approval chain (0151) is the whole gate here — stage 1
--     (job sign-off) is what "is this legitimate" means for a requisition,
--     where for a vendor invoice it sits ALONGSIDE a separate KPI check.
--
-- One row per requisition, one row per cost line. A line optionally names a
-- registered vendor (that line becomes its own vendor remittance once
-- approved) or carries its own bank-verified payee (settled as a lump sum,
-- 0172). A line with neither is unpaid spend recorded for the audit trail
-- only — legitimate (a donated item, a cost already covered another way) and
-- deliberately not forced to resolve to a transfer.

create table if not exists ops_requisitions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id),
  -- Optional, exactly as a vendor invoice may stand alone (submit_vendor_invoice
  -- allows p_ticket_id null: "a retainer or a scheduled service"). A
  -- requisition for materials with no single job behind it is the same shape.
  ticket_id       uuid references tickets(id),
  raised_by       uuid not null references users(id),
  reference       text not null,
  -- Cached, not derived live — the amount a chain stage approved against has
  -- to be the amount that existed at that moment (0151's whole point: an
  -- upward edit after approval invalidates the chain). Kept in step with the
  -- lines by the trigger below, inside the same transaction that changes them.
  total_amount    numeric(14,2) not null default 0 check (total_amount >= 0),
  status          text not null default 'pending_approval'
                    check (status in ('pending_approval', 'approved', 'remitted', 'rejected')),
  -- The whole-requisition signed document, same shape as
  -- payments.invoice_attachment_path (0140) and the same bucket.
  invoice_attachment_path text,
  approved_at     timestamptz,
  rejected_reason text,
  rejected_by     uuid references users(id),
  rejected_at     timestamptz,
  remittance_reference text,
  created_at      timestamptz not null default now(),

  constraint ops_requisitions_rejection_has_reason check (
    status <> 'rejected' or (rejected_reason is not null and length(trim(rejected_reason)) >= 10)
  )
);

create index if not exists ops_requisitions_org_idx on ops_requisitions (org_id, created_at desc);
create index if not exists ops_requisitions_ticket_idx on ops_requisitions (ticket_id) where ticket_id is not null;
create index if not exists ops_requisitions_raised_by_idx on ops_requisitions (raised_by);

create table if not exists ops_requisition_lines (
  id              uuid primary key default gen_random_uuid(),
  requisition_id  uuid not null references ops_requisitions(id) on delete cascade,
  org_id          uuid not null references orgs(id),
  line_order      smallint not null default 1,
  description     text not null check (length(trim(description)) >= 3),
  amount          numeric(14,2) not null check (amount > 0),
  -- At most one payee per line: a registered vendor, OR a bank-verified
  -- one-off/staff payee (payout_recipients.party = 'other', 0172). Never
  -- both — a line is one cost, going to one place, or nowhere yet.
  vendor_id       uuid references vendors(id),
  payee_recipient_id uuid references payout_recipients(id),
  -- This line's OWN evidence — a receipt, a delivery note — distinct from the
  -- one signed document on the requisition as a whole. Same org-prefix
  -- discipline as every other attachment path in this schema.
  attachment_path text,
  -- Settled once its remittance exists, so a partially-paid requisition (some
  -- lines settled, others still queued) is a state the schema can represent
  -- rather than one only the application layer tracks.
  remittance_id   uuid references remittances(id),
  created_at      timestamptz not null default now(),

  constraint ops_requisition_lines_one_payee check (
    vendor_id is null or payee_recipient_id is null
  )
);

create index if not exists ops_requisition_lines_requisition_idx
  on ops_requisition_lines (requisition_id, line_order);
create index if not exists ops_requisition_lines_vendor_idx
  on ops_requisition_lines (vendor_id) where vendor_id is not null;

alter table ops_requisitions enable row level security;
alter table ops_requisition_lines enable row level security;

-- ── Who may see one ─────────────────────────────────────────────────────
--
-- Oversight, the chain roles (0157's `payment_chain_roles()` — they must see
-- what they are asked to approve), dispatch authority (fm_roles: they raise
-- these and manage the jobs behind them), and the person who raised it.
create policy ops_requisitions_select on ops_requisitions for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or current_user_role() = any (payment_chain_roles())
      or current_user_role() = any (fm_roles())
      or raised_by = auth.uid()
    )
  );

create policy ops_requisition_lines_select on ops_requisition_lines for select to authenticated
  using (
    exists (
      select 1 from ops_requisitions r
       where r.id = ops_requisition_lines.requisition_id
    )
  );

comment on table ops_requisitions is
  'An FM/PM ops requisition: staff-initiated spend, itemised into lines, gated by the SAME three-stage approval chain as a vendor invoice (0151) rather than a second mechanism (decision 8). Optionally tied to the job that needed it.';
comment on table ops_requisition_lines is
  'One cost line. At most one payee: a registered vendor (its own remittance) or a bank-verified one-off/staff payee (0172, lump-sum remittance). Neither is legitimate too -- spend recorded for the record, not forced to resolve to a transfer.';

-- ⚠️ No general INSERT/UPDATE policy on either table. The only way in is
-- `raise_ops_requisition` below (SECURITY DEFINER), and the only way the
-- chain moves one is `apply_chain_outcome_to_requisition` (0171) — matching
-- `payment_approvals`' own append-only shape: there is deliberately no path
-- that lets a raised requisition be edited after the fact rather than
-- rejected and re-raised.

-- ── The total stays in step with its lines ─────────────────────────────────
--
-- Kept as a trigger rather than computed at read time, because the amount a
-- chain stage approves against has to be a fixed number captured AT THAT
-- MOMENT (payment_approvals.amount) — is_cleared_for_disbursement compares
-- against ops_requisitions.total_amount as it stands NOW, so an edit to the
-- lines after approval has to be visible as a changed total, the same way an
-- edited payments.amount invalidates a vendor invoice's chain.
create or replace function sync_requisition_total()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce(new.requisition_id, old.requisition_id);
begin
  update ops_requisitions
     set total_amount = coalesce((
           select sum(amount) from ops_requisition_lines where requisition_id = v_id
         ), 0)
   where id = v_id;
  return null;
end;
$$;

drop trigger if exists trg_sync_requisition_total on ops_requisition_lines;
create trigger trg_sync_requisition_total
  after insert or update or delete on ops_requisition_lines
  for each row execute function sync_requisition_total();

-- ── Raising one ─────────────────────────────────────────────────────────
--
-- p_lines: jsonb array of {description, amount, vendor_id}. Every line is
-- validated before any row is written — a requisition with one bad line
-- should fail whole, not land with three good lines and a missing fourth.
create or replace function raise_ops_requisition(
  p_reference   text,
  p_lines       jsonb,
  p_ticket_id   uuid default null,
  p_attachment_path text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_org  uuid;
  v_req_id uuid;
  v_path text := nullif(trim(coalesce(p_attachment_path, '')), '');
  v_line jsonb;
  v_order smallint := 0;
  v_desc text;
  v_amount numeric;
  v_vendor uuid;
  v_count int;
begin
  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;

  select role, org_id into v_role, v_org from users where id = v_uid;

  -- Raised by the people who do the work and by dispatch authority above
  -- them — the same set 0078a's fm_roles() names, plus the ops staff member
  -- themselves and an administrator.
  if v_role not in ('fm_ops_staff', 'facility_manager', 'regional_manager', 'admin') then
    raise exception 'only operational staff may raise a requisition';
  end if;

  if length(trim(coalesce(p_reference, ''))) < 3 then
    raise exception 'give the requisition a reference of your own so you can reconcile it';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a requisition needs at least one cost line';
  end if;
  if jsonb_array_length(p_lines) > 50 then
    raise exception 'a single requisition may hold at most 50 lines — split this into more than one';
  end if;

  if p_ticket_id is not null then
    if not exists (select 1 from tickets where id = p_ticket_id and org_id = v_org) then
      raise exception 'that job could not be found in your organisation';
    end if;
  end if;

  if v_path is not null and v_path !~ ('^' || v_org::text || '/') then
    raise exception 'that attachment does not belong to your organisation';
  end if;

  insert into ops_requisitions (org_id, ticket_id, raised_by, reference, invoice_attachment_path)
  values (v_org, p_ticket_id, v_uid, trim(p_reference), v_path)
  returning id into v_req_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_order := v_order + 1;
    v_desc := trim(coalesce(v_line->>'description', ''));
    v_amount := nullif(v_line->>'amount', '')::numeric;
    v_vendor := nullif(v_line->>'vendorId', '')::uuid;

    if length(v_desc) < 3 then
      raise exception 'line %: describe the cost in at least 3 characters', v_order;
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'line %: enter a positive amount', v_order;
    end if;
    if v_vendor is not null and not exists (
      select 1 from vendors where id = v_vendor and org_id = v_org
    ) then
      raise exception 'line %: that vendor is not registered in your organisation', v_order;
    end if;

    insert into ops_requisition_lines (requisition_id, org_id, line_order, description, amount, vendor_id)
    values (v_req_id, v_org, v_order, v_desc, v_amount, v_vendor);
  end loop;

  -- Notified the same way a vendor invoice tells finance -- the chain's stage
  -- 1 is a facility/regional manager, and they are who is actually next.
  perform notify_role(
    v_org,
    array['facility_manager', 'regional_manager']::user_role[],
    'payment',
    'A requisition was raised',
    trim(p_reference) || ' awaits your sign-off',
    '/dashboard/approvals'
  );

  return v_req_id;
end;
$$;

revoke all on function raise_ops_requisition(text, jsonb, uuid, text) from public, anon;
grant execute on function raise_ops_requisition(text, jsonb, uuid, text) to authenticated, service_role;

comment on function raise_ops_requisition is
  'Raises an FM/PM ops requisition with its cost lines, validated whole-or-nothing. Enters the three-stage approval chain at stage 1 the same way a vendor invoice enters it at stage 1 -- no separate verification step, because there is no vendor service to verify (0170).';
