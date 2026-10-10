-- A tenancy is billed, activated, renewed and ended only on a building the
-- caller manages, and its status moves only through the functions that keep
-- the unit in step with it (measured on staging, 9 Oct 2026).
--
-- Two findings:
--
--   1. `raise_rent_charge`, `activate_lease`, `end_tenancy` and `renew_lease`
--      are SECURITY DEFINER and, for a signed-in caller, checked only the org
--      and `has_permission('leases.write')`. DEFINER bypasses `leases_write`
--      (0090), so the policy's place clause — oversight, or a property in
--      `current_user_property_ids()` — was never applied. A property manager
--      or regional manager holding leases.write could bill rent on, activate,
--      renew or end a tenancy in a building they do not manage. `correct_lease_
--      terms` and `correct_rent_charge` (0329) already restate the clause; these
--      four were written before it was needed and never re-read (decision 24).
--      Each now restates it, in the same words 0329 uses, including the Owner
--      Rep refusal.
--
--   2. `authenticated` holds UPDATE on every `leases` column and `leases_write`
--      admits the letting desk, so `update leases set status = 'active'` over
--      PostgREST moved a draft live WITHOUT `activate_lease()` — the unit's
--      occupant was never set, which is decision 22's "occupancy and tenancy
--      disagreeing" produced by a direct write. The same was true of ending one
--      (the occupant never cleared) and of INSERTing a lease straight in as
--      `active`. 0329's `guard_live_lease_terms` guards the money and the term
--      on a live lease; the status itself was unguarded.
--
--      `guard_lease_status_transition` refuses a status change (or a non-draft
--      insert) by a signed-in caller unless the owning function has set the
--      transaction-local flag `app.lease_transition` — 0315's `app.sc_budget_
--      void` and 0329's `app.lease_correction`, a third time. The flag names
--      the lease it is for, so it cannot be borrowed for another row:
--        • `activate_lease`, `end_tenancy`: the lease's own id;
--        • `renew_lease`: the OLD lease's id, which the successor carries as
--          `renewed_from_lease_id` — the one INSERT that may be born live;
--        • `expire_due_leases`, run by hand by an administrator: `expire:<org>`,
--          and only for a move to `expired`.
--      With no signed-in caller (the service role, the daily expiry job) the
--      guard stands aside, exactly as 0329's does: every such caller is a
--      function stating its own rules. `import_tenancies` is SECURITY INVOKER,
--      inserts drafts and activates through `activate_lease`, so it passes
--      unchanged.
--
-- Rebuilt from the live catalogue through swaps that refuse unless they match
-- exactly once (0183), CR-free on both sides (0317), with grants asserted
-- unchanged.

set local lock_timeout = '5s';

-- ── 0. Swap helper (this transaction only) ─────────────────────────────────
create or replace function pg_temp.swap_fn(p_fn regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare
  d text;
  acl_before text;
  o text := replace(p_old, E'\r', '');
  n text := replace(p_new, E'\r', '');
begin
  select replace(pg_get_functiondef(p.oid), E'\r', ''), p.proacl::text
    into d, acl_before from pg_proc p where p.oid = p_fn;
  if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then
    raise exception '0330: % — expected the text to swap exactly once', p_fn;
  end if;
  execute replace(d, o, n);
  if (select p.proacl::text from pg_proc p where p.oid = p_fn) is distinct from acl_before then
    raise exception '0330: % — grants changed by the rebuild', p_fn;
  end if;
end $$;

-- ── 1. The place clause ────────────────────────────────────────────────────
select pg_temp.swap_fn('public.raise_rent_charge(uuid, date, date, date)'::regprocedure,
$o$      raise exception 'you do not have permission to bill rent';
    end if;$o$,
$n$      raise exception 'you do not have permission to bill rent';
    end if;
    -- 0330. `leases_write`'s place clause, restated because DEFINER bypasses it.
    if caller_is_owner_rep()
       or not (current_user_role() = any (oversight_roles())
               or l.property_id in (select current_user_property_ids())) then
      raise exception 'you do not manage the property this tenancy is on, so you cannot bill rent on it';
    end if;$n$);

select pg_temp.swap_fn('public.activate_lease(uuid)'::regprocedure,
$o$      raise exception 'you do not have permission to activate a lease';
    end if;$o$,
$n$      raise exception 'you do not have permission to activate a lease';
    end if;
    -- 0330. `leases_write`'s place clause, restated because DEFINER bypasses it.
    if caller_is_owner_rep()
       or not (current_user_role() = any (oversight_roles())
               or l.property_id in (select current_user_property_ids())) then
      raise exception 'you do not manage the property this tenancy is on, so you cannot activate it';
    end if;$n$);

select pg_temp.swap_fn('public.end_tenancy(uuid, text)'::regprocedure,
$o$      raise exception 'you do not have permission to end a tenancy';
    end if;$o$,
$n$      raise exception 'you do not have permission to end a tenancy';
    end if;
    -- 0330. `leases_write`'s place clause, restated because DEFINER bypasses it.
    if caller_is_owner_rep()
       or not (current_user_role() = any (oversight_roles())
               or l.property_id in (select current_user_property_ids())) then
      raise exception 'you do not manage the property this tenancy is on, so you cannot end it';
    end if;$n$);

select pg_temp.swap_fn('public.renew_lease(uuid, integer)'::regprocedure,
$o$      raise exception 'you do not have permission to renew a lease';
    end if;$o$,
$n$      raise exception 'you do not have permission to renew a lease';
    end if;
    -- 0330. `leases_write`'s place clause, restated because DEFINER bypasses it.
    if caller_is_owner_rep()
       or not (current_user_role() = any (oversight_roles())
               or l.property_id in (select current_user_property_ids())) then
      raise exception 'you do not manage the property this tenancy is on, so you cannot renew it';
    end if;$n$);

-- ── 2. Each status write carries the flag for its own row ──────────────────
select pg_temp.swap_fn('public.activate_lease(uuid)'::regprocedure,
$o$  update leases set status = 'active' where id = p_lease_id;$o$,
$n$  perform set_config('app.lease_transition', l.id::text, true);
  update leases set status = 'active' where id = p_lease_id;
  perform set_config('app.lease_transition', '', true);$n$);

select pg_temp.swap_fn('public.end_tenancy(uuid, text)'::regprocedure,
$o$  update leases set status = v_status where id = p_lease_id;$o$,
$n$  perform set_config('app.lease_transition', l.id::text, true);
  update leases set status = v_status where id = p_lease_id;
  perform set_config('app.lease_transition', '', true);$n$);

-- The old term's status AND the successor's live insert, which carries the old
-- id as renewed_from_lease_id: one flag, both rows.
select pg_temp.swap_fn('public.renew_lease(uuid, integer)'::regprocedure,
$o$  update leases set status = 'renewed' where id = p_lease_id;$o$,
$n$  perform set_config('app.lease_transition', l.id::text, true);
  update leases set status = 'renewed' where id = p_lease_id;$n$);

select pg_temp.swap_fn('public.renew_lease(uuid, integer)'::regprocedure,
$o$  returning id into v_new;$o$,
$n$  returning id into v_new;
  perform set_config('app.lease_transition', '', true);$n$);

select pg_temp.swap_fn('public.expire_due_leases(uuid)'::regprocedure,
$o$  with due as ($o$,
$n$  perform set_config('app.lease_transition', 'expire:' || p_org_id::text, true);
  with due as ($n$);

select pg_temp.swap_fn('public.expire_due_leases(uuid)'::regprocedure,
$o$  select count(*) into v_count from due;$o$,
$n$  select count(*) into v_count from due;
  perform set_config('app.lease_transition', '', true);$n$);

-- ── 3. The guard ───────────────────────────────────────────────────────────
create or replace function guard_lease_status_transition()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_flag text := coalesce(current_setting('app.lease_transition', true), '');
begin
  -- The service role and system jobs (no signed-in caller) are not this
  -- guard's subject; every function they call states its own rules (0329).
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'draft'
       or (new.renewed_from_lease_id is not null and v_flag = new.renewed_from_lease_id::text) then
      return new;
    end if;
    raise exception 'A tenancy is recorded as a draft and made live with Activate, which also records who lives in the unit.';
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if v_flag = old.id::text
     or (v_flag = 'expire:' || old.org_id::text and new.status = 'expired') then
    return new;
  end if;

  raise exception 'A tenancy''s status changes only through Activate, Renew or End tenancy, which keep the unit''s occupant in step with it.';
end $$;

revoke all on function guard_lease_status_transition() from public, anon, authenticated, service_role;

comment on function guard_lease_status_transition() is
  'Refuses a lease status change, or a non-draft insert, by a signed-in caller unless activate_lease / end_tenancy / renew_lease / expire_due_leases set app.lease_transition for that row. 0330.';

drop trigger if exists leases_guard_status_transition on leases;
create trigger leases_guard_status_transition
  before insert or update of status on leases
  for each row execute function guard_lease_status_transition();

-- ── 4. Assertions ──────────────────────────────────────────────────────────
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as fn, p.prosrc
      from pg_proc p
     where p.oid in ('public.raise_rent_charge(uuid, date, date, date)'::regprocedure,
                     'public.activate_lease(uuid)'::regprocedure,
                     'public.end_tenancy(uuid, text)'::regprocedure,
                     'public.renew_lease(uuid, integer)'::regprocedure)
  loop
    if f.prosrc not like '%current_user_property_ids()%'
       or f.prosrc not like '%oversight_roles()%'
       or f.prosrc not like '%caller_is_owner_rep()%'
       or f.prosrc not like '%has_permission(''leases.write'')%'
       or f.prosrc not like '%current_user_org_id()%' then
      raise exception '0330: % lost a clause of its access check', f.fn;
    end if;
  end loop;

  -- Every definer that writes a lease's status sets the flag, and clears it.
  for f in
    select p.oid::regprocedure as fn, p.prosrc
      from pg_proc p
     where p.oid in ('public.activate_lease(uuid)'::regprocedure,
                     'public.end_tenancy(uuid, text)'::regprocedure,
                     'public.renew_lease(uuid, integer)'::regprocedure,
                     'public.expire_due_leases(uuid)'::regprocedure)
  loop
    if (length(f.prosrc) - length(replace(f.prosrc, 'app.lease_transition', '')))
         / length('app.lease_transition') <> 2 then
      raise exception '0330: % does not set and clear app.lease_transition exactly once', f.fn;
    end if;
  end loop;

  -- 0329's tenancy guard is untouched.
  if not exists (select 1 from pg_trigger where tgrelid = 'public.leases'::regclass
                   and tgname = 'leases_guard_live_terms' and not tgisinternal) then
    raise exception '0330: leases_guard_live_terms is missing';
  end if;

  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name = 'guard_lease_status_transition'
                and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) then
    raise exception '0330: the lease status guard is executable by a client role';
  end if;

  -- The rebuilt functions keep exactly the grants they had: signed-in users
  -- and the service role (the jobs), never anon.
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name in ('raise_rent_charge', 'activate_lease', 'end_tenancy',
                                     'renew_lease', 'expire_due_leases')
                and grantee in ('PUBLIC', 'anon')) then
    raise exception '0330: a lease function is callable anonymously';
  end if;
end $$;
