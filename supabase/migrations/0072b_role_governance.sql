-- What the two new roles may do. Board decision, 29 July 2026.
--
-- `executive` — the MD of TFML and the Managing Partner of OEA:
--     • sees everything finance sees                  (0072a)
--     • co-holds payment approval, INCLUDING above the threshold
--     • CANNOT execute a remittance                   ← the board's explicit call
--     • cannot write bank configuration, post to the ledger, run a
--       reconciliation, or change the approval threshold
--
-- The remittance exclusion is the whole point and is worth stating plainly:
-- oversight and disbursement in the same pair of hands removes the separation of
-- duties that makes the audit trail worth anything. An MD may authorise a large
-- payment and cannot be the one who moves the money. The same reasoning keeps
-- `payment_settings_write` away from them — approving against a threshold you can
-- raise yourself is not an approval.
--
-- `regional_manager` — decentralised FM/PM administration. Everything a facility
-- manager holds, plus inviting operational staff, and nothing financial. Bounded
-- to their subtree by the node assignment (0067) and, for writes, by 0073.

-- ── The baseline learns both roles ─────────────────────────────────────────
create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager']::user_role[]
    loop
      v_granted := case
        when r = 'admin' then true

        -- Oversight sees everything that is a matter of reading. It is not given
        -- operational write capabilities: an MD does not close job cards.
        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        -- A regional manager is a facility manager with a wider remit inside their
        -- own region: they may invite the operational staff who work it. Deviation
        -- from the B7 table is deliberate and board-approved on 29 July 2026; B7
        -- gains a row rather than this being smuggled in as a default.
        when r = 'regional_manager' then cap.key in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.review_all'
        )

        -- Org-wide READING of operational data: finance only. Every other role
        -- reaches what it needs through property scoping or its own records.
        when cap.key in ('tickets.read_all', 'assets.read',
                         'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite')
          then r = 'facility_manager'

        when cap.key = 'vendors.read' then r in ('facility_manager','finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'
        when cap.key = 'bi.read' then r in ('facility_manager','finance_approver','property_owner')
        when cap.key = 'people.deactivate' then false
        when cap.key = 'tickets.triage_unassigned' then false

        -- B7 silent → OFF.
        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

-- Fill in the two new roles for every existing org and capability. `on conflict do
-- nothing` means no existing decision is disturbed.
do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

-- ── The payment gate ───────────────────────────────────────────────────────
--
-- Non-delegable, so it is changed HERE in the trigger and never becomes a toggle.
-- Approval gains `executive`; remittance deliberately does not.
create or replace function enforce_payment_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  caller_role user_role := current_user_role();
  v_threshold numeric;
begin
  if new.status = 'recommended' and (new.service_verified_at is null or new.performance_validated is not true) then
    raise exception 'cannot recommend: verification + performance gate not satisfied';
  end if;

  if new.status = 'approved' then
    if new.service_verified_at is null or new.performance_validated is not true then
      raise exception 'cannot approve: gate not satisfied';
    end if;
    if caller_role not in ('finance_approver','admin','executive') then
      raise exception 'only finance, an administrator or an executive may approve payments';
    end if;

    select approval_threshold_amount into v_threshold
      from payment_settings where org_id = new.org_id;
    v_threshold := coalesce(v_threshold, 1000000);

    -- Above the threshold the approval must come from the top of the house. An
    -- executive counts: escalation exists so that large payments reach a principal,
    -- and the MD / Managing Partner is exactly who it was meant to reach.
    if new.amount > v_threshold and caller_role not in ('admin','executive') then
      raise exception
        'approvals above % require an administrator or an executive (this payment is %)',
        v_threshold, new.amount;
    end if;
  end if;

  if new.status = 'remitted' then
    if new.approved_at is null then
      raise exception 'cannot remit: payment not approved';
    end if;
    -- `executive` is absent BY DECISION. Oversight authorises; finance disburses.
    -- Whoever approves the money must not also be the one who moves it.
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only finance or an administrator may remit payments';
    end if;
  end if;

  return new;
end;
$$;

comment on function enforce_payment_transition() is
  'The B4 gate, in the database so it holds against a direct API call. Approval: finance, admin or executive, with above-threshold reserved to admin/executive. Remittance: finance or admin ONLY — an executive may authorise a payment and may never execute it (board, 29 Jul 2026).';

-- Approval is written through this policy, so it has to admit an executive too —
-- otherwise the trigger would permit what RLS refuses. The rest of the predicate
-- is unchanged from what the live catalogue held.
drop policy if exists payments_update on payments;
create policy payments_update on payments for update
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver','executive']::user_role[])
      or (
        current_user_role() = 'facility_manager'::user_role
        and vendor_id in (select current_user_scoped_vendor_ids())
      )
    )
  );
