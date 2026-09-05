-- A request from a tenant or a vendor can land on an admin's dashboard exactly
-- as easily as an FM's — `notify_role` tells both `admin` and
-- `facility_manager` at once, and `assignTicket()` has never distinguished
-- between them: both hold `tickets.assign`, and either can move a fresh
-- request straight to `assigned_vendor_id` in one step. Nothing has ever
-- required the person with the operational context — which vendor is actually
-- good for this property, whether the tenant's account of the problem holds
-- up — to look at it first.
--
-- That gap is the same shape as decision 9/16, applied one layer earlier:
-- 0142 stopped an admin from being the one who both approves a payment and
-- releases it; this stops an admin from being the one who both receives a
-- request and dispatches it, with nobody operational in between. Oversight
-- and origination stay separate from execution — this is that principle
-- applied to the intake path, not just the money path.
--
-- ── The mechanism ────────────────────────────────────────────────────────
-- A ticket gains `reviewed_at` / `reviewed_by`. Setting `assigned_vendor_id`
-- OR `assigned_to_user_id` away from null now requires that review to have
-- already happened — enforced by trigger, not by the app layer, because the
-- app layer is advice and the trigger is the control.
--
-- `tickets.assign_without_review` is the escape hatch, and it is NOT covered
-- by admin's usual "true for everything unlocked" default. It is named
-- explicitly, before that branch, and defaults false for every role
-- including admin — an operator turns it on per org for the case B7 cannot
-- anticipate (no FM, no regional_manager, and the work genuinely cannot
-- wait). That is a deliberate, visible exception, not a silent one.
--
-- An FM/regional_manager who raises work THEMSELVES (`raiseWork`, Day 10)
-- reviews it by the act of creating it — that action now stamps
-- `reviewed_at`/`reviewed_by` on insert, so "raise and dispatch in one step"
-- keeps working exactly as it does today. Only requests that arrive from
-- somewhere else — a tenant, a vendor, WhatsApp, Telegram, the public portal
-- form — are the ones this actually gates.

alter table tickets add column if not exists reviewed_at timestamptz;
alter table tickets add column if not exists reviewed_by uuid references users(id);

comment on column tickets.reviewed_at is
  'When an FM (or regional_manager) looked at this request before it was dispatched. Null means nobody operational has reviewed it yet — required before assigned_vendor_id or assigned_to_user_id can be set, unless tickets.assign_without_review is granted (0178).';
comment on column tickets.reviewed_by is
  'Who reviewed it. Set together with reviewed_at, never independently.';

-- ── The new capability ──────────────────────────────────────────────────
insert into capabilities (key, module, label, description, locked, sort_order)
values (
  'tickets.assign_without_review', 'Requests', 'Dispatch without FM review',
  'Skip the requirement that an FM (or regional manager) reviews a request before it is assigned to a vendor or an ops person. Off by default for every role, including admin — turn on only for a specific, understood gap (e.g. no FM covers this property yet).',
  false, 12
)
on conflict (key) do nothing;

-- ── Baseline: false for everyone, admin included ─────────────────────────
--
-- Copies 0157's seed_b7_permissions unchanged except for one new branch,
-- placed BEFORE `when r = 'admin' then true` — that branch matches every
-- unlocked capability admin doesn't have a more specific rule for, and
-- without an earlier, named exception this one would silently join it.
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
                             'executive','regional_manager',
                             'payment_audit_approver','payment_approver']::user_role[]
    loop
      v_granted := case
        -- Named and false for everyone before admin's blanket grant is
        -- reached — see the migration header. An operator turns this on
        -- per org, per the exceptional case it exists for.
        when cap.key = 'tickets.assign_without_review' then false

        when r = 'admin' then true

        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when r in ('payment_audit_approver', 'payment_approver') then cap.key in (
          'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'regional_manager' then cap.key in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.review_all'
        )

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

        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

-- Backfill every ORG THAT ALREADY EXISTS with this new capability, false for
-- every role — `on conflict do nothing` in seed_b7_permissions only ever
-- reaches an org at creation/reset time, and this capability didn't exist
-- when any current org was created.
insert into role_permissions (org_id, role, capability, granted)
select o.id, r.role, 'tickets.assign_without_review', false
  from orgs o
  cross join (select unnest(enum_range(null::user_role)) as role) r
 where o.deleted_at is null
