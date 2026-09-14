-- A vendor company is not a single login.
--
-- `vendors.user_id` (0001) is one nullable FK, and every vendor-side permission
-- in this system has been `vendors.user_id = auth.uid()` ever since — in the
-- live definitions of tickets_select (0064), tickets_update (0052),
-- payments_select and remittances_select (0157), vendor_evaluations_select
-- (0078a), payout_recipients_select (0072a), evaluation_responses_select
-- (0104), vendors_select (0052), and in decline_work_order /
-- complete_work_order (0118), submit_vendor_invoice (0162) and
-- vendor_invoiceable_jobs (0161).
--
-- That is fine for a one-man contractor and wrong for every vendor with staff:
-- the cleaner who actually does the job, the office manager who raises the
-- invoice and the director who signs the contract are three people sharing one
-- password, which is the same as having no attribution at all on the vendor
-- side of a payment chain we otherwise attribute obsessively (0142: "the one
-- action that moves real money had been the one action with no attributable
-- actor").
--
-- ⚠️ There is a live defect in the same place, and it is why this could not be
-- deferred. `accept_invitation` (live in 0153) ends with:
--
--     if inv.vendor_id is not null then
--       update vendors set user_id = v_uid where id = inv.vendor_id ...
--
-- Inviting a SECOND person to an existing vendor therefore does not add them —
-- it silently overwrites the first person's login, and the original user keeps
-- a `role = 'vendor'` account attached to no vendor at all. That is exactly the
-- broken state 0116 was written to prevent, arrived at from the other
-- direction: 0116 stopped a vendor invitation with no company, and nothing
-- stopped a second invitation from evicting the company's existing one.
--
-- ── What this does NOT do ─────────────────────────────────────────────────
-- It does not add a second scoping mechanism. `current_user_vendor_ids()` is
-- the vendor-side twin of `current_user_property_ids()` and every site above is
-- rewritten to call it, per the standing rule (CLAUDE.md decision 8): one
-- resolver, extended — never two.
--
-- It does not touch the permission matrix (0050). That matrix governs OE
-- GROUP's own staff roles and is operator-only to edit (decision 7). A vendor
-- deciding which of their own staff may raise an invoice is one level below it
-- and must never share its control surface — a vendor must not be able to
-- reach, or appear on, the screen that governs OE Group. The four vendor
-- capabilities below are fixed by this migration and are not configurable by
-- anyone, which is the same posture `capabilities.locked` already takes.

-- ── The four capabilities ─────────────────────────────────────────────────
--
-- Fixed, deliberately small, and named for what the vendor's own staff actually
-- do. Note what is NOT here: nothing about bank details. A vendor changing
-- where their money is sent is not a vendor-side permission at all — see 0164.
create type vendor_capability as enum (
  'manage_users',      -- invite and remove this company's other logins
  'manage_profile',    -- edit the company profile and its registration pack
  'manage_work',       -- accept/decline/complete jobs, submit invoices
  'manage_contracts'   -- read and accept contracts
);

comment on type vendor_capability is
  'What one of a vendor company''s logins may do, within that company only. Fixed by migration and not configurable — a vendor inventing new permission types is how a permission system stops meaning anything.';

-- ── Membership ────────────────────────────────────────────────────────────
create table vendor_users (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id)    on delete cascade,
  vendor_id  uuid not null references vendors(id) on delete cascade,
  user_id    uuid not null references users(id)   on delete cascade,

  -- The company's principal. Holds every capability implicitly and cannot be
  -- the last one removed (trigger below) — a vendor with no owner is a company
  -- nobody can administer, which is a support call, not a state.
  is_owner   boolean not null default false,
  capabilities vendor_capability[] not null default '{}',

  invited_by uuid references users(id),
  created_at timestamptz not null default now(),

  -- One person, one vendor company. `users` is already org-scoped (0001), so
  -- this is not a limitation across brands: the same human working for the same
  -- company under both TFML and OEA has two user rows by construction, and 0165
  -- is what stops that meaning two registration packs.
  constraint vendor_users_one_company_per_person unique (user_id),

  -- A non-owner with no capabilities is a login that can do nothing. Refused at
  -- the point of creation rather than discovered by the person who cannot work.
  constraint vendor_users_can_do_something
    check (is_owner or cardinality(capabilities) > 0)
);

create index vendor_users_vendor_idx on vendor_users (vendor_id);
create index vendor_users_org_idx    on vendor_users (org_id);

