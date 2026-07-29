-- A WhatsApp request that nobody operational can see.
--
-- Symptom: messages arrive, route to the right brand, and are answered on the
-- right number — but do not appear on the requests dashboard.
--
-- The webhook writes a ticket with `sender_id` and `property_id` both NULL: it
-- has a phone number, not a user, and no property. The select policy then grants
-- a reader the row on one of
--     sender_id = auth.uid()            -- NULL, never matches
--     assigned_to_user_id = auth.uid()  -- NULL, never matches
--     has_permission('tickets.read_all')
--     property_id in (current_user_property_ids())   -- NULL never matches an IN list
-- so ONLY `read_all` sees them. Admin and finance hold that; a Facility Manager,
-- an ops staffer and a property owner do not. Measured on the live data: TFML has
-- 13 chat requests and OEA 10, and every single one has no property. Both brands
-- happen to have only admin/finance accounts today, which is the only reason this
-- looked like it worked at all.
--
-- The same NULL-versus-IN-list shape that hides tenant applications from a
-- Property Manager. It is worth naming: **an optional foreign key used as a
-- security scope silently denies every row that has not got one yet.**
--
-- Two fixes, because there are two populations:
--   1. A sender we KNOW — resolve the phone to the user and their unit, so the
--      row carries an identity and a property, and B7's "Tenant: own requests"
--      finally means something for someone who wrote in on WhatsApp.
--   2. A sender we do NOT know — a stranger, a prospect, a passer-by. There is
--      nothing to resolve, so the request needs to be visible as *unassigned*
--      rather than invisible.

-- ── 1. Resolve a chat sender to a member of THAT org ───────────────────────
--
-- Org-scoped on purpose. Matching a phone across the whole table would attach a
-- TFML message to an OEA tenant who happens to share a number — the one thing
-- this system may never do.
create or replace function resolve_chat_sender(p_org_id uuid, p_sender_ref text)
returns table (user_id uuid, property_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare
  v_digits text;
  v_user   uuid;
  v_prop   uuid;
  v_n      integer;
begin
  -- Compare the last 10 digits. WhatsApp reports `2348064687440`; a profile may
  -- hold `+2348064687440` or the local `08064687440`. The last 10 digits are the
  -- part every Nigerian format agrees on.
  v_digits := right(regexp_replace(coalesce(p_sender_ref, ''), '\D', '', 'g'), 10);
  if length(v_digits) < 10 then
    return;                       -- too short to identify anyone safely
  end if;

  -- Counted and fetched separately rather than with an aggregate: Postgres has
  -- no min(uuid), and picking "the lowest id" would be a way of choosing between
  -- two people anyway, which is exactly what must not happen here.
  select count(*) into v_n
    from users u
   where u.org_id = p_org_id
     and u.phone is not null
     and right(regexp_replace(u.phone, '\D', '', 'g'), 10) = v_digits;

  -- Exactly one, or nobody. Two people sharing a number is not a licence to
  -- guess which of them is writing — an ambiguous match resolves to no match.
  if v_n <> 1 then
    return;
  end if;

  select u.id into v_user
    from users u
   where u.org_id = p_org_id
     and u.phone is not null
     and right(regexp_replace(u.phone, '\D', '', 'g'), 10) = v_digits;

  -- Their unit gives the property. Again exactly one: a tenant occupying two
  -- units gives no basis to file the request against either, so it stays
  -- unassigned and a human decides.
  select count(*) into v_n
    from units un
   where un.occupant_user_id = v_user
     and un.org_id = p_org_id
     and un.property_id is not null;

  if v_n = 1 then
    select un.property_id into v_prop
      from units un
     where un.occupant_user_id = v_user
       and un.org_id = p_org_id
       and un.property_id is not null;
  end if;

  return query select v_user, v_prop;
end;
$$;

revoke all on function resolve_chat_sender(uuid, text) from public;
grant execute on function resolve_chat_sender(uuid, text) to service_role;

comment on function resolve_chat_sender is
  'Maps a chat sender ref to a user in THAT org, and their property if they occupy exactly one unit. Ambiguity resolves to no match — guessing who wrote in is worse than leaving it unassigned.';

-- ── 2. Requests nobody has filed yet must still be visible ─────────────────
insert into capabilities (key, module, label, description, locked, sort_order) values
  ('tickets.triage_unassigned', 'Requests', 'See unassigned requests',
   'See requests that are not yet attached to a property — typically someone writing in on WhatsApp whose number we do not recognise. Does not grant access to any request that already belongs to a property.',
   false, 12)
on conflict (key) do nothing;

-- Default per locked decision 7: the most restrictive workable state.
--
-- ON for admin (who already reads everything) and facility_manager, who is the
-- role that triages and assigns — B7 gives them "All ops (RT)" on job cards, and
-- an unfiled request is the very start of ops work. OFF for everyone else,
-- including fm_ops_staff, whose B7 row is "Assigned (RT)": work reaches them by
-- being given to them, not by their browsing the inbox.
--
-- This grants sight of rows with NO property. It cannot widen access to any
-- request that belongs to one.
insert into role_permissions (org_id, role, capability, granted)
  select o.id, r.role, 'tickets.triage_unassigned',
         r.role in ('admin', 'facility_manager')
    from orgs o
    cross join (select unnest(array['tenant','vendor','fm_ops_staff','facility_manager',
                                    'finance_approver','property_owner','admin','viewer']::user_role[]) as role) r
on conflict (org_id, role, capability) do nothing;

-- ── 3. The policy, with one clause added ───────────────────────────────────
--
-- Every existing clause is unchanged, and each permission stays wrapped in a
-- scalar subquery so the planner still evaluates it once per query rather than
-- once per row (the 0052 lesson).
drop policy if exists tickets_select on tickets;
create policy tickets_select on tickets for select
  using (
    org_id = current_user_org_id()
    and (
      -- Identity, never revocable.
      sender_id = auth.uid()
      or assigned_to_user_id = auth.uid()
      or assigned_vendor_id in (select id from vendors where user_id = auth.uid())
      -- Privilege, governed.
      or (select has_permission('tickets.read_all'))
      or property_id in (select current_user_property_ids())
      -- Not yet filed against a property. Deliberately narrow: this clause can
      -- only ever admit rows where property_id IS NULL.
      or (property_id is null and (select has_permission('tickets.triage_unassigned')))
    )
  );

-- ── 4. Backfill what can be resolved ───────────────────────────────────────
--
-- Existing chat requests were written before the webhook could resolve anyone.
-- Only rows where the sender is genuinely a member of that org are touched;
-- everything else stays unassigned, which is the honest answer.
do $$
declare
  t record;
  r record;
  v_fixed integer := 0;
begin
  for t in
    select id, org_id, channel_sender_ref
      from tickets
     where channel in ('whatsapp', 'telegram')
       and sender_id is null
       and channel_sender_ref is not null
  loop
    select * into r from resolve_chat_sender(t.org_id, t.channel_sender_ref);
    if r.user_id is not null then
      update tickets
         set sender_id = r.user_id,
             property_id = coalesce(property_id, r.property_id)
       where id = t.id;
      v_fixed := v_fixed + 1;
    end if;
  end loop;
  raise notice 'resolved the sender on % existing chat request(s)', v_fixed;
end $$;
