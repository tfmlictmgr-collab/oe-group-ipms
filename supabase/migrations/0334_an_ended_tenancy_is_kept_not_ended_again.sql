-- An ended tenancy's refusal names no remedy it cannot use (10 Oct 2026).
--
-- 0332's `guard_lease_soft_delete` refuses a signed-in caller deleting any
-- tenancy but a draft, with one sentence for every status: "End it with End
-- tenancy instead." For an active or renewed tenancy that is the remedy
-- (`end_tenancy` takes both). For an expired or terminated one it is not:
-- `end_tenancy` refuses anything but active/renewed, so the message pointed at
-- a button that would refuse them too. An ended tenancy is kept, and the
-- message now says so.
--
-- Only the message changes. The rule (only a draft is deleted; nothing deleted
-- is restored), the trigger and the grants are 0332's, untouched. The live
-- tenancy's sentence is kept word for word, since verify-entry-corrections §F
-- and verify-lease-transition-scope §E match it.
--
-- Rebuilt from the live catalogue through a swap that refuses unless it
-- matches exactly once (0183), CR-free on both sides (0317), with grants
-- asserted unchanged. No colon in either message (decision 52's cut).

set local lock_timeout = '5s';

do $$
declare
  fn regprocedure := 'public.guard_lease_soft_delete()'::regprocedure;
  d text;
  acl_before text;
  -- Anchored on the statement, not the lines around it. The first draft of
  -- this swap matched indented lines and the live body's layout differed from
  -- 0332's file on dev and staging, so the swap refused, correctly. The
  -- statement is the same whatever the indentation.
  o text := $o$raise exception 'A tenancy that has been live is a record and cannot be deleted. End it with End tenancy instead.';$o$;
  n text := $n$if old.status in ('active', 'renewed') then
        raise exception 'A tenancy that has been live is a record and cannot be deleted. End it with End tenancy instead.';
      end if;
      -- 0334. Expired or terminated, so End tenancy would refuse it too.
      raise exception 'This tenancy has ended and is kept as part of the record, so it cannot be deleted.';$n$;
begin
  select replace(pg_get_functiondef(p.oid), E'\r', ''), p.proacl::text
    into d, acl_before
    from pg_proc p where p.oid = fn;
  -- The new sentence must be absent (the swap's own output contains `o` once,
  -- so the count alone would let it run twice) and `o` present exactly once.
  if position('has ended and is kept as part of the record' in d) > 0 then
    raise exception '0334 guard_lease_soft_delete — already carries the ended-tenancy refusal';
  end if;
  if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then
    raise exception '0334 guard_lease_soft_delete — expected its deletion refusal exactly once';
  end if;
  execute replace(d, o, n);
  if (select p.proacl::text from pg_proc p where p.oid = fn) is distinct from acl_before then
    raise exception '0334 guard_lease_soft_delete — grants changed by the rebuild';
  end if;
end $$;

-- ── Assertions ─────────────────────────────────────────────────────────────
do $$
declare
  s text := (select prosrc from pg_proc where oid = 'public.guard_lease_soft_delete()'::regprocedure);
begin
  if s not like '%auth.uid() is null%'
     or s not like '%old.status <> ''draft''%'
     or s not like '%A deleted tenancy cannot be restored%'
     or s not like '%End it with End tenancy instead%'
     or s not like '%has ended and is kept as part of the record%' then
    raise exception '0334 guard_lease_soft_delete lost a clause in the rebuild';
  end if;
  if s ~ 'raise exception ''([^'']|'''')*:' then
    raise exception '0334 a refusal message contains a colon';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.leases'::regclass
                   and tgname = 'leases_guard_soft_delete' and not tgisinternal) then
    raise exception '0334 leases_guard_soft_delete is missing';
  end if;
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name = 'guard_lease_soft_delete'
                and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) then
    raise exception '0334 the lease guard is executable by a client role';
  end if;
end $$;