comment on table vendor_users is
  'The logins belonging to one vendor company. Replaces vendors.user_id as the thing every vendor-side policy resolves through — see current_user_vendor_ids().';

-- Org consistency, checked rather than assumed. The same defect shape 0144
-- closed for ticket assignment: three tables carrying org_id and nothing
-- requiring them to agree.
create or replace function vendor_users_org_matches()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_vendor_org uuid; v_user_org uuid;
begin
  select org_id into v_vendor_org from vendors where id = new.vendor_id;
  select org_id into v_user_org   from users   where id = new.user_id;

  if v_vendor_org is distinct from new.org_id then
    raise exception 'that vendor belongs to another organisation';
  end if;
  if v_user_org is distinct from new.org_id then
    raise exception 'that person belongs to another organisation';
  end if;
  return new;
end;
$$;

create trigger vendor_users_org_matches
  before insert or update on vendor_users
  for each row execute function vendor_users_org_matches();

-- A company keeps at least one owner. Checked on the way out, so the refusal
-- names the reason instead of leaving an unadministrable vendor behind.
create or replace function vendor_users_keep_an_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (TG_OP = 'DELETE' and old.is_owner)
     or (TG_OP = 'UPDATE' and old.is_owner and not new.is_owner) then
    if not exists (
      select 1 from vendor_users
       where vendor_id = old.vendor_id and is_owner and id <> old.id
    ) then
      raise exception 'a vendor company must keep at least one owner — appoint another before removing this one';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger vendor_users_keep_an_owner
  before update or delete on vendor_users
  for each row execute function vendor_users_keep_an_owner();

create trigger audit_vendor_users_write
  after insert or update or delete on vendor_users
  for each row execute function log_audit('vendor_user.write');

-- ── Backfill ──────────────────────────────────────────────────────────────
--
-- Every existing vendor login becomes the owner of its company, so nobody loses
-- access at deploy time and no application code has to change before the
-- policies below start reading the new table.
insert into vendor_users (org_id, vendor_id, user_id, is_owner, capabilities)
select v.org_id, v.id, v.user_id, true,
       enum_range(null::vendor_capability)
  from vendors v
 where v.user_id is not null
   and exists (select 1 from users u where u.id = v.user_id and u.org_id = v.org_id)
on conflict (user_id) do nothing;

comment on column vendors.user_id is
  'The company''s FIRST login, kept for continuity and set once. It is no longer how access is decided — vendor_users is, resolved by current_user_vendor_ids(). Do not add new checks against this column.';

-- ── The resolver ──────────────────────────────────────────────────────────
--
-- Used inside RLS, so it must be cheap and must never error. The union with
-- `vendors.user_id` is deliberate belt-and-braces: a seed script or a service
-- role write that sets the old column still resolves, rather than producing a
-- login that silently sees nothing (the 0116 failure mode again).
create or replace function current_user_vendor_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select vu.vendor_id from vendor_users vu where vu.user_id = auth.uid()
  union
  select v.id from vendors v where v.user_id = auth.uid();
$$;

revoke all on function current_user_vendor_ids() from public, anon;
grant execute on function current_user_vendor_ids() to authenticated, service_role;

comment on function current_user_vendor_ids is
  'The vendor companies the caller is a login for. The vendor-side twin of current_user_property_ids(): one resolver every vendor policy goes through, so adding a colleague needs no policy change.';

-- The single-value form, for the plpgsql functions that need "which company is
-- this". plpgsql rather than sql because ambiguity here should stop, not pick:
-- a person resolving to two companies would otherwise invoice from whichever
-- one the planner happened to return first.
create or replace function current_user_vendor_id()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_ids uuid[];
begin
  select array(select current_user_vendor_ids()) into v_ids;
  if cardinality(v_ids) = 0 then return null; end if;
  if cardinality(v_ids) > 1 then
    raise exception 'this login is attached to more than one vendor company; the organisation must resolve that before it can act as either';
  end if;
  return v_ids[1];
end;
$$;

revoke all on function current_user_vendor_id() from public, anon;
grant execute on function current_user_vendor_id() to authenticated, service_role;

-- What this login may do inside its own company. Denies on anything unknown or
-- absent, exactly as has_permission() does (0050) — a permission check that
-- fails open is not a permission check.
create or replace function vendor_user_can(p_capability vendor_capability)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from vendor_users vu
     where vu.user_id = auth.uid()
       and (vu.is_owner or p_capability = any (vu.capabilities))
  )
  -- A legacy primary login that has not been backfilled holds everything, so
  -- this migration cannot take away access somebody had this morning.
  or exists (select 1 from vendors v where v.user_id = auth.uid());
