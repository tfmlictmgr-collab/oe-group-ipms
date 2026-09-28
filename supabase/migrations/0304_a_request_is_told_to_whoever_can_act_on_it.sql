-- A request is told to whoever can act on it, and the administrator steps in
-- only once it has been left (27 Sept 2026, operator's instruction during the
-- security self-assessment, Part B4).
--
-- ── What was found ─────────────────────────────────────────────────────────
--
-- A tenant with no lease on file raised a request on staging. It was saved
-- with no property — correctly — and `notify_role(admin, FM, PM)` rang the
-- bell of every administrator, facility manager and property manager in the
-- organisation. The property manager clicked it and nothing opened:
-- `tickets_select` (0184) shows an FM/PM only the requests on THEIR buildings,
-- and a request with no building only to whoever holds
-- `tickets.triage_unassigned`. The bell knew (0145's `target_live`) and offered
-- no link. So the one person told could not act, and the request was not on
-- their board.
--
-- The same was true of every request with a property: all FM/PMs in the
-- organisation were told — on WhatsApp and email too, if they had those
-- switched on — about work on buildings they do not manage and cannot open.
--
-- ── The rule, as the operator set it ──────────────────────────────────────
--
--   1. A new request alerts ONLY the people who can open it and act on it:
--      the FM/PM/regional manager whose places include its property; or, for
--      a request with no property yet, the operational roles that triage
--      those (`tickets.triage_unassigned` + `tickets.assign`).
--   2. The administrator SEES and OPENS every request, but ACTS on one only
--      once it has sat 24 hours without anyone acting on it, or 24 hours with
--      nobody assigned to it. Before that it is the desk's.
--
-- ── How ───────────────────────────────────────────────────────────────────
--
--   • `user_property_ids(uuid)` — the places a GIVEN person manages. Built
--     from the live `current_user_property_ids()` in the catalogue, with
--     `auth.uid()` replaced by the argument, so the two cannot drift (0303
--     just rewrote that body; a hand-copied twin would already be stale).
--   • `ticket_alert_audience(ticket)` — rule 1, mirroring the two clauses of
--     `tickets_select` an operational person reaches a request through, plus
--     `tickets_update`'s requirement that they may act (`tickets.assign`).
--     Administrators are not in it: rule 2.
--   • `notify_ticket_audience(...)` — writes the bell entries and returns who,
--     so the app can add each person's own external channels (B8).
--     ⚠️ If NOBODY operational can open the request — no manager on the
--     property, no regional manager for a request with no property — the
--     administrators are told at once instead, and told why. A request that
--     reaches nobody is worse than one that reaches the wrong person; this is
--     the one case the administrator hears about on day one. They still act on
--     it only after 24 hours; what they can do sooner is fix the coverage.
--   • `tickets.last_acted_at` — when someone on the desk last did something to
--     the request: an FM/PM, a regional manager, an ops person or the
--     contractor. Kept by a trigger; the administrator's own acts do not move
--     it, so once an administrator has rescued a request they may keep
--     handling it until the desk picks it up again.
--   • `tickets_admin_acts_only_on_left_work` — rule 2, at the database, for
--     EVERY write an administrator makes to a request (review, dispatch,
--     reassign, status, urgency). Computed from the row, never from a flag a
--     job had to set — decision 15's rule, as 0212 did for the dispatch rescue.
--     One exception: an administrator who REPORTED a request may correct its
--     urgency, as any reporter may (0124).
--   • `escalate_idle_requests()` — the hourly job now also tells the
--     administrators, once per idle spell, about a request that has gone 24
--     hours without action. 0212's function for never-touched requests is
--     unchanged and still runs.
--
-- 📌 24 hours is hardwired, as 0212's is: it is the width of an exception to a
-- separation-of-duties control (0178), not a cadence an org configures.

-- ── 1. The places a given person manages ──────────────────────────────────
do $$
declare
  def text;
  newdef text;
begin
  def := pg_get_functiondef('public.current_user_property_ids()'::regprocedure);
  newdef := replace(def, 'public.current_user_property_ids()', 'public.user_property_ids(p_user_id uuid)');
  newdef := replace(newdef, 'auth.uid()', 'p_user_id');
  if newdef ~ 'auth\.uid\(\)' or newdef !~ 'user_property_ids\(p_user_id uuid\)' then
    raise exception 'could not derive user_property_ids from current_user_property_ids';
  end if;
  execute newdef;
end $$;

revoke all on function user_property_ids(uuid) from public, anon, authenticated;
grant execute on function user_property_ids(uuid) to service_role;

comment on function user_property_ids(uuid) is
  'The properties a GIVEN person manages — current_user_property_ids() for someone other than the caller, derived from its live body by 0304 so the two cannot drift. Service-role only: it answers for any user id.';

-- ── 2. Who a request is for ───────────────────────────────────────────────
create or replace function ticket_alert_audience(p_ticket_id uuid)
returns table (user_id uuid)
language sql stable security definer set search_path = public as $$
  select u.id
    from tickets t
    join users u on u.org_id = t.org_id
   where t.id = p_ticket_id
     and u.deactivated_at is null
     and u.sign_in_locked_at is null
     and u.email_released_at is null
     and u.role <> 'admin'
     -- tickets_select's operational clauses are for fm_roles() only.
     and u.role = any (fm_roles())
     -- tickets_update: may they act on it?
     and exists (select 1 from role_permissions rp
                  where rp.org_id = t.org_id and rp.role = u.role
                    and rp.capability = 'tickets.assign' and rp.granted)
     and (
       -- On a building they manage.
       (t.property_id is not null
        and t.property_id in (select user_property_ids(u.id)))
       -- Or no building yet, and they triage those.
       or (t.property_id is null
           and exists (select 1 from role_permissions rp
                        where rp.org_id = t.org_id and rp.role = u.role
                          and rp.capability = 'tickets.triage_unassigned' and rp.granted))
     );
$$;

revoke all on function ticket_alert_audience(uuid) from public, anon, authenticated;
grant execute on function ticket_alert_audience(uuid) to service_role;

comment on function ticket_alert_audience(uuid) is
  'The people a new request should be announced to: active operational staff (fm_roles) who can both OPEN it (its property is one they manage, or it has none and they triage those) and ACT on it (tickets.assign). Never administrators, who act only on work left 24 hours (0304). Service-role only.';

create or replace function notify_ticket_audience(
  p_ticket_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_link text
)
returns table (user_id uuid, fallback boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_ids uuid[];
begin
  if auth.uid() is not null then
    raise exception 'announcing a request is done by the server, not a signed-in user';
  end if;

  select org_id into v_org from tickets where id = p_ticket_id;
  if v_org is null then
    return;
  end if;

  select array_agg(a.user_id) into v_ids from ticket_alert_audience(p_ticket_id) a;

  if v_ids is not null then
    perform notify_user(x, p_kind, p_title, p_body, p_link, 'ticket', p_ticket_id)
       from unnest(v_ids) x;
    return query select x, false from unnest(v_ids) x;
    return;
  end if;

  -- ⚠️ Nobody operational can open it. The administrators are the only ones
  -- who can, so they are told now — and told what to fix.
  select array_agg(u.id) into v_ids
    from users u
   where u.org_id = v_org and u.role = 'admin'
     and u.deactivated_at is null and u.sign_in_locked_at is null
     and u.email_released_at is null;

  if v_ids is null then
    return;
  end if;

  perform notify_user(
    x, p_kind,
    p_title || ' — no manager covers it',
    coalesce(p_body || ' ', '') ||
      'No facility, property or regional manager can open this request. Put a manager on the property (or appoint a regional manager) so requests like it reach someone who can act. You can dispatch it yourself once it has waited 24 hours.',
    p_link, 'ticket', p_ticket_id)
    from unnest(v_ids) x;
  return query select x, true from unnest(v_ids) x;
end;
$$;

revoke all on function notify_ticket_audience(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function notify_ticket_audience(uuid, text, text, text, text) to service_role;

comment on function notify_ticket_audience(uuid, text, text, text, text) is
  'Writes the in-app notice of a new request for ticket_alert_audience() and returns who was told, so the caller can add their own external channels. If nobody operational can open the request, tells the administrators instead (fallback = true) and says why. Service-role only (0304).';

-- ── 3. When the desk last acted ───────────────────────────────────────────
alter table tickets add column if not exists last_acted_at timestamptz;
alter table tickets add column if not exists idle_escalated_at timestamptz;

comment on column tickets.last_acted_at is
  'When someone on the desk — an FM/PM, a regional manager, an ops person or the contractor — last changed this request (0304). An administrator''s own acts do not move it. Read by the administrator''s 24-hour rule and by escalate_idle_requests().';
comment on column tickets.idle_escalated_at is
  'When the administrators were last told this request had gone 24 hours without action (0304). A notification record only; the administrator''s authority is computed from the row.';

-- Past rows: the latest thing we know happened to them. Written before the
-- triggers below exist, as the migration owner.
update tickets
   set last_acted_at = greatest(created_at, reviewed_at, assigned_at, acknowledged_at,
                                first_response_at, urgency_changed_at, resolved_at)
 where last_acted_at is null;

-- 📌 Nobody is told about the past. Requests already idle when this lands are
-- marked as told, so the first hourly run does not send every administrator a
-- notice for every old fixture. They are still open to the administrator — the
-- rule reads the row, not this column. (Production holds no requests at the
-- time of writing.)
update tickets
   set idle_escalated_at = now()
 where status not in ('resolved', 'closed')
   and last_acted_at < now() - interval '24 hours';

create or replace function tickets_note_desk_action()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role user_role;
begin
  if auth.uid() is null then
    return new;
  end if;
  v_role := current_user_role();
  if v_role = any (fm_roles()) or v_role in ('fm_ops_staff', 'vendor') then
    new.last_acted_at := now();
  end if;
  return new;
end;
$$;

revoke all on function tickets_note_desk_action() from public, anon, authenticated;

drop trigger if exists tickets_note_desk_action on tickets;
create trigger tickets_note_desk_action before update on tickets
  for each row execute function tickets_note_desk_action();

-- A new request starts its clock when it arrives.
create or replace function tickets_start_desk_clock()
returns trigger language plpgsql set search_path = public as $$
begin
  new.last_acted_at := coalesce(new.last_acted_at, new.created_at, now());
  return new;
end;
$$;

drop trigger if exists tickets_start_desk_clock on tickets;
create trigger tickets_start_desk_clock before insert on tickets
  for each row execute function tickets_start_desk_clock();

-- ── 4. The administrator acts only on work that has been left ─────────────
--
-- ⚠️ Named to sort FIRST among the BEFORE UPDATE triggers on tickets, so it
-- sees the row as the administrator submitted it — before the lifecycle and
-- review triggers add their own columns — and refuses before either stamps
-- anything.
create or replace function tickets_admin_acts_only_on_left_work()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_quiet timestamptz;
  v_from timestamptz;
  v_urgency_only constant text[] := array['urgency', 'urgency_source', 'urgency_changed_at',
                                          'requires_human_review'];
  -- ⚠️ Generated columns (unit_org_id) are NULL in NEW inside a BEFORE
  -- trigger, so they would always read as "changed". Left out of every
  -- comparison below; they follow their inputs anyway.
  v_generated text[];
  v_new jsonb;
  v_old jsonb;
begin
  if auth.uid() is null or current_user_role() is distinct from 'admin' then
    return new;
  end if;

  select coalesce(array_agg(attname::text), '{}') into v_generated
    from pg_attribute
   where attrelid = tg_relid and attgenerated <> '' and not attisdropped;
  v_new := to_jsonb(new) - v_generated;
  v_old := to_jsonb(old) - v_generated;

  -- Nothing actually changes: nothing to refuse.
  if v_new = v_old then
    return new;
  end if;

  -- A reporter correcting the urgency of their own request (0124) — an
  -- administrator who reported it is a reporter too.
  if old.sender_id = auth.uid()
     and (v_new - v_urgency_only) = (v_old - v_urgency_only) then
    return new;
  end if;

  v_quiet := coalesce(old.last_acted_at, old.created_at);

  -- 24 hours with nobody assigned (decision 23, as 0212 reads it)…
  if old.assigned_vendor_id is null and old.assigned_to_user_id is null
     and old.created_at < now() - interval '24 hours' then
    return new;
  end if;

  -- …or 24 hours with nobody on the desk doing anything.
  if v_quiet < now() - interval '24 hours' then
    return new;
  end if;

  v_from := least(
    case when old.assigned_vendor_id is null and old.assigned_to_user_id is null
         then old.created_at + interval '24 hours' end,
    v_quiet + interval '24 hours');

  raise exception 'This request is with its manager. An administrator can act on it once it has gone 24 hours without action, or 24 hours with nobody assigned — from % (Lagos time).',
    to_char(v_from at time zone 'Africa/Lagos', 'DD Mon HH24:MI');
end;
$$;

revoke all on function tickets_admin_acts_only_on_left_work() from public, anon, authenticated;

drop trigger if exists tickets_admin_acts_only_on_left_work on tickets;
create trigger tickets_admin_acts_only_on_left_work before update on tickets
  for each row execute function tickets_admin_acts_only_on_left_work();

comment on trigger tickets_admin_acts_only_on_left_work on tickets is
  'An administrator sees every request but changes one only once it has gone 24 hours with nobody assigned, or 24 hours without anyone on the desk acting on it (0304, operator''s rule of 27 Sept 2026). Computed from the row. The one exception is a reporter''s own urgency correction.';

-- ── 5. Telling the administrators about work that has been left ───────────
create or replace function escalate_idle_requests()
returns integer language plpgsql security definer set search_path = public as $$
declare
  t record;
  n integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'this job runs unattended, not as a signed-in user';
  end if;

  for t in
    select tk.id, tk.org_id, tk.summary, tk.last_acted_at
      from tickets tk
     where tk.status not in ('resolved', 'closed')
       -- Never-touched requests are 0212's job, which still runs.
       and not (tk.assigned_vendor_id is null and tk.assigned_to_user_id is null
                and tk.reviewed_at is null)
       and tk.last_acted_at < now() - interval '24 hours'
       and (tk.idle_escalated_at is null or tk.idle_escalated_at < tk.last_acted_at)
     order by tk.last_acted_at
     limit 500
  loop
    -- Stamp first, then notify — 0212's order, for 0212's reason.
    update tickets set idle_escalated_at = now() where id = t.id;

    perform notify_role(
      t.org_id,
      array['admin']::user_role[],
      'request',
      'No action for over 24 hours',
      coalesce(t.summary, 'A service request') ||
        ' has had nothing done to it since ' ||
        to_char(t.last_acted_at at time zone 'Africa/Lagos', 'DD Mon HH24:MI') ||
        '. You can now act on it.',
      '/dashboard/tickets/' || t.id::text,
      'ticket',
      t.id
    );

    insert into audit_log (org_id, actor_id, action, entity_type, entity_id, after_state)
    values (t.org_id, null, 'ticket.escalated_idle', 'ticket', t.id,
            jsonb_build_object('last_acted_at', t.last_acted_at,
                               'reason', 'No action past 24 hours — administrators notified (0304)'));

    n := n + 1;
  end loop;

  return n;
end;
$$;

revoke all on function escalate_idle_requests() from public, anon, authenticated;
grant execute on function escalate_idle_requests() to service_role;

comment on function escalate_idle_requests() is
  'Tells the administrators, once per idle spell, about each open request that has gone 24 hours without anyone on the desk acting on it (0304). Never-touched requests stay with escalate_stale_unassigned_requests (0212). Service-role only.';

-- ── 6. Prove it, inside the migration ─────────────────────────────────────
do $$
declare
  trig text;
begin
  if pg_get_functiondef('public.user_property_ids(uuid)'::regprocedure) !~* 'sign_in_locked_at' then
    raise exception 'user_property_ids lost the lock test it was derived with';
  end if;

  -- The administrator's rule must fire before any other BEFORE UPDATE trigger.
  select tgname into trig
    from pg_trigger
   where tgrelid = 'public.tickets'::regclass and not tgisinternal
     and (tgtype & 2) = 2          -- BEFORE
     and (tgtype & 16) = 16        -- UPDATE
   order by tgname
   limit 1;
  if trig is distinct from 'tickets_admin_acts_only_on_left_work' then
    raise exception 'the first BEFORE UPDATE trigger on tickets is %, not the administrator rule', trig;
  end if;
end $$;
