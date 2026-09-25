-- One unsigned listener cannot silence everyone.
--
-- Realtime decides who may see a changed row by evaluating that table's RLS
-- policy AS EACH SUBSCRIBER'S ROLE, in one batch (`realtime.apply_rls`, called
-- from `realtime.list_changes`). If evaluating the policy for ANY subscriber
-- raises an error, the whole batch fails — and the changes are not consumed,
-- so the next poll fails the same way, forever, for everybody.
--
-- The policies on the two published tables (0002, 0301) call functions that
-- 0115/0163/0184/0195/0212 granted to `authenticated` and `service_role` only.
-- So a single subscriber whose role is `anon` — a browser whose live
-- connection went out before its session loaded, a tab left open after
-- sign-out, or anybody at all holding the public key — makes Postgres raise
--   permission denied for function active_uid
-- inside the batch, and live updates stop for every user of every org.
--
-- Found 25 Sept 2026 on production: the Realtime log showed exactly that
-- error; `realtime.subscription` held three `anon` subscriptions; and a
-- service-role listener (scripts/diagnose-realtime.mjs) heard NOTHING while a
-- row was inserted in front of it. Both the request board and the bell were
-- silent until a manual refresh.
--
-- ⚠️ Why granting to `anon` is safe here, function by function. Every one of
-- them answers "who is the caller?" from `auth.uid()`, which is NULL for an
-- unsigned caller, and each fails closed on NULL:
--   active_uid()                       → NULL
--   current_user_org_id()              → NULL   (org_id = NULL matches no row)
--   current_user_role()                → NULL
--   current_user_vendor_ids()          → empty set
--   current_user_property_ids()        → empty set
--   current_user_payable_ticket_ids()  → empty set
--   has_permission(text)               → false  (no org, no role, no grant)
--   fm_roles()                         → a fixed list of role NAMES; no data
-- An unsigned caller therefore learns nothing it could not read in this file,
-- and the policies still show it zero rows. What changes is only that the
-- question can be ASKED without an error — which is what Realtime needs.
--
-- The alternative — keeping the grants and trusting that no unsigned
-- subscriber ever exists — makes live updates for the whole platform depend on
-- the good behaviour of anyone holding a key that is published in every page.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.active_uid()',
    'public.current_user_org_id()',
    'public.current_user_role()',
    'public.current_user_vendor_ids()',
    'public.current_user_property_ids()',
    'public.current_user_payable_ticket_ids()',
    'public.has_permission(text)',
    'public.fm_roles()'
  ] loop
    execute format('grant execute on function %s to anon', fn);
  end loop;
end $$;

-- ── Prove it, inside the migration ───────────────────────────────────────
-- Evaluate both published tables' SELECT policies as `anon`, exactly as
-- Realtime will. A missed function raises here and fails the migration,
-- rather than failing silently in production's live stream. Each must return
-- zero rows: an unsigned caller sees nothing.
do $$
declare
  n bigint;
  t text;
begin
  foreach t in array array['public.tickets', 'public.user_notifications'] loop
    -- Without table SELECT the policy is never reached; nothing to prove.
    continue when not has_table_privilege('anon', t, 'select');
    execute 'set local role anon';
    begin
      execute format('select count(*) from %s', t) into n;
    exception when insufficient_privilege then
      execute 'reset role';
      raise exception 'Realtime would still fail for an unsigned subscriber on %: %', t, sqlerrm;
    end;
    execute 'reset role';
    if n <> 0 then
      raise exception 'anon can see % row(s) of % — the policy is broken, not just the grants', n, t;
    end if;
  end loop;
end $$;