$$;

revoke all on function vendor_user_can(vendor_capability) from public, anon;
grant execute on function vendor_user_can(vendor_capability) to authenticated, service_role;

-- ── Who may see the membership list ───────────────────────────────────────
alter table vendor_users enable row level security;

-- Your own company's people, or staff who may read vendors.
create policy vendor_users_select on vendor_users for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      vendor_id in (select current_user_vendor_ids())
      or (select has_permission('vendors.read'))
    )
  );

-- Removing a colleague. Adding one is not an INSERT — it is an invitation
-- (below), because a membership row for a person who has never signed in would
-- be a login that does not exist.
create policy vendor_users_delete on vendor_users for delete to authenticated
  using (
    org_id = current_user_org_id()
    and (
      (vendor_id in (select current_user_vendor_ids()) and vendor_user_can('manage_users'))
      or (select has_permission('vendors.write'))
    )
  );

-- Changing what a colleague may do. `is_owner` is deliberately NOT settable
-- from here — see vendor_users_update_is_capabilities_only below.
create policy vendor_users_update on vendor_users for update to authenticated
  using (
    org_id = current_user_org_id()
    and (
      (vendor_id in (select current_user_vendor_ids()) and vendor_user_can('manage_users'))
      or (select has_permission('vendors.write'))
    )
  )
  with check (org_id = current_user_org_id());

-- No INSERT policy for anyone: membership is created only by accept_invitation
-- (SECURITY DEFINER), so a row can never exist for a person who never redeemed
-- an invitation. Same reasoning as 0021 keeping applicants out of `vendors`.

-- Ownership is not self-service. A `manage_users` holder promoting themselves
-- to owner, or demoting the owner, is privilege escalation inside the company;
-- it is an OE Group staff action, through the vendor record.
create or replace function vendor_users_update_is_capabilities_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_owner is distinct from old.is_owner
     and not coalesce((select has_permission('vendors.write')), false) then
    raise exception 'only the managing organisation can change who owns a vendor account';
  end if;
  if new.vendor_id is distinct from old.vendor_id
     or new.user_id is distinct from old.user_id
     or new.org_id is distinct from old.org_id then
    raise exception 'a membership cannot be moved to another person, company or organisation';
  end if;
  return new;
end;
$$;

create trigger vendor_users_update_is_capabilities_only
  before update on vendor_users
  for each row execute function vendor_users_update_is_capabilities_only();

-- ── Inviting a colleague ──────────────────────────────────────────────────
--
-- Reusing `invitations` rather than building a parallel invite: the token
-- hashing, expiry, single use, revocation and email-match check in 0020 are the
-- parts that are easy to get wrong, and 0116 already requires a vendor
-- invitation to name its company.
alter table invitations
  add column if not exists vendor_capabilities vendor_capability[] not null default '{}';

comment on column invitations.vendor_capabilities is
  'What the invited vendor login may do once redeemed. Empty for a company''s first login, which becomes its owner.';

-- The vendor-side branch of invitations_insert. A SEPARATE policy, not an edit
-- of 0081's: permissive policies OR together, so this adds a door without
-- reopening one that took four migrations (0078c, 0078d, 0081) to get right.
-- It is airtight on its own, which is what a second permissive policy has to be.
create policy invitations_insert_by_vendor_user on invitations for insert to authenticated
  with check (
    org_id = current_user_org_id()
    and invited_by = auth.uid()
    -- Only a vendor login, only holding manage_users.
    and current_user_role() = 'vendor'
    and vendor_user_can('manage_users')
    -- Only into their OWN company, and only as a vendor. Every other scope an
    -- invitation can carry must be empty: this branch cannot attach properties,
    -- a hierarchy node, a unit, or an approval tier.
    and role = 'vendor'
    and vendor_id is not null
    and vendor_id in (select current_user_vendor_ids())
    and coalesce(cardinality(property_ids), 0) = 0
    and node_id is null
    and unit_id is null
    and approval_tier is null
    -- And they must say what the colleague may do. An empty set here would
    -- otherwise mint an owner, since that is what an empty set means on the
    -- company's first login.
    and cardinality(vendor_capabilities) > 0
  );

