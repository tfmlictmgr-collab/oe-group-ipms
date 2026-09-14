-- The approval chain's levers have a switch (7 Sept 2026).
--
-- Reported from the live OEA portal as "the tier system seems to be blocking
-- the payment officer — can it be turned off?"
--
-- ⚠️ It is already off. `0261` (board, 5 Sept 2026) made the amount BANDS
-- opt-in and defaulted `orgs.approval_tiers_enabled` to false for every
-- organisation; `0248` did the same for the chain SHAPE. Measured on both
-- worlds reachable from a developer machine, all five organisations on each
-- read `bands=false, shape=(null → from brand)`. So the answer to "can it be
-- turned off" is that it ships off — and the reason nobody could confirm that,
-- or change it, is this:
--
--     grep -rn "operator_set_approval_tiers|operator_set_approval_chain" app lib
--     → no matches
--
-- **Both functions shipped with no screen.** An operator administrator cannot
-- pull either lever through the product; it takes a SQL client and this
-- repository's credentials. That is decision 26's `hierarchy.write` for the
-- third time — "recorded 29 July 2026, never implemented, and nothing failed
-- loudly" — and `0216`'s compliance declaration for the second: a control the
-- board decided, present in the database, absent from every screen, discovered
-- only when somebody tried to use it.
--
-- 📌 And a control nobody can reach is worse than one that does not exist,
-- because the org's own administrator then reads the ladder as unchangeable
-- and starts asking for the CODE to be changed instead — which is exactly how
-- a hardwired control (decision 7) ends up being argued away in a hurry.
--
-- ── What this migration does, and deliberately does not ───────────────────
--
-- The two setters are untouched: `operator_set_approval_chain` (0248) and
-- `operator_set_approval_tiers` (0261) already gate on
-- `caller_is_operator_admin()`, already write their own audit row in words an
-- auditor reads, and already refuse an unknown shape. Nothing about WHO may
-- set these changes here, and neither column joins any org-writable grant —
-- decision 7 keeps payment approval off the org's own settings form, and
-- decision 23 took `delivery_brand` out of that allowlist the moment it began
-- choosing a ladder.
--
-- What was missing is READING them. `operator_org_directory()` returns every
-- other operator-governed field on an organisation — slug, custom domain,
-- brand, retired — and not these two, so the operator screen could offer a
-- control with no way to show its current position. Extended rather than
-- joined alongside: decision 8's "one resolver, extended", and the reason the
-- gate stays `caller_is_operator_admin()` inside the query is `0085`'s — a
-- brand administrator receives an EMPTY SET rather than a refusal, because a
-- refusal confirms there is something worth refusing.
--
-- Body is `pg_get_functiondef` output with two columns added (0183).
--
-- ⚠️ DROPPED first, because `create or replace` cannot change a function's
-- return type and this one gains two columns — "cannot change return type of
-- existing function". A drop-and-create is not a replace: it creates a NEW
-- object, so Supabase's default privileges apply to it in full and the revoke
-- below is doing real work rather than restating a state. That is the exact
-- shape `verify-property-statement` was extended to catch after a drop-and-
-- create silently re-opened an anon read (decision 25).
drop function if exists operator_org_directory();

create or replace function operator_org_directory()
returns table(
  id uuid, name text, portal_name text, slug text, custom_domain text,
  logo_url text, theme_primary text, theme_logo_text text,
  delivery_brand delivery_brand, is_platform_operator boolean, retired boolean,
  member_count bigint, property_count bigint,
  approval_chain_shape text, approval_tiers_enabled boolean
)
language sql stable security definer set search_path = public as $function$
  select
    o.id, o.name, o.portal_name, o.slug, o.custom_domain, o.logo_url,
    o.theme_primary, o.theme_logo_text, o.delivery_brand,
    o.is_platform_operator,
    o.deleted_at is not null as retired,
    (select count(*) from users u
      where u.org_id = o.id and u.deactivated_at is null)      as member_count,
    (select count(*) from properties p
      where p.org_id = o.id and p.deleted_at is null)          as property_count,
    -- 0268. NULL is a real answer and is rendered as one: it means "derive from
    -- the brand", which is what every organisation reads today and is why 0248
    -- was behaviour-preserving by construction rather than by inspection.
    o.approval_chain_shape,
    o.approval_tiers_enabled
  from orgs o
  where caller_is_operator_admin()
  order by o.deleted_at nulls first, o.name;
$function$;

comment on function operator_org_directory is
  'Every organisation on the platform, for the operator launcher, gated on caller_is_operator_admin() INSIDE the query so a brand administrator gets an empty set rather than a refusal (0085). Carries the approval chain shape and whether its bands apply (0268) — those were operator-set from 0248/0261 and readable on no screen, so the levers existed and could not be pulled.';

-- ⚠️ `create or replace` re-applies Supabase''s default grants. Fourth
-- recurrence recorded in 0264; `authenticated` is the half the anon-shaped
-- reflex misses, and this function is READ BY authenticated operators, so it
-- is granted deliberately rather than left to a default.
revoke all on function operator_org_directory() from public, anon;
grant execute on function operator_org_directory() to authenticated, service_role;

-- ── The two setters keep the door they already had ────────────────────────
--
-- Re-stated, not changed: a screen calling them is new, so this is the moment
-- their grants are worth asserting rather than assumed.
do $$
declare v_bad text;
begin
  select string_agg(distinct routine_name || ' → ' || grantee, ', ')
    into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public'
     and grantee in ('anon', 'PUBLIC')
     and routine_name in ('operator_set_approval_chain', 'operator_set_approval_tiers',
                          'operator_org_directory');
  if v_bad is not null then
    raise exception 'these are callable by anon or PUBLIC and must not be: %', v_bad;
  end if;
end $$;

-- ── And the columns stay off every org-writable grant ─────────────────────
--
-- 0248 and 0261 each assert this for their own column. Asserted again here
-- because THIS migration is the one that puts a control for them on a screen,
-- and "the operator has a switch" must not quietly become "the org does".
do $$
declare v_bad text;
begin
  select string_agg(distinct column_name || ' → ' || grantee, ', ')
    into v_bad
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'orgs'
     and privilege_type = 'UPDATE'
     and grantee in ('authenticated', 'anon', 'PUBLIC')
     and column_name in ('approval_chain_shape', 'approval_tiers_enabled');
  if v_bad is not null then
    raise exception
      'the approval ladder must not be writable by an organisation''s own roles: %', v_bad;
  end if;
end $$;
