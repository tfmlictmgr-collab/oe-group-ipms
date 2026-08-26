-- The portfolio was readable without a login.
--
-- 🚨 `property_summary` has never carried `security_invoker`. A plain view reads
-- its base tables with the VIEW OWNER's rights, so `properties` RLS never
-- applied to it — and Supabase's default grants hand `anon` SELECT on every
-- view in `public`. The two together mean:
--
--     curl "$SUPABASE_URL/rest/v1/property_summary?select=name,address" \
--          -H "apikey: $ANON_KEY"
--
-- returns **every property of every organisation** — name, reference, address,
-- type, unit count, occupancy and total apportionment factor — to a caller with
-- no account, no session and no invitation. On the dev world that is 20
-- properties across 4 orgs, TFML's and OEA's together.
--
-- ── Why this is the serious kind ──────────────────────────────────────────
-- B1 is not "a user must not see the other brand's data". It is "**or
-- existence**". Decision 12 refused to put a *grid of organisation icons* on a
-- public page for exactly this reason, and said any move to a public directory
-- "needs a recorded board exception to B1". This is that directory, published
-- unintentionally, with the addresses and occupancy attached, and reachable by
-- anyone holding the anon key that ships in the browser bundle of every portal.
--
-- ── This is the same defect audit 0729b-S2 already found next door ─────────
-- `property_application_windows` was fixed then, with the finding written as
-- "a plain view reads its base tables with the VIEW OWNER's rights — so
-- `properties` RLS never applied". `property_summary` is its sibling over the
-- same table and was not looked at. Neither was it in `0198` or `0200`, both of
-- which rebuilt this exact view and faithfully carried the omission forward. A
-- view is rebuilt by DROP and CREATE, and **the flag does not survive that** —
-- which is precisely how a protection gets lost without a line of code ever
-- being written to remove it.
--
-- 📌 The lesson generalises past this one view, so the second half of this
-- migration stops asking "which view leaked?" and starts asserting "no view
-- answers an anonymous caller at all" — 0185's "anything not in the allowed
-- set", applied to grants instead of roles.

-- ── 1. The view reads as its caller ───────────────────────────────────────
-- Not a rebuild: `alter view ... set` keeps the definition 0200 asserted
-- against and changes only the rights it reads with. `app/dashboard/properties`
-- already documents this as the behaviour it expects — "RLS still decides what
-- comes back: `properties.read_all` sees the org, everyone else sees the
-- properties they are attached to" — so this makes the comment true rather than
-- changing what the screen was meant to do.
alter view property_summary set (security_invoker = on);

comment on view property_summary is
  'Per-property rollup. security_invoker since 0202 - without it this view read `properties` with the owner''s rights and published every org''s portfolio to anon (B1). unit_count is unit ROWS, unit_total the units they stand for (equal since 0200), total_factor is occupied space x quantity, occupied_count the complement of `unit_is_vacant`.';

-- ── 2. No view answers an anonymous caller ────────────────────────────────
--
-- Supabase grants `anon` and `authenticated` ALL on everything in `public` by
-- default, views included. For the eleven views already carrying
-- `security_invoker` that was survivable — no session means no rows — but it is
-- survivable by accident: it depends entirely on a flag that, as above, does
-- not survive a rebuild. The grant is the difference between "nothing" and
-- "everything" on the day someone drops and recreates one.
--
-- Every anonymous surface in this codebase (`/tenancy/[org]`, `/o/[slug]`,
-- `/pay/[reference]`, `/invite/[token]`) reads TABLES or SECURITY DEFINER
-- FUNCTIONS — `org_public_branding`, `properties_accepting_applications` — and
-- not one reads a view. Nothing anonymous loses anything here.
--
-- Write privileges go too, from both roles. A simple view over one table is
-- auto-updatable in Postgres, so `update property_summary set name = ...`
-- reaches `properties`. Nothing has ever written through one of these and
-- nothing should.
do $$
declare
  v record;
begin
  for v in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'
  loop
    execute format('revoke all on public.%I from anon', v.relname);
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated',
      v.relname);
  end loop;
end;
$$;

-- Re-stated rather than assumed: the views the dashboard reads must still be
-- readable by a signed-in user. Each of these already had it; this is here so
-- that a future reader can see the intended end state in one place.
grant select on property_summary            to authenticated;
grant select on property_application_windows to authenticated;
grant select on rent_roll                   to authenticated;

-- ── 3. Prove it ───────────────────────────────────────────────────────────
do $$
declare
  v_leaky   text;
  v_writable text;
  v_invoker text;
begin
  -- No view grants anything to anon.
  select string_agg(distinct table_name, ', ') into v_leaky
    from information_schema.role_table_grants g
    join pg_class c on c.relname = g.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relkind = 'v' and g.grantee = 'anon' and g.table_schema = 'public';

  if v_leaky is not null then
    raise exception 'anon still holds privileges on view(s): %', v_leaky;
  end if;

  -- No view is writable by a signed-in user.
  select string_agg(distinct table_name, ', ') into v_writable
    from information_schema.role_table_grants g
    join pg_class c on c.relname = g.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relkind = 'v' and g.grantee = 'authenticated'
     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     and g.table_schema = 'public';

  if v_writable is not null then
    raise exception 'authenticated can still write through view(s): %', v_writable;
  end if;

  -- ⚠️ Every view that reads an org-scoped table must read as its caller. A
  -- definer view over `properties`, `tickets`, `vendors` or `leases` is the
  -- shape of the defect this migration exists to close, and naming the four
  -- known survivors here means the next one added is caught by name.
  select string_agg(c.relname, ', ') into v_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and c.relname in ('property_summary', 'property_application_windows',
                       'rent_roll', 'stakeholder_assignments')
     and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker%';

  if v_invoker is not null then
    raise exception 'view(s) still read with the owner''s rights: %', v_invoker;
  end if;
end;
$$;

-- 📌 Left standing, and named so it is not mistaken for an oversight:
-- `application_overview`, `ticket_overview` and `vendor_overview` are still
-- definer views. They do not leak today because each repeats
-- `org_id = current_user_org_id()` in its own WHERE clause — which is the
-- coincidence audit 0729b-S3 flagged on `stakeholder_assignments`, "one edit
-- away from being wrong". They hold PII (applications) and are worth converting,
-- but converting a view changes what every consumer sees and that is its own
-- change with its own verification, not a rider on a security fix.