-- ── Acceptance, corrected ─────────────────────────────────────────────────
--
-- Rewritten from the LIVE definition (0153), per the 0136 lesson. The ONLY
-- change is the vendor branch: it now adds a membership instead of overwriting
-- `vendors.user_id`, and claims that column only when it is still empty.
create or replace function accept_invitation(
  p_token_hash text,
  p_full_name text default null::text,
  p_phone text default null::text,
  p_telegram_chat_id text default null::text,
  p_notify_whatsapp boolean default false,
  p_notify_sms boolean default false,
  p_notify_telegram boolean default false
)
returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare
  inv invitations%rowtype;
  v_uid uuid := auth.uid();
  v_email text;
  v_phone text := nullif(trim(p_phone), '');
  v_tg text := nullif(trim(p_telegram_chat_id), '');
  p uuid;
  v_first_login boolean;
begin
  if v_uid is null then
    raise exception 'you must be signed in to accept an invitation';
  end if;

  select * into inv from invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now()
  for update;

  if inv.id is null then
    raise exception 'this invitation is invalid, already used, or has expired';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if lower(v_email) is distinct from lower(inv.email) then
    raise exception 'this invitation was issued to a different email address';
  end if;

  if exists (select 1 from users where id = v_uid) then
    raise exception 'this account already belongs to an organisation';
  end if;

  insert into users (
    id, org_id, role, approval_tier, full_name, email, phone, telegram_chat_id,
    notify_email, notify_whatsapp, notify_sms, notify_telegram
  )
  values (
    v_uid, inv.org_id, inv.role, inv.approval_tier,
    coalesce(nullif(trim(p_full_name), ''), inv.full_name), inv.email,
    coalesce(v_phone, nullif(trim(inv.invite_phone), '')), v_tg,
    true,
    coalesce(p_notify_whatsapp, false) and coalesce(v_phone, nullif(trim(inv.invite_phone), '')) is not null,
    coalesce(p_notify_sms, false) and coalesce(v_phone, nullif(trim(inv.invite_phone), '')) is not null,
    coalesce(p_notify_telegram, false) and v_tg is not null
  );

  foreach p in array inv.property_ids loop
    insert into property_stakeholders (org_id, property_id, user_id, relation)
    values (inv.org_id, p, v_uid, inv.property_relation)
    on conflict (property_id, user_id, relation) do nothing;
  end loop;

  if inv.node_id is not null then
    insert into property_stakeholders (org_id, user_id, node_id, relation)
    values (inv.org_id, v_uid, inv.node_id, inv.property_relation)
    on conflict do nothing;
  end if;

  if inv.unit_id is not null then
    update units set occupant_user_id = v_uid
    where id = inv.unit_id and org_id = inv.org_id;
  end if;

  if inv.vendor_id is not null then
    -- The company's first login owns it; everyone after holds exactly what the
    -- invitation said. Previously this overwrote vendors.user_id, which evicted
    -- whoever already held the account.
    select not exists (select 1 from vendor_users where vendor_id = inv.vendor_id)
      into v_first_login;

    insert into vendor_users (org_id, vendor_id, user_id, is_owner, capabilities, invited_by)
    values (
      inv.org_id, inv.vendor_id, v_uid,
      v_first_login,
      case when v_first_login then enum_range(null::vendor_capability)
           else inv.vendor_capabilities end,
      inv.invited_by
    );

    -- Claim the legacy column only if nothing holds it. Set once, never stolen.
    update vendors set user_id = v_uid
     where id = inv.vendor_id and org_id = inv.org_id and user_id is null;
  end if;

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = v_uid
  where id = inv.id;

  perform notify_user(
    v_uid, 'system', 'Welcome aboard',
    'Your account is ready. You can change how we reach you in Settings.',
    '/dashboard'
  );

  return inv.org_id;
end;
$function$;

comment on function accept_invitation is
  'Creates the user from a pending invitation and applies every scope it carries — properties, region, unit, approval tier, and since 0163 a vendor MEMBERSHIP rather than a claim on vendors.user_id, which used to evict the company''s existing login.';

-- ── Every vendor-side policy, rewritten onto the resolver ─────────────────
--
-- Each is reproduced from its LIVE definition with one substitution:
--   `... in (select id from vendors where user_id = auth.uid())`
--     becomes
--   `... in (select current_user_vendor_ids())`
-- Nothing else changes. Rewriting from live rather than from the original is
-- the 0136 lesson: re-applying an older expression is how a policy quietly
-- loses a clause somebody added in between.

