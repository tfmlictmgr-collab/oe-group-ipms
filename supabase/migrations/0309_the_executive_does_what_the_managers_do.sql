-- The Executive can do everything a facilities, properties or regional
-- manager can, across the whole organisation (requested 3 Oct 2026).
--
-- 0307 made the Executive a coordinator: org-wide SIGHT, dispatch and
-- onboarding, and requisition approval — but not the work itself. Tested on
-- staging, "Raise requisition" bounced them back to the dashboard and they
-- could not raise a work order. The direction since is plain: the Executive
-- has access to everything FM/Ops/PM have.
--
-- HOW, in two moves rather than thirty:
--
--   1. `fm_roles()` admits them. Roughly thirty policies and a dozen functions
--      reach the operational roles only through it (0078a, 0183), so this one
--      element is most of the change.
--   2. `current_user_property_ids()` returns EVERY live property of their
--      organisation. The FM rules are "an FM, on a property they hold"; the
--      Executive now holds all of them — the same mechanism that lets a node
--      assignment widen a regional manager to a region.
--
--   The residue — nine functions and five policies written before fm_roles()
--   existed and still spelling the roles out — gains the Executive wherever it
--   lists the regional manager beside the FM/PM, rebuilt mechanically from
--   pg_get_functiondef of a database holding 0001–0308 (the 0183 rule).
--
-- WHAT DOES NOT MOVE, deliberately:
--
--   • Approval stays 0307's: requisitions only, within the operator-set limit,
--     never one they raised. Being able to RAISE one now makes that last rule
--     load-bearing, and it is enforced in both `record_payment_approval` and
--     `enforce_approval_rules`.
--   • No money release, no ledger, no bank, no export, no audit trail, no
--     admin powers, no tier: oversight_roles(), payment_chain_roles(),
--     request_read_all_roles() and effective_approval_tier() are untouched.
--   • Inviting stays FM/PM/Ops only (`invitable_roles` checks the Executive's
--     own arm before the fm_roles() arm).
--   • OEA only, from 0307, unchanged.
--   • B7 rows an operator has already set by hand (`set_by` not null) are
--     left alone; only the untouched baseline rows move to the new baseline.

set local lock_timeout = '5s';

