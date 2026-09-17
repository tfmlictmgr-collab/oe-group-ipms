-- An FM/PM could not find the work they raised themselves.
-- (Reported after the 28 Aug 2026 demo — decision 23.)
--
-- The board asked that "fm should see their own requests on their dashboards".
-- `0212` added the "Raised by me" view and `tickets_select` has returned a
-- request to `sender_id = auth.uid()` since the table existed — so the view was
-- correct and, for the one path that matters most, permanently empty.
--
-- ⚠️ `raise_work_order` inserts `sender_id` as **NULL**, explicitly. Work an
-- FM/PM raises through *Raise Work* therefore belongs to nobody: its raiser
-- cannot see it unless they happen to also be assigned it or to manage that
-- property. That is the report, exactly.
--
-- 0120 chose NULL because planned work "has no reporter". True of a TENANT and
-- false of a raiser — and the portal's own `New Request` action has always
-- stamped whoever submitted it, an FM included, so a staff-raised request
-- already carried a sender by the other route. This is the path that was out of
-- step, not a new meaning for the column.
--
-- 📌 THE CONSEQUENCE THAT HAS TO MOVE WITH IT, and which was already wrong.
-- `app/dashboard/tickets/[id]/page.tsx` derives `isTenant` as
-- `sender_id === session.user.id` and branches the EVALUATION on it: the tenant
-- half of 0104's rubric is `satisfaction`, the FM half is
-- `quality`/`compliance`. An FM who raised a request through `New Request`
-- today is already handed the tenant's satisfaction form and their rating is
-- already filed as `source = 'tenant'`. That is a live mislabel this migration
-- would merely make more common, so it is fixed in the same change: "tenant"
-- now means the reporter who does NOT hold management authority.
--
-- ⚠️ Rewritten from the LIVE definition (`pg_get_functiondef`), per the 0136
-- lesson — this function has been through 0120, 0178, 0187 and 0188, and
-- retyping it from any one of them would silently revert the other three. One
-- value changes; every other byte is what was running.

CREATE OR REPLACE FUNCTION public.raise_work_order(p_property_id uuid, p_summary text, p_detail text DEFAULT NULL::text, p_category ticket_category DEFAULT 'maintenance'::ticket_category, p_urgency ticket_urgency DEFAULT 'normal'::ticket_urgency, p_asset_id uuid DEFAULT NULL::uuid, p_vendor_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := current_user_org_id();
  v_id  uuid;
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

  insert into tickets (
    org_id, channel, sender_id, property_id, asset_id,
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
    auth.uid(),
    p_property_id, p_asset_id,
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