-- tickets_select — live in 0064.
drop policy if exists tickets_select on tickets;
create policy tickets_select on tickets for select
  using (
    org_id = current_user_org_id()
    and (
      sender_id = auth.uid()
      or assigned_to_user_id = auth.uid()
      or assigned_vendor_id in (select current_user_vendor_ids())
      or (select has_permission('tickets.read_all'))
      or property_id in (select current_user_property_ids())
      or (property_id is null and (select has_permission('tickets.triage_unassigned')))
    )
  );

-- tickets_update — live in 0052.
drop policy if exists tickets_update on tickets;
create policy tickets_update on tickets for update
  using (
    org_id = current_user_org_id()
    and (
      (select has_permission('tickets.assign'))
      or (select has_permission('tickets.close'))
      or assigned_to_user_id = auth.uid()
      or assigned_vendor_id in (select current_user_vendor_ids())
    )
  );

-- vendors_select — live in 0052.
drop policy if exists vendors_select on vendors;
create policy vendors_select on vendors for select
  using (
    org_id = current_user_org_id()
    and (id in (select current_user_vendor_ids()) or (select has_permission('vendors.read')))
  );

-- payments_select — live in 0157.
drop policy if exists payments_select on payments;
create policy payments_select on payments for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or current_user_role() = any (payment_chain_roles())
      or vendor_id in (select current_user_vendor_ids())
      or (
        current_user_role() = any (fm_roles())
        and vendor_id in (select current_user_scoped_vendor_ids())
      )
    )
  );

-- remittances_select — live in 0157.
drop policy if exists remittances_select on remittances;
create policy remittances_select on remittances for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or current_user_role() = any (payment_chain_roles())
      or recipient_id in (
        select payout_recipients.id from payout_recipients
         where payout_recipients.user_id = auth.uid()
            or payout_recipients.vendor_id in (select current_user_vendor_ids())
      )
    )
  );

-- payout_recipients_select — live in 0072a.
drop policy if exists payout_recipients_select on payout_recipients;
create policy payout_recipients_select on payout_recipients for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or user_id = auth.uid()
      or vendor_id in (select current_user_vendor_ids())
    )
  );

-- vendor_evaluations_select — live in 0078a.
drop policy if exists vendor_evaluations_select on vendor_evaluations;
create policy vendor_evaluations_select on vendor_evaluations for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or vendor_id in (select current_user_vendor_ids())
      or (
        current_user_role() = any (fm_roles())
        and vendor_id in (select current_user_scoped_vendor_ids())
      )
    )
  );

-- evaluation_responses_select — live in 0104.
drop policy if exists evaluation_responses_select on evaluation_responses;
create policy evaluation_responses_select on evaluation_responses for select
  using (
    org_id = current_user_org_id()
    and exists (
      select 1 from vendor_evaluations ve
       where ve.id = evaluation_responses.evaluation_id
         and (
           current_user_role() = any (oversight_roles())
           or ve.vendor_id in (select current_user_vendor_ids())
           or (current_user_role() = any (fm_roles())
               and ve.vendor_id in (select current_user_scoped_vendor_ids()))
         )
    )
  );

-- ── The vendor's own actions, rewritten and now capability-gated ──────────
--
-- Each reproduced from its live definition. Two changes: the standing check
-- resolves through the membership, and it additionally requires `manage_work`
-- — which is the point of the exercise. The colleague who was invited to read
-- contracts does not get to close jobs and raise invoices against them.

