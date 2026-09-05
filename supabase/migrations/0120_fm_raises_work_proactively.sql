-- An FM/PM raising work themselves, rather than only reacting to a tenant.
--
-- Every route into `tickets` assumed a REPORTER: WhatsApp and Telegram carry a
-- `channel_sender_ref`, and the portal form (`/dashboard/new`) auto-links the
-- signed-in person's own unit and sets `sender_id` to them. That is right for
-- a resident with a leaking tap and wrong for the work an FM/PM actually
-- initiates — planned maintenance, an inspection finding, something they
-- noticed on a walk-round. There was no way to record any of it.
--
-- Two things follow from "there is no tenant here", and both matter:
--
--   * `sender_id` stays NULL. Not the FM's own id — they are not the person
--     the work is for, and putting them there would make every planned job
--     look like a complaint they raised about themselves. It also keeps the
--     tenant satisfaction prompt (0104, which fires on resolve only when
--     `sender_id is not null`) correctly silent: there is no tenant to ask.
--   * `property_id` is REQUIRED. A tenant's message can arrive unfiled and be
--     triaged later; a planned job that names no property is unreachable to
--     the property-scoped FMs who would do it, and would sit in the
--     unfiled-triage bucket that exists for inbound chat. Staff-raised work
--     with no place is not work anyone can pick up.
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

  -- The same capability that governs dispatching. Someone who may not place
  -- work with a contractor has no business creating it either.
  if not has_permission('tickets.assign') then
    raise exception 'you do not have permission to raise work orders';
  end if;

  if length(trim(coalesce(p_summary, ''))) < 5 then
    raise exception 'describe the work in at least a few words';
  end if;

  -- The property must be one they actually hold. `current_user_property_ids()`
  -- is the single resolver (locked decision 8) — not a second scoping rule
  -- invented here — so a regional manager reaches everything beneath their
  -- node exactly as they do everywhere else.
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
    message_text, summary, category, urgency, status, requires_human_review
  ) values (
    v_org, 'portal',
    null,                       -- staff-raised: there is no reporter
    p_property_id, p_asset_id,
    coalesce(nullif(trim(coalesce(p_detail, '')), ''), trim(p_summary)),
    trim(p_summary), p_category, p_urgency, 'open',
    false                       -- a person wrote this deliberately; it needs no triage
  )
  returning id into v_id;

  -- Dispatching in the same step is the whole point for planned work: the FM
  -- already knows who is doing it. Routed through the same columns the
  -- dispatch action writes, so 0117's assignee guard applies identically.
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

    -- Tell the contractor's login, exactly as assignTicket does. A vendor with
    -- no attached login gets nothing, which is a visible consequence of an
    -- unattached company rather than a silent hole.
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

revoke all on function raise_work_order(uuid, text, text, ticket_category, ticket_urgency, uuid, uuid)
  from public, anon, authenticated;
grant execute on function raise_work_order(uuid, text, text, ticket_category, ticket_urgency, uuid, uuid)
  to authenticated;

comment on function raise_work_order is
  'An FM/PM raises work themselves -- planned maintenance, an inspection finding -- optionally dispatching it in the same step. sender_id stays NULL because there is no reporter (which also keeps the tenant satisfaction prompt correctly silent), and property_id is required because staff-raised work with no place is work nobody can pick up. Scoped by current_user_property_ids(), the same single resolver used everywhere else.';
