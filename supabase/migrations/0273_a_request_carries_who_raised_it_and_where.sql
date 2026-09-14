-- A request carries who raised it, in what capacity, and where — reliably
-- (7 Sept 2026).
--
-- Asked directly: "all requests coming from a tenant/vendor/landlord/fm/pm/rm
-- should be accompanied with the role properties/ids such as attached
-- property/unit pertaining strictly to the request, user role/id, etc."
--
-- Measured against every path that actually creates a `tickets` row before
-- writing anything:
--
--   PORTAL (`raiseRequest`, tenant + landlord + any signed-in staff)
--     sender_id  — always stamped.
--     property_id — resolved from `units.occupant_user_id = caller`. Decision
--       22/0226's own finding, one screen over: occupancy and tenancy are
--       different facts, and 16 of 18 real tenancies then had no occupant set.
--       For a LANDLORD this resolves to nothing at all — they do not occupy a
--       unit — even though decision 19 explicitly gives them their own raise
--       path. property_id came back NULL for the one role the check exists to
--       route.
--     unit_id — never captured. The column has existed since 0269 and nothing
--       writes to it from this path.
--     role — nowhere on the row. `app/dashboard/tickets/[id]/page.tsx` derives
--       "is this a tenant" from `sender_id === viewer.id`, the exact shape of
--       inference 0218 already found wrong once (an FM's own request read as a
--       tenant's because nothing on the row said otherwise).
--
--   RAISE WORK (`raise_work_order`, FM/PM/RM — 0120/0218)
--     sender_id — stamped, since 0218. property_id — REQUIRED and validated
--     against `current_user_property_ids()`, correctly, since 0120. unit_id —
--     no parameter exists; every FM/PM-raised job is filed at the building
--     regardless of whether it is about one flat. role — not stamped.
--
--   CHAT (`classifyAndCreateTicket` → `resolve_chat_sender`, WhatsApp/Telegram)
--     sender_id / property_id — resolved by `resolve_chat_sender`, and the
--     SAME occupancy-only join as the portal path, with the same gap. unit_id
--     — the function does not return one; nothing could have written it even
--     if the caller wanted to. role — not returned, not stamped.
--
-- ── What this migration does ───────────────────────────────────────────────
--
--   1. `tickets.sender_role user_role` — a snapshot, not a live join. Matches
--      this schema's own established pattern for a fact that must not
--      silently reinterpret itself later (decision 14's fee %, decision 30's
--      superseded approvals): if someone's role changes after they raised a
--      request, the request's own record of who reported it, and in what
--      capacity, should not quietly change meaning. Historical rows are left
--      NULL rather than backfilled from a CURRENT role that may not be the one
--      they held at the time — 0221's own precedent ("leaving the 20 rows
--      older than 0178 unattributed rather than guessed at").
--
--   2. `resolve_chat_sender` — property/unit resolution tries the sender's
--      LIVE LEASE first (the fact `caller_is_tenant_of_place`/`my_tenancies()`
--      already trust, and decision 226 already proved more reliable), and
--      falls back to occupancy only when no lease resolves — kept, not
--      replaced, because a company let can have an occupant with no portal
--      login of their own (decision 22) and this function's job is to route a
--      message helpfully, not to decide access. Now also returns `unit_id` and
--      `role`. Signature: same two arguments; RETURN TABLE gains two columns,
--      which needs a DROP first — Postgres refuses to change a function's
--      return shape with CREATE OR REPLACE.
--
--   3. `raise_work_order` — gains an optional `p_unit_id`, validated against
--      the property already being validated, and stamps `sender_role`.
--
--   4. The portal path (`raiseRequest`, application code, this same commit) —
--      resolved via the caller's own live LEASE for a tenant (mirrors 0226
--      rather than the occupancy join), and accepts an optional, SERVER-
--      REVALIDATED property/unit for a landlord or staff member raising an ad
--      hoc request — a picker sourced from `current_user_property_ids()`,
--      exactly what `raise_work_order` already trusts for the same roles.
--
-- ⚠️ What does NOT change: `tickets_select`'s own scoping. This is about what
-- a request CARRIES, not who may read it — decision 8 forbids a second scoping
-- mechanism, and none is added here.