on conflict (org_id, role, capability) do nothing;

-- ── The gate itself ───────────────────────────────────────────────────────
create or replace function tickets_require_review_before_dispatch()
returns trigger language plpgsql security definer set search_path = public as $$
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
      raise exception
        'This request has not been reviewed yet — an FM (or regional manager) needs to look at it before it can be dispatched to a vendor or an ops person.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tickets_review_before_dispatch on tickets;
create trigger tickets_review_before_dispatch
  before update on tickets
  for each row execute function tickets_require_review_before_dispatch();

comment on trigger tickets_review_before_dispatch on tickets is
  'Blocks assigning a vendor or ops person to a request nobody operational has reviewed yet, unless the caller holds tickets.assign_without_review (off by default, operator-toggle per org). See 0178.';

revoke all on function tickets_require_review_before_dispatch() from public;

-- ── raise_work_order (0120) stamps its own review ────────────────────────
--
-- An FM/regional_manager raising work themselves has, by that act, already
-- reviewed it — `has_permission('tickets.assign')` is checked before any of
-- this runs, same gate the dispatch step uses. Without this the function's
-- own "dispatch in the same step" UPDATE (assigned_vendor_id going from null
-- to p_vendor_id) would hit the new trigger above and refuse itself.
-- Identical to 0120 except the INSERT also stamps reviewed_at/reviewed_by.
create or replace function raise_work_order(
  p_property_id uuid,
  p_summary     text,
  p_detail      text default null,
  p_category    ticket_category default 'maintenance',
  p_urgency     ticket_urgency default 'normal',
  p_asset_id    uuid default null,
  p_vendor_id   uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := current_user_org_id();
  v_id  uuid;
begin
  if v_org is null then
    raise exception 'you are not signed in to an organisation';
  end if;

  if not has_permission('tickets.assign') then
    raise exception 'you do not have permission to raise work orders';
  end if;

  if length(trim(coalesce(p_summary, ''))) < 5 then
    raise exception 'describe the work in at least a few words';
  end if;

  if p_property_id is null
     or p_property_id not in (select current_user_property_ids()) then
    raise exception 'that property is not one you manage';
  end if;

  if p_asset_id is not null and not exists (
    select 1 from assets
     where id = p_asset_id and org_id = v_org and property_id = p_property_id
  ) then
    raise exception 'that asset is not on that property';
  end if;

  insert into tickets (
    org_id, channel, sender_id, property_id, asset_id,
    message_text, summary, category, urgency, status, requires_human_review,
    reviewed_at, reviewed_by
  ) values (
    v_org, 'portal',
    null,
    p_property_id, p_asset_id,
    coalesce(nullif(trim(coalesce(p_detail, '')), ''), trim(p_summary)),
    trim(p_summary), p_category, p_urgency, 'open',
    false,
    now(), auth.uid()           -- raised deliberately by someone who may dispatch: reviewed
  )
  returning id into v_id;

  if p_vendor_id is not null then
    if not exists (select 1 from vendors where id = p_vendor_id and org_id = v_org) then
      raise exception 'that contractor is not on this organisation';
    end if;

    update tickets
       set assigned_vendor_id = p_vendor_id,
           assigned_by = auth.uid(),
           assigned_at = now(),
           status = 'assigned'
     where id = v_id;

    perform notify_user(
      v.user_id, 'assignment', 'A job has been assigned to you',
      'Open it to acknowledge and get started.',
      '/dashboard/tickets/' || v_id::text, 'ticket', v_id
    )
    from vendors v
    where v.id = p_vendor_id and v.user_id is not null;
  end if;

  return v_id;
end;
$$;

comment on function raise_work_order is
  'An FM/PM raises work themselves -- planned maintenance, an inspection finding -- optionally dispatching it in the same step. sender_id stays NULL because there is no reporter, property_id is required, scoped by current_user_property_ids(). Stamps reviewed_at/reviewed_by on creation (0178): raising it themselves IS the review.';