-- ── 1. The two resolvers ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fm_roles()
 RETURNS user_role[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  -- A regional manager holds the same operational authority as a facility /
  -- properties manager, over a wider place. A PROPERTY manager holds it over a
  -- different discipline — OEA lets and manages tenancies where TFML maintains
  -- plant — but the operational authority itself is identical, which is why
  -- this is one more element and not a parallel set of policies.
  select array['facility_manager', 'property_manager', 'regional_manager',
               'operations_executive']::user_role[];
$function$;

CREATE OR REPLACE FUNCTION public.current_user_property_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Directly assigned properties, exactly as before.
  select s.property_id
    from property_stakeholders s
   where s.user_id = auth.uid()
     and s.property_id is not null
     and exists (select 1 from users u where u.id = auth.uid() and u.deactivated_at is null and u.sign_in_locked_at is null)

  union

  -- Everything beneath a node they are assigned to, at any depth.
  --
  -- The org comparison is between the node rows and is therefore redundant with
  -- the composite foreign keys above. It is kept because this is the function
  -- that decides what a regionally-assigned manager can reach, and a redundant
  -- check costs one comparison while its absence would cost a cross-brand leak.
  select p.id
    from property_stakeholders s
    join org_nodes anc on anc.id = s.node_id and anc.org_id = s.org_id
    join org_nodes n   on n.path like anc.path || '%' and n.org_id = anc.org_id
    join properties p  on p.site_node_id = n.id and p.org_id = anc.org_id
   where s.user_id = auth.uid()
     and s.node_id is not null
     and anc.deleted_at is null
     and n.deleted_at is null
     and p.deleted_at is null
     and exists (select 1 from users u where u.id = auth.uid() and u.deactivated_at is null and u.sign_in_locked_at is null)

  union

  -- 0309. The OEA Executive's place is the whole organisation: every live
  -- property in it, with no assignment needed. This is the one line that turns
  -- every "an FM, on a property they hold" rule into "the Executive, anywhere
  -- in their organisation" — the same way a node assignment does it for a
  -- regional manager, one level up.
  select p.id
    from properties p
    join users u on u.id = auth.uid()
   where u.role = 'operations_executive'
     and p.org_id = u.org_id
     and p.deleted_at is null
     and u.deactivated_at is null
     and u.sign_in_locked_at is null;
$function$;

-- ── 2. The residue that spells the roles out ───────────────────────────────

CREATE OR REPLACE FUNCTION public.complete_work_order(p_ticket_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t tickets%rowtype;
begin
  select * into t from tickets where id = p_ticket_id;
  if t.id is null then raise exception 'that request could not be found'; end if;

  if t.assigned_vendor_id is null
     or t.assigned_vendor_id not in (select current_user_vendor_ids()) then
    raise exception 'only the vendor this job is assigned to can mark it complete';
  end if;
  if not vendor_user_can('manage_work') then
    raise exception 'your account is not set up to report work complete for this company';
  end if;

  if t.status in ('resolved', 'closed') then
    raise exception 'that job is already marked complete';
  end if;

  update tickets set status = 'resolved' where id = p_ticket_id;

  if length(trim(coalesce(p_note, ''))) > 0 then
    insert into ticket_messages (org_id, ticket_id, author, body)
    values (t.org_id, p_ticket_id, 'system',
            'Marked complete by the contractor: ' || trim(p_note));
  end if;

  perform notify_role(
    t.org_id,
    array['admin', 'facility_manager', 'property_manager', 'regional_manager', 'operations_executive']::user_role[],
    'request',
    'A contractor marked a job complete',
    coalesce(nullif(trim(p_note), ''), 'Ready for your verification.'),
    '/dashboard/tickets/' || p_ticket_id::text
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.decline_work_order(p_ticket_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t tickets%rowtype;
begin
  select * into t from tickets where id = p_ticket_id;
  if t.id is null then raise exception 'that request could not be found'; end if;

  if t.assigned_vendor_id is null
     or t.assigned_vendor_id not in (select current_user_vendor_ids()) then
    raise exception 'only the vendor this job is assigned to can decline it';
  end if;
  if not vendor_user_can('manage_work') then
    raise exception 'your account is not set up to accept or decline jobs for this company';
  end if;

  if t.status in ('resolved', 'closed') then
    raise exception 'that job is already finished';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'give a reason of at least 10 characters so the team can re-assign it properly';
  end if;

  update tickets
     set assigned_vendor_id = null,
         assigned_to_user_id = null,
         assigned_at = null,
         acknowledged_at = null,
         status = 'open'
   where id = p_ticket_id;

  insert into ticket_messages (org_id, ticket_id, author, body)
  values (t.org_id, p_ticket_id,
          'system',
          'Declined by the assigned contractor: ' || trim(p_reason));

  perform notify_role(
    t.org_id,
    array['admin', 'facility_manager', 'property_manager', 'regional_manager', 'operations_executive']::user_role[],
    'assignment',
    'A contractor declined a job',
    trim(p_reason),
    '/dashboard/tickets/' || p_ticket_id::text
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_application_desk(p_application_id uuid, p_title text, p_body text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  a tenant_applications%rowtype;
  v_user uuid;
  v_link text;
begin
  select * into a from tenant_applications where id = p_application_id;
  if a.id is null then return; end if;
  v_link := '/dashboard/people/tenancy/' || a.id::text;

  -- Admin: unconditional and org-wide, exactly as 0243 left it.
  perform notify_role(a.org_id, array['admin']::user_role[], 'application',
    p_title, p_body, v_link, 'tenant_application', a.id);

  if a.property_id is null then return; end if;

  for v_user in
    select distinct s.user_id
      from property_stakeholders s
      join users u on u.id = s.user_id
     where s.org_id = a.org_id
       and u.deactivated_at is null
       and u.role in ('facility_manager', 'property_manager', 'regional_manager', 'operations_executive')
       and (
         s.property_id = a.property_id
         or exists (
           select 1
             from properties p
             join org_nodes n   on n.id = p.site_node_id and n.org_id = p.org_id
             join org_nodes anc on n.path like anc.path || '%' and anc.org_id = n.org_id
            where p.id = a.property_id
              and anc.id = s.node_id
              and anc.deleted_at is null
              and n.deleted_at is null
              and p.deleted_at is null
         )
       )
  loop
    perform notify_user(v_user, 'application', p_title, p_body,
      v_link, 'tenant_application', a.id);
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.offer_vendor_introduction(p_target_org_slug text, p_consent_statement text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_vendor vendors%rowtype;
  r vendor_registrations%rowtype;
  v_target uuid;
  v_id uuid;
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  select * into v_vendor from vendors where id = current_user_vendor_id();
  if v_vendor.id is null then
    raise exception 'only a vendor can offer their own registration';
  end if;
  if not vendor_user_can('manage_profile') then
    raise exception 'your account is not set up to share this company''s registration';
  end if;

  select * into r from vendor_registrations where vendor_id = v_vendor.id;
  if r.id is null or r.status <> 'approved' then
    raise exception 'your registration must be approved here before it can be carried anywhere else';
  end if;

  if length(trim(coalesce(p_consent_statement, ''))) < 20 then
    raise exception 'the consent wording shown to you must be recorded with the offer';
  end if;

  select o.id into v_target
    from orgs o
   where lower(o.slug) = lower(trim(coalesce(p_target_org_slug, '')))
     and o.deleted_at is null
   limit 1;

  -- One message for unknown, retired, and "that is where you already are".
  -- Three different refusals would be three different facts about the platform.
  if v_target is null or v_target = v_vendor.org_id then
    raise exception 'that organisation could not be found';
  end if;

  if exists (
    select 1 from vendor_introductions
     where source_vendor_id = v_vendor.id and target_org_id = v_target and status = 'offered'
  ) then
    raise exception 'you have already offered your registration there and it is still waiting';
  end if;

  insert into vendor_introductions (
    source_org_id, source_vendor_id, offered_by, target_org_id,
    consent_statement
  ) values (
    v_vendor.org_id, v_vendor.id, auth.uid(), v_target,
    trim(p_consent_statement)
  )
  returning id into v_id;

  perform notify_role(
    v_target,
    array['admin', 'facility_manager', 'property_manager', 'regional_manager', 'operations_executive']::user_role[],
    'application',
    'A contractor offered their registration',
    v_vendor.name || ' has an approved registration elsewhere on the platform and has consented to share it with you.',
    '/dashboard/vendors/introductions'
  );

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.raise_ops_requisition(p_reference text, p_lines jsonb, p_ticket_id uuid DEFAULT NULL::uuid, p_attachment_path text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
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
  if v_role not in ('fm_ops_staff', 'facility_manager', 'property_manager', 'regional_manager', 'operations_executive', 'admin') then
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
    array['facility_manager', 'property_manager', 'regional_manager', 'operations_executive']::user_role[],
    'payment',
    'A requisition was raised',
    trim(p_reference) || ' awaits your sign-off',
    '/dashboard/approvals/requisitions/' || v_req_id::text
  );

  return v_req_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.request_payout_details(p_party payout_party, p_vendor_id uuid, p_user_id uuid, p_line_id uuid, p_payee_name text, p_contact_email text, p_contact_phone text, p_purpose text, p_token_hash text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid   uuid := auth.uid();
  v_me    users%rowtype;
  v_name  text := nullif(trim(p_payee_name), '');
  v_email text := nullif(lower(trim(coalesce(p_contact_email, ''))), '');
  v_phone text := nullif(regexp_replace(coalesce(p_contact_phone, ''), '[^0-9+]', '', 'g'), '');
  v_line  ops_requisition_lines%rowtype;
  v_req   ops_requisitions%rowtype;
  v_prev  uuid;
  v_id    uuid;
begin
  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;
  if not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;
  select * into v_me from users where id = v_uid;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'the link could not be prepared — try again';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'give an email address or a phone number, so the link has somewhere to go';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'that email address does not look right';
  end if;
  if v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
    raise exception 'that phone number looks too short';
  end if;

  if p_party = 'vendor' then
    if v_me.role not in ('admin', 'finance_approver') then
      raise exception 'only the payment officer or an administrator may ask a contractor for bank details';
    end if;
    -- The name comes off the vendor's own record. A typed name here would let
    -- the page tell a payee they are being paid as somebody else.
    select name into v_name from vendors where id = p_vendor_id and org_id = v_me.org_id;
    if v_name is null then
      raise exception 'that contractor could not be found';
    end if;
    select id into v_prev from payout_detail_requests
     where org_id = v_me.org_id and vendor_id = p_vendor_id
       and submitted_at is null and withdrawn_at is null;

  elsif p_party = 'landlord' then
    if v_me.role not in ('admin', 'finance_approver') then
      raise exception 'only the payment officer or an administrator may ask a landlord for bank details';
    end if;
    select coalesce(full_name, email) into v_name from users
     where id = p_user_id and org_id = v_me.org_id and role = 'property_owner';
    if v_name is null then
      raise exception 'that landlord could not be found';
    end if;
    select id into v_prev from payout_detail_requests
     where org_id = v_me.org_id and user_id = p_user_id
       and submitted_at is null and withdrawn_at is null;

  elsif p_party = 'other' then
    -- The same desks `save_requisition_line_payee` admits, plus the two that
    -- pay and administer — a link that expired needs re-sending by somebody.
    if v_me.role not in ('admin', 'finance_approver', 'fm_ops_staff', 'facility_manager',
                         'property_manager', 'regional_manager', 'operations_executive') then
      raise exception 'you may not name who a requisition line pays';
    end if;
    select * into v_line from ops_requisition_lines
     where id = p_line_id and org_id = v_me.org_id
     for update;
    if v_line.id is null then
      raise exception 'that requisition line could not be found';
    end if;
    if v_line.vendor_id is not null or v_line.payee_recipient_id is not null then
      raise exception 'this line already names who it pays';
    end if;
    if v_line.remittance_id is not null then
      raise exception 'this line has already been paid';
    end if;

    if v_line.payout_request_id is null then
      -- First naming, so before anybody has approved — the rule
      -- `save_requisition_line_payee` has held since 0172: an approver signs
      -- for paying a named person, and that name must not move after they do.
      select * into v_req from ops_requisitions where id = v_line.requisition_id;
      if v_req.status <> 'pending_approval' or exists (
        select 1 from payment_approvals
         where payable_type = 'ops_requisition' and payable_id = v_req.id
      ) then
        raise exception 'this requisition has already begun approval — who a line pays cannot be named now';
      end if;
      if v_name is null or length(v_name) < 2 then
        raise exception 'give the payee''s name as it appears on their bank account';
      end if;
    else
      -- A fresh link to the SAME payee. The name the approvers saw is kept,
      -- whatever was typed this time.
      select payee_name into v_name from payout_detail_requests where id = v_line.payout_request_id;
    end if;

    select id into v_prev from payout_detail_requests
     where requisition_line_id = p_line_id
       and submitted_at is null and withdrawn_at is null;
  else
    raise exception 'unknown payee type';
  end if;

  -- One live link per payee. A second one kills the first, so an old message
  -- sitting in somebody's inbox stops working the moment a new one is sent.
  if v_prev is not null then
    update payout_detail_requests
       set withdrawn_at = now(), withdrawn_by = v_uid
     where id = v_prev;
  end if;

  insert into payout_detail_requests (
    org_id, party, vendor_id, user_id, requisition_line_id,
    payee_name, purpose, contact_email, contact_phone,
    token_hash, expires_at, requested_by
  ) values (
    v_me.org_id, p_party,
    case when p_party = 'vendor'   then p_vendor_id end,
    case when p_party = 'landlord' then p_user_id end,
    case when p_party = 'other'    then p_line_id end,
    v_name,
    left(coalesce(nullif(trim(p_purpose), ''), 'A payment from us to you'), 200),
    v_email, v_phone,
    p_token_hash, now() + interval '14 days', v_uid
  )
  returning id into v_id;

  if p_party = 'other' then
    update ops_requisition_lines set payout_request_id = v_id where id = p_line_id;
  end if;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_requisition_line_payee(p_line_id uuid, p_display_name text, p_account_name text, p_account_number_last4 text, p_recipient_code text, p_gateway text DEFAULT 'paystack'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_org  uuid;
  v_line ops_requisition_lines%rowtype;
  v_req  ops_requisitions%rowtype;
  v_recipient_id uuid;
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
  if v_role not in ('fm_ops_staff', 'facility_manager', 'property_manager', 'regional_manager', 'operations_executive', 'admin') then
    raise exception 'only operational staff may set who a requisition line pays';
  end if;

  select * into v_line from ops_requisition_lines where id = p_line_id;
  if v_line.id is null or v_line.org_id <> v_org then
    raise exception 'that requisition line could not be found';
  end if;
  if v_line.vendor_id is not null then
    raise exception 'this line already names a registered vendor — a line pays one place, not two';
  end if;

  select * into v_req from ops_requisitions where id = v_line.requisition_id;
  -- Locked once the chain has started: a payee changed after an approver has
  -- already acted, trusting the original one, is the integrity gap this
  -- refuses. The amount has the same protection at disbursement (0151); the
  -- payee gets it here, at the point it can still be changed safely.
  if v_req.status <> 'pending_approval' or exists (
    select 1 from payment_approvals
     where payable_type = 'ops_requisition' and payable_id = v_req.id
  ) then
    raise exception 'this requisition has already begun approval — the payee on a line cannot change now';
  end if;

  if p_recipient_code is null or length(trim(p_recipient_code)) = 0 then
    raise exception 'the bank did not return a usable recipient — nothing has been saved';
  end if;

  insert into payout_recipients (
    org_id, party, display_name, account_name, account_number_last4,
    gateway, recipient_code, currency, verified_at, created_by
  ) values (
    v_org, 'other', trim(p_display_name), trim(p_account_name), p_account_number_last4,
    -- ⚠️ `gateway` is a typed enum (`payment_gateway`), not text — an
    -- unqualified text literal fails with "column is of type payment_gateway
    -- but expression is of type text". Caught by the requisition smoke test,
    -- not by review.
    p_gateway::payment_gateway, trim(p_recipient_code), 'NGN', now(), v_uid
  )
  returning id into v_recipient_id;

  update ops_requisition_lines
     set payee_recipient_id = v_recipient_id
   where id = p_line_id;

  return v_recipient_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_vendor_registration()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_vendor_id uuid := current_user_vendor_id();
  r vendor_registrations%rowtype;
  v_missing text[];
  v_name text;
  v_org uuid;
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if v_vendor_id is null then
    raise exception 'only a vendor can submit their own registration';
  end if;
  if not vendor_user_can('manage_profile') then
    raise exception 'your account is not set up to submit this company''s registration';
  end if;

  select * into r from vendor_registrations where vendor_id = v_vendor_id for update;
  if r.id is null then
    raise exception 'there is nothing to submit yet';
  end if;
  if r.status = 'submitted' then
    raise exception 'this registration is already with the team for review';
  end if;
  if r.status = 'approved' then
    raise exception 'this registration has already been approved';
  end if;

  select array(select vendor_registration_missing(v_vendor_id)) into v_missing;
  if cardinality(v_missing) > 0 then
    raise exception 'still outstanding: %', array_to_string(v_missing, ', ');
  end if;

  update vendor_registrations
     set status = 'submitted', submitted_at = now(), submitted_by = auth.uid(),
         updated_at = now()
   where id = r.id;

  select name, org_id into v_name, v_org from vendors where id = v_vendor_id;

  perform notify_role(
    v_org,
    array['admin', 'facility_manager', 'property_manager', 'regional_manager', 'operations_executive']::user_role[],
    -- 'application' is the notification kind for "a vendor thing to review"
    -- (0025's allowed list); there is no 'vendor' kind and adding one would
    -- widen a CHECK that every existing consumer already switches on.
    'application',
    'A contractor submitted their registration',
    v_name || ' has completed their registration pack and it is ready to review.',
    '/dashboard/vendors/' || v_vendor_id::text
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.property_finance_roles()
 RETURNS user_role[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select array['property_manager', 'regional_manager', 'operations_executive']::user_role[];
$function$;

drop policy if exists vendor_properties_write on vendor_properties;
create policy vendor_properties_write on vendor_properties
  as permissive for all to public
  using (((org_id = current_user_org_id()) AND (current_user_role() = ANY (ARRAY['admin'::user_role, 'facility_manager'::user_role, 'property_manager'::user_role, 'regional_manager'::user_role, 'operations_executive'::user_role]))))
  with check (((org_id = current_user_org_id()) AND (current_user_role() = ANY (ARRAY['admin'::user_role, 'facility_manager'::user_role, 'property_manager'::user_role, 'regional_manager'::user_role, 'operations_executive'::user_role]))));

drop policy if exists payment_intents_insert on payment_intents;
create policy payment_intents_insert on payment_intents
  as permissive for insert to public
  with check (((org_id = current_user_org_id()) AND (current_user_role() = ANY (ARRAY['admin'::user_role, 'finance_approver'::user_role, 'facility_manager'::user_role, 'property_manager'::user_role, 'regional_manager'::user_role, 'operations_executive'::user_role]))));

drop policy if exists payments_insert on payments;
create policy payments_insert on payments
  as permissive for insert to public
  with check (((org_id = current_user_org_id()) AND (current_user_role() = ANY (ARRAY['admin'::user_role, 'facility_manager'::user_role, 'property_manager'::user_role, 'regional_manager'::user_role, 'operations_executive'::user_role]))));

drop policy if exists vendor_applications_staff_select on vendor_applications;
create policy vendor_applications_staff_select on vendor_applications
  as permissive for select to authenticated
  using (((org_id = current_user_org_id()) AND (current_user_role() = ANY (ARRAY['admin'::user_role, 'facility_manager'::user_role, 'property_manager'::user_role, 'regional_manager'::user_role, 'operations_executive'::user_role]))));

drop policy if exists vendor_applications_staff_update on vendor_applications;
create policy vendor_applications_staff_update on vendor_applications
  as permissive for update to authenticated
  using (((org_id = current_user_org_id()) AND (current_user_role() = ANY (ARRAY['admin'::user_role, 'facility_manager'::user_role, 'property_manager'::user_role, 'regional_manager'::user_role, 'operations_executive'::user_role]))))
  with check ((org_id = current_user_org_id()));

-- ── 3. The permission baseline ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.b7_grants(p_role user_role, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
        when p_capability = 'tickets.assign_without_review' then false
        when p_capability = 'training.read' then false
        when p_capability = 'records.export' then false

        when p_role = 'admin' then true

        -- 0281. Placed ABOVE the role-specific arms deliberately: those arms are
        -- closed lists, and a capability added to the bottom of this CASE would
        -- never be reached for `executive`, `regional_manager` or either payment
        -- desk. The three confirmation desks are absent by intent, not omission
        -- — recording a claim disqualifies you from confirming it (0282's
        -- maker-checker), so granting it to a chain role hands them a way to
        -- take themselves out of the chain. `finance_approver` is the deliberate
        -- exception: taking a walk-in payment at the finance desk is the single
        -- commonest way one of these arrives, and the consequence — that a
        -- colleague must confirm it — is the control working, exactly as 0142
        -- says. 13 Sept 2026: unchanged by the board's reversal above — the
        -- Officer still takes the walk-in, the Approver still confirms it, and
        -- a walk-in the Officer takes is confirmed by someone else regardless.
        when p_capability = 'payments.record_offline' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager', 'finance_approver',
          'operations_executive'
        )

        -- 0307. The OEA Executive: org-wide sight of operations, dispatch and
        -- closure, and onboarding. Nothing financial beyond the requisitions
        -- the chain hands them (which is not a capability — decision 7), no
        -- structure (hierarchy, properties, leases), no vendor decisions, no
        -- export. Placed after `payments.record_offline`, which they do not
        -- hold: recording a claim is a confirmation desk's conflict.
        -- 0309: everything a facilities/properties/regional manager holds,
        -- organisation-wide, plus the org-wide reads 0307 gave. Bounded by
        -- `current_user_property_ids()`, which for the Executive is every
        -- property in their organisation.
        when p_role = 'operations_executive' then p_capability in (
          'tickets.read_all', 'tickets.triage_unassigned',
          'tickets.assign', 'tickets.close',
          'properties.read_all', 'assets.read', 'vendors.read',
          'bi.read', 'people.invite',
          'assets.write', 'assets.import',
          'vendors.write', 'vendors.evaluate', 'vendors.recommend', 'vendors.approve',
          'properties.write', 'units.assign_occupant', 'hierarchy.write',
          'applications.recommend', 'applications.approve',
          'sc.manage', 'leases.write'
        )

        when p_role = 'executive' then p_capability in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when p_role = 'payment_audit_approver' then p_capability in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        -- 0246, unchanged by 13 Sept 2026's reversal: the payment approver is
        -- the senior accounting desk and already held sc.manage before this
        -- migration. What moved is who else does.
        when p_role = 'payment_approver' then p_capability in (
          'vendors.read', 'bi.read', 'properties.read_all',
          'assets.read', 'sc.read_all', 'sc.manage'
        )

        when p_role = 'regional_manager' then p_capability in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.recommend', 'applications.approve',
          'hierarchy.write', 'sc.manage', 'leases.write',
          'vendors.recommend', 'vendors.approve'
        )

        when p_capability = 'tickets.read_all' then false

        when p_capability in ('assets.read', 'sc.read_all', 'properties.read_all')
          then p_role = 'finance_approver'

        when p_capability in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite', 'hierarchy.write',
                         'vendors.recommend',
                         'applications.recommend')
          then p_role in ('facility_manager', 'property_manager')

        when p_capability = 'vendors.read'
          then p_role in ('facility_manager', 'property_manager', 'finance_approver')

        -- 13 Sept 2026 (board). Was `p_role in ('finance_approver',
        -- 'property_manager')` since 0249. The Payment Officer's role narrows
        -- to disbursement; administering the service-charge budget and its
        -- apportionment is not part of "dispensing outward payments" and moves
        -- fully to the Approver, who already held it via the closed-list arm
        -- above. property_manager's own grant (0249) is untouched — every
        -- write it unlocks is still bounded to a property they hold.
        when p_capability = 'sc.manage'
          then p_role = 'property_manager'

        when p_capability = 'leases.write'
          then p_role = 'property_manager'

        when p_capability = 'bi.read'
          then p_role in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when p_capability = 'people.deactivate' then false
        when p_capability = 'tickets.triage_unassigned' then false

        else false
  end;
$function$;

-- Rows still at the baseline 0307 seeded (never set by a person) move to the
-- new baseline; any row an operator changed is theirs and is not touched.
update role_permissions rp
   set granted = b7_grants(rp.role, rp.capability)
 where rp.role = 'operations_executive'
   and rp.set_by is null
   and rp.granted is distinct from b7_grants(rp.role, rp.capability);

-- ── 4. Assertions ───────────────────────────────────────────────────────────
do $$
declare
  o record;
  v_last user_role[];
  v_bad text;
begin
  if not ('operations_executive' = any (fm_roles())) then
    raise exception '0309: the Executive must be an operational role';
  end if;

  if 'operations_executive' = any (oversight_roles())
     or 'operations_executive' = any (payment_chain_roles())
     or 'operations_executive' = any (request_read_all_roles())
     or effective_approval_tier('operations_executive', 3::smallint) is not null then
    raise exception '0309: the Executive reached a money or oversight resolver';
  end if;

  if invitable_roles('operations_executive')
     is distinct from array['facility_manager', 'fm_ops_staff', 'property_manager']::user_role[] then
    raise exception '0309: becoming operational must not widen who the Executive invites, got %',
      invitable_roles('operations_executive');
  end if;

  if b7_grants('operations_executive', 'records.export')
     or b7_grants('operations_executive', 'sc.read_all') is distinct from false
     or b7_grants('operations_executive', 'tickets.assign_without_review') then
    raise exception '0309: the Executive baseline gained a control it must not hold';
  end if;

  select string_agg(c.key, ', ' order by c.key) into v_bad
    from capabilities c
   where not c.locked
     and b7_grants('regional_manager', c.key)
     and not b7_grants('operations_executive', c.key);
  if v_bad is not null then
    raise exception '0309: the Executive lacks what a regional manager holds: %', v_bad;
  end if;

  for o in select id from orgs loop
    select s.required_roles into v_last
      from payment_chain_stages(o.id) s order by s.stage_order desc limit 1;
    if 'operations_executive' = any (v_last) then
      raise exception '0309: the Executive reached the final payment stage on org %', o.id;
    end if;
  end loop;
end $$;