-- ── 1. The snapshot column ──────────────────────────────────────────────────
alter table tickets add column if not exists sender_role user_role;

comment on column tickets.sender_role is
  'The raiser''s role AT THE MOMENT they raised this — a snapshot, never re-derived, so a later role change cannot silently reinterpret who reported what (0273). NULL on every row raised before this column existed; left unattributed rather than backfilled from a role that may not be the one they held then. Written by trg_stamp_ticket_sender_role, never trusted from the insert.';

-- ⚠️ Found while writing the portal insert, not assumed: `tickets_insert`'s
-- WITH CHECK constrains org_id and sender_id and NOTHING else — every other
-- column on the row is client-supplied and un-validated at the RLS layer,
-- because the portal writes through the regular authenticated client rather
-- than a SECURITY DEFINER function. That already applied to `property_id`
-- (a pre-existing gap this migration does not widen — a validated resolver
-- picks it in every path that matters, `raise_work_order`'s own checks and
-- the portal's re-verification below), but `sender_role` is different: its
-- entire purpose is a trustworthy snapshot, and a column any signed-in caller
-- could set to `'admin'` via a direct REST call is not one.
--
-- Fixed the way this schema already fixes exactly this shape — a trigger, not
-- application code, so no write path can miss it (`enforce_approval_rules`'s
-- own reasoning for `actor_role`/`actor_tier`: "come from THEIR ROW, never
-- from the insert"). Belt-and-braces on `raise_work_order` and the chat path,
-- which already stamp it correctly; the one path this actually protects is
-- the portal's.
create or replace function stamp_ticket_sender_role()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is not null then
    new.sender_role := current_user_role();
  end if;
  return new;
end;
$fn$;

comment on function stamp_ticket_sender_role is
  'Overwrites tickets.sender_role from current_user_role() on every authenticated insert, so no write path — present or future — can leave it as whatever the client happened to send (0273). Service-role inserts (seeds, migrations) pass through untouched.';

revoke all on function stamp_ticket_sender_role() from public, anon;
grant execute on function stamp_ticket_sender_role() to authenticated, service_role;

drop trigger if exists tickets_stamp_sender_role on tickets;
create trigger tickets_stamp_sender_role
  before insert on tickets
  for each row execute function stamp_ticket_sender_role();

-- ── 2. resolve_chat_sender: lease first, occupancy as a fallback, plus unit
--       and role ──────────────────────────────────────────────────────────
--
-- ⚠️ DROPPED first — a return-type change cannot go through CREATE OR REPLACE,
-- the same wall 0268 and 0271 hit this same week. Grants on the OLD signature
-- go with it; re-asserted explicitly below rather than left to a default,
-- because Supabase grants `authenticated` on every new function object and
-- this one must never be reachable by anyone but the service role — it is the
-- one function a webhook calls with no session behind it at all.
drop function if exists resolve_chat_sender(uuid, text);

create or replace function resolve_chat_sender(p_org_id uuid, p_sender_ref text)
returns table(user_id uuid, property_id uuid, unit_id uuid, role user_role)
language plpgsql
stable security definer set search_path to 'public'
as $function$
declare
  v_digits text;
  v_user   uuid;
  v_role   user_role;
  v_prop   uuid;
  v_unit   uuid;
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
     and u.deactivated_at is null                       -- 0195
     and u.phone is not null
     and right(regexp_replace(u.phone, '\D', '', 'g'), 10) = v_digits;

  -- Exactly one, or nobody. Two people sharing a number is not a licence to
  -- guess which of them is writing — an ambiguous match resolves to no match.
  if v_n <> 1 then
    return;
  end if;

  select u.id, u.role into v_user, v_role
    from users u
   where u.org_id = p_org_id
     and u.deactivated_at is null                       -- 0195
     and u.phone is not null
     and right(regexp_replace(u.phone, '\D', '', 'g'), 10) = v_digits;

  -- Their place, tried two ways. The LIVE LEASE first — the same fact
  -- `caller_is_tenant_of_place`/`my_tenancies()` already trust, and the one
  -- 0226 found reliable where occupancy was not (16 of 18 real tenancies then
  -- had no matching occupant). Exactly one, or nothing: a tenant holding two
  -- live leases gives no basis to pick either.
  select count(*) into v_n
    from leases l
   where l.tenant_user_id = v_user
     and l.org_id = p_org_id
     and l.deleted_at is null
     and l.status in ('active', 'renewed');

  if v_n = 1 then
    select l.property_id, l.unit_id into v_prop, v_unit
      from leases l
     where l.tenant_user_id = v_user
       and l.org_id = p_org_id
       and l.deleted_at is null
       and l.status in ('active', 'renewed');
  else
    -- Occupancy as a FALLBACK, not replaced. A company let can have an
    -- occupant with no portal login of their own (0200/0209), so a lease
    -- naming a different tenant-of-record is not evidence the occupant is
    -- wrong — it is evidence there are two different facts, and this
    -- function's job is to route a message helpfully, not to decide access.
    select count(*) into v_n
      from units un
     where un.occupant_user_id = v_user
       and un.org_id = p_org_id
       and un.property_id is not null;

    if v_n = 1 then
      select un.property_id, un.id into v_prop, v_unit
        from units un
       where un.occupant_user_id = v_user
         and un.org_id = p_org_id
         and un.property_id is not null;
    end if;
  end if;

  return query select v_user, v_prop, v_unit, v_role;
end;
$function$;

comment on function resolve_chat_sender is
  'Who is writing to us on WhatsApp or Telegram, by their phone number, and where — their live lease first, their recorded occupancy as a fallback (0273; occupancy alone since 0087, lease preference added because 0226 found it more reliable). Also returns their unit and role, added the same day, so a request they raise carries all three. A deactivated account resolves to nobody (0195) — this path runs service-role from the webhook, so RLS and the 0194 resolvers never see it, and without that clause the primary intake channel stayed open to someone the organisation had removed.';

revoke all on function resolve_chat_sender(uuid, text) from public, anon, authenticated;
grant execute on function resolve_chat_sender(uuid, text) to service_role;

-- ── 3. raise_work_order: an optional unit, and the raiser's role ──────────
--
-- ⚠️ DROPPED first, not left beside the old one. A trailing DEFAULT parameter
-- still changes the function's IDENTITY — Postgres resolves overloads by the
-- full parameter list, so `create or replace` here would have created a
-- SECOND, 8-argument `raise_work_order` alongside the original 7-argument one
-- rather than replacing it (confirmed: applying this without the drop failed
-- on "function name is not unique" the moment the migration reached the
-- `comment on function` line below). Two callable signatures for one act is
-- exactly what 0263 already named and fixed once on `issue_tenancy_offer` —
-- "two ways to approve an application with different consequences, and one of
-- them the behaviour being replaced."
drop function if exists raise_work_order(uuid, text, text, ticket_category, ticket_urgency, uuid, uuid);

-- Rebuilt from `pg_get_functiondef` (0183); one parameter, one validation
-- clause, one insert column and one snapshot added, nothing else retyped.
create or replace function raise_work_order(
  p_property_id uuid,
  p_summary text,
  p_detail text default null::text,
  p_category ticket_category default 'maintenance'::ticket_category,
  p_urgency ticket_urgency default 'normal'::ticket_urgency,
  p_asset_id uuid default null::uuid,
  p_vendor_id uuid default null::uuid,
  p_unit_id uuid default null::uuid
)
returns uuid
language plpgsql
security definer set search_path to 'public'
as $function$
declare
  v_org  uuid := current_user_org_id();
  v_role user_role := current_user_role();
  v_id   uuid;
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

  -- 0273. The same shape as the asset check two lines up: a unit on a
  -- different property is not a typo to silently correct, it is a claim about
  -- the wrong building.
  if p_unit_id is not null and not exists (
    select 1 from units
     where id = p_unit_id and org_id = v_org and property_id = p_property_id
  ) then
    raise exception 'that unit is not on that property';
  end if;

  insert into tickets (
    org_id, channel, sender_id, sender_role, property_id, unit_id, asset_id,
    message_text, summary, category, urgency, status, requires_human_review,
    reviewed_at, reviewed_by
  ) values (
    v_org, 'portal',
    -- ⚠️ WAS `null`, and that is why an FM/PM could not find work they raised
    -- themselves. `tickets_select` returns a request to `sender_id = auth.uid()`
    -- and the "Raised by me" view filters on it, so a work order with no sender
    -- belonged to nobody: its raiser could not see it unless they were also
    -- assigned it or managed the property. The board asked for exactly this
    -- view (decision 23) and it was empty for the one path that fills it.
    --
    -- 0120's reasoning for NULL was that planned work "has no reporter", which
    -- is true of a TENANT and false of a raiser. `app/dashboard/new/actions.ts`
    -- has always stamped whoever submitted the form, FM included, so a
    -- staff-raised request already carried a sender by the other route — this
    -- was the inconsistent one.
    auth.uid(), v_role,
    p_property_id, p_unit_id, p_asset_id,
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
$function$;

comment on function raise_work_order is
  'An FM/PM/RM raising work themselves rather than reporting it on someone else''s behalf (0120/0218). Property is required and validated against what they manage; unit is optional and validated against the property when given (0273) — a generator or a gate genuinely has no unit, a flat-specific job now can carry one. Stamps sender_role so the raiser''s capacity is on the record even if their role later changes.';

revoke all on function raise_work_order(uuid, text, text, ticket_category, ticket_urgency, uuid, uuid, uuid) from public, anon;
grant execute on function raise_work_order(uuid, text, text, ticket_category, ticket_urgency, uuid, uuid, uuid) to authenticated, service_role;

-- ── Prove the class, not the instance ──────────────────────────────────────
--
-- Not "resolve_chat_sender is safe" but "nothing new here is reachable by
-- anon or PUBLIC" — 0185's lesson, and the fourth time this repo has had to
-- restate it about exactly this failure mode (0204, 0209, 0210, 0264).
do $$
declare v_bad text;
begin
  select string_agg(distinct routine_name || ' → ' || grantee, ', ')
    into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public'
     and grantee in ('anon', 'PUBLIC')
     and routine_name in ('resolve_chat_sender', 'raise_work_order');
  if v_bad is not null then
    raise exception 'these are callable by anon or PUBLIC and must not be: %', v_bad;
  end if;

  -- resolve_chat_sender specifically must not even be `authenticated` — it is
  -- the one function reached with no session behind it at all.
  select string_agg(grantee, ', ') into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public' and routine_name = 'resolve_chat_sender'
     and grantee = 'authenticated';
  if v_bad is not null then
    raise exception 'resolve_chat_sender is callable by a signed-in user and must not be — it is reached service-role only';
  end if;

  -- sender_role must be STAMPED, not merely writable. If this trigger is ever
  -- dropped, tickets_insert's WITH CHECK still constrains nothing but org_id
  -- and sender_id, and the column reverts to whatever a caller sends.
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'tickets' and t.tgname = 'tickets_stamp_sender_role'
  ) then
    raise exception 'tickets_stamp_sender_role is missing — sender_role would be trusted from the insert';
  end if;
end $$;
