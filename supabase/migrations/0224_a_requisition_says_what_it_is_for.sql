-- A requisition can say what it is for, in the raiser's own words.
-- (Board, 29 Aug 2026.)
--
-- `ops_requisitions` has carried a `reference` since `0170` — the raiser's own
-- label, compulsory, and the thing they reconcile against ("Job101-M",
-- "PO-10001"). It has never carried a DESCRIPTION.
--
-- So everything downstream had to infer the purpose from either the linked job
-- card's summary — absent on a standalone requisition, which `0170` explicitly
-- allows for "materials with no single job behind it" — or from the cost lines,
-- which describe individual items rather than the ask. The approvals queue said
-- "Standalone requisition" and nothing else, to four people in a row whose job
-- is to decide whether it should be paid.
--
-- The reference stays compulsory. This is added beside it, not instead of it:
-- one is how the raiser files it, the other is what they are asking for, and a
-- label is not an explanation.

alter table ops_requisitions add column if not exists description text;

comment on column ops_requisitions.description is
  'What this requisition is for, in the raiser''s own words. Distinct from `reference`, which is their filing label and stays compulsory — a chain deciding whether to release money should not have to infer the purpose from the cost lines. Optional: a requisition against a job card already carries that job''s summary.';

-- ⚠️ Rewritten from the LIVE definition (`pg_get_functiondef`), per the 0136
-- lesson — this function has been through 0170 and 0195, and retyping it from
-- either one alone would silently revert the other. One parameter is added and
-- one column is written; every other byte is what was running.
--
-- 📌 The new parameter goes LAST and carries a default, so the existing
-- four-argument call sites keep resolving. PostgREST dispatches on argument
-- names, so an older client simply omits it.
CREATE OR REPLACE FUNCTION public.raise_ops_requisition(
  p_reference text,
  p_lines jsonb,
  p_ticket_id uuid DEFAULT NULL::uuid,
  p_attachment_path text DEFAULT NULL::text,
  p_description text DEFAULT NULL::text
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_org  uuid;
  v_req_id uuid;
  v_path text := nullif(trim(coalesce(p_attachment_path, '')), '');
  v_line jsonb;
  v_order smallint := 0;
  v_desc text;
  v_amount numeric;
  v_vendor uuid;
  v_count int;
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;

  select role, org_id into v_role, v_org from users where id = v_uid;

  -- Raised by the people who do the work and by dispatch authority above
  -- them — the same set 0078a's fm_roles() names, plus the ops staff member
  -- themselves and an administrator.
  if v_role not in ('fm_ops_staff', 'facility_manager', 'property_manager', 'regional_manager', 'admin') then
    raise exception 'only operational staff may raise a requisition';
  end if;

  if length(trim(coalesce(p_reference, ''))) < 3 then
    raise exception 'give the requisition a reference of your own so you can reconcile it';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a requisition needs at least one cost line';
  end if;
  if jsonb_array_length(p_lines) > 50 then
    raise exception 'a single requisition may hold at most 50 lines — split this into more than one';
  end if;

  if p_ticket_id is not null then
    if not exists (select 1 from tickets where id = p_ticket_id and org_id = v_org) then
      raise exception 'that job could not be found in your organisation';
    end if;
  end if;

  if v_path is not null and v_path !~ ('^' || v_org::text || '/') then
    raise exception 'that attachment does not belong to your organisation';
  end if;

  insert into ops_requisitions (org_id, ticket_id, raised_by, reference, invoice_attachment_path, description)
  values (v_org, p_ticket_id, v_uid, trim(p_reference), v_path,
          nullif(trim(coalesce(p_description, '')), ''))
  returning id into v_req_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_order := v_order + 1;
    v_desc := trim(coalesce(v_line->>'description', ''));
    v_amount := nullif(v_line->>'amount', '')::numeric;
    v_vendor := nullif(v_line->>'vendorId', '')::uuid;

    if length(v_desc) < 3 then
      raise exception 'line %: describe the cost in at least 3 characters', v_order;
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'line %: enter a positive amount', v_order;
    end if;
    if v_vendor is not null and not exists (
      select 1 from vendors where id = v_vendor and org_id = v_org
    ) then
      raise exception 'line %: that vendor is not registered in your organisation', v_order;
    end if;

    insert into ops_requisition_lines (requisition_id, org_id, line_order, description, amount, vendor_id)
    values (v_req_id, v_org, v_order, v_desc, v_amount, v_vendor);
  end loop;

  -- Notified the same way a vendor invoice tells finance -- the chain's stage
  -- 1 is a facility/regional manager, and they are who is actually next.
  perform notify_role(
    v_org,
    array['facility_manager', 'property_manager', 'regional_manager']::user_role[],
    'payment',
    'A requisition was raised',
    trim(p_reference) || ' awaits your sign-off',
    '/dashboard/approvals'
  );

  return v_req_id;
end;
$function$;

-- `create or replace` re-applies Supabase's default grants, and the new
-- signature is a NEW function as far as the catalogue is concerned — so the
-- revoke has to name it explicitly. 0204/0209/0210's standing lesson.
revoke all on function raise_ops_requisition(text, jsonb, uuid, text, text) from public, anon;
grant execute on function raise_ops_requisition(text, jsonb, uuid, text, text) to authenticated;

-- ⚠️ The four-argument version is DROPPED rather than left beside the new one.
-- Two overloads differing only by a trailing default is an ambiguous call for
-- PostgREST, and the one it picks is the one that silently discards the
-- description.
drop function if exists raise_ops_requisition(text, jsonb, uuid, text);

comment on function raise_ops_requisition(text, jsonb, uuid, text, text) is
  'Raises an ops requisition with its cost lines. The reference is the raiser''s own compulsory filing label; `p_description` is what they are asking for, added in 0224 because the approval chain could otherwise only infer the purpose from the cost lines or from a job card a standalone requisition does not have.';