-- decline_work_order — live in 0118.
create or replace function decline_work_order(p_ticket_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  t tickets%rowtype;
begin
  select * into t from tickets where id = p_ticket_id;
  if t.id is null then raise exception 'that request could not be found'; end if;

  if t.assigned_vendor_id is null
     or t.assigned_vendor_id not in (select current_user_vendor_ids()) then
    raise exception 'only the vendor this job is assigned to can decline it';
  end if;
  if not vendor_user_can('manage_work') then
    raise exception 'your account is not set up to accept or decline jobs for this company';
  end if;

  if t.status in ('resolved', 'closed') then
    raise exception 'that job is already finished';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'give a reason of at least 10 characters so the team can re-assign it properly';
  end if;

  update tickets
     set assigned_vendor_id = null,
         assigned_to_user_id = null,
         assigned_at = null,
         acknowledged_at = null,
         status = 'open'
   where id = p_ticket_id;

  insert into ticket_messages (org_id, ticket_id, author, body)
  values (t.org_id, p_ticket_id,
          'system',
          'Declined by the assigned contractor: ' || trim(p_reason));

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

-- complete_work_order — live in 0118.
create or replace function complete_work_order(p_ticket_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  t tickets%rowtype;
begin
  select * into t from tickets where id = p_ticket_id;
  if t.id is null then raise exception 'that request could not be found'; end if;

  if t.assigned_vendor_id is null
     or t.assigned_vendor_id not in (select current_user_vendor_ids()) then
    raise exception 'only the vendor this job is assigned to can mark it complete';
  end if;
  if not vendor_user_can('manage_work') then
    raise exception 'your account is not set up to report work complete for this company';
  end if;

  if t.status in ('resolved', 'closed') then
    raise exception 'that job is already marked complete';
  end if;

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

-- submit_vendor_invoice — live in 0162.
create or replace function submit_vendor_invoice(
  p_amount numeric,
  p_invoice_reference text,
  p_ticket_id uuid default null::uuid,
  p_attachment_path text default null::text
)
returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare
  v_vendor vendors%rowtype;
  t tickets%rowtype;
  v_id uuid;
  v_path text := nullif(trim(coalesce(p_attachment_path, '')), '');
begin
  select * into v_vendor from vendors where id = current_user_vendor_id();
  if v_vendor.id is null then
    raise exception 'only a vendor can submit an invoice';
  end if;
  if not vendor_user_can('manage_work') then
    raise exception 'your account is not set up to submit invoices for this company';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'an invoice must be for a positive amount';
  end if;
  if length(trim(coalesce(p_invoice_reference, ''))) < 3 then
    raise exception 'give the invoice a reference of your own so you can reconcile it';
  end if;

  if p_ticket_id is not null then
    select * into t from tickets where id = p_ticket_id;
    if t.id is null or t.assigned_vendor_id is distinct from v_vendor.id then
      raise exception 'that job is not yours to invoice';
    end if;
    if t.status not in ('resolved', 'closed') then
      raise exception 'finish the job before invoicing for it';
    end if;
  end if;

  if p_ticket_id is not null and exists (
    select 1 from payments
     where ticket_id = p_ticket_id and status <> 'rejected'
  ) then
    raise exception 'an invoice for that job has already been submitted';
  end if;

  if v_path is not null and v_path !~ ('^' || v_vendor.org_id::text || '/') then
    raise exception 'that attachment does not belong to your organisation';
  end if;

  insert into payments (
    org_id, vendor_id, ticket_id, invoice_reference, amount, status, invoice_attachment_path
  ) values (
    v_vendor.org_id, v_vendor.id, p_ticket_id,
    trim(p_invoice_reference), p_amount, 'pending_verification', v_path
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
$function$;

-- vendor_invoiceable_jobs — live in 0161.
--
-- One substitution beyond the resolver: evidence is counted for the WHOLE
-- company, not only the caller. It was `a.uploaded_by = auth.uid()`, which was
-- the same thing when a company had one login and is now wrong — the cleaner
-- uploads the photo and the office manager raises the invoice, and the screen
-- would have told them the job had no evidence.
create or replace function vendor_invoiceable_jobs()
returns table (
  ticket_id uuid,
  summary text,
  resolved_at timestamptz,
  evidence_count bigint,
  ready boolean
)
language sql stable security definer set search_path = public as $$
  select
    t.id,
    coalesce(t.summary, left(t.message_text, 80)),
    t.resolved_at,
    count(a.id),
    count(a.id) > 0
  from tickets t
  left join ticket_attachments a
    on a.ticket_id = t.id
   and a.uploaded_by in (select vu.user_id from vendor_users vu
                          where vu.vendor_id = t.assigned_vendor_id)
  where t.assigned_vendor_id in (select current_user_vendor_ids())
    and t.status in ('resolved', 'closed')
    and not exists (
      select 1 from payments p where p.ticket_id = t.id and p.status <> 'rejected'
    )
  group by t.id, t.summary, t.message_text, t.resolved_at
  order by t.resolved_at desc nulls last;
$$;

revoke all on function vendor_invoiceable_jobs() from public, anon;
grant execute on function vendor_invoiceable_jobs() to authenticated, service_role;

grant select on vendor_users to authenticated;
grant update (capabilities), delete on vendor_users to authenticated;
grant all on vendor_users to service_role;
