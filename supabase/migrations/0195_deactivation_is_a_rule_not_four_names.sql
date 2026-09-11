-- Deactivation is a rule, not a list of four names.
--
-- 0194 made `deactivated_at` mean something and proved it over four
-- resolvers. Reviewing it against the live catalogue rather than against its own
-- diff found the same defect twice more, in the same shape:
--
--     89 functions in `public` reference auth.uid()
--     60 reach it through current_user_org_id() / role() / property_ids() / vendor_ids()
--     29 held auth.uid() directly, and 0194 had touched none of them
--
-- ── What was actually open ────────────────────────────────────────────────
-- `my_requests`, `my_tenancies`, `my_rent_charges`, `my_service_charges`,
-- `my_payment_history`, `my_approval_limit` and `my_channel_consents` are all
-- SECURITY DEFINER, all granted to `authenticated`, and all gate on nothing but
-- `<column> = auth.uid()`. A deactivated tenant holding a live JWT reads every
-- one of them over /rest/v1/rpc directly. 0194's sign-out lives in
-- app/dashboard/layout.tsx, and no RPC has ever passed through a React layout.
--
-- `raise_ops_requisition` and `save_requisition_line_payee` are worse. Being
-- DEFINER they read `select role, org_id from users where id = v_uid` with RLS
-- off, so a deactivated ops staffer kept their role and could still raise a
-- requisition — a request for money.
--
-- `resolve_chat_sender` is the third shape. It is reached from the WhatsApp /
-- Telegram webhook through the SERVICE-ROLE client, so RLS never runs and none
-- of 0194's four resolvers are consulted. A deactivated person kept the primary
-- intake channel B8 gives them.
--
-- 📌 **This is 0185's lesson arriving a second time.** 0194 was written against
-- the four functions its author had in hand; 0185 already records that a
-- migration written against the diff rather than against the rule closes the
-- instances and leaves the class. So this one is generated from the catalogue
-- (`scripts/generate-deactivation-guards.mjs`) and ends by asserting the RULE —
-- anything reaching auth.uid() must reach it through a deactivation-aware path,
-- or be named with the reason it cannot.
--
-- ── One resolver, extended — again ────────────────────────────────────────
-- Decision 8 forbids a second scoping mechanism beside the first. `active_uid()`
-- is not one: it is the same extension applied one level lower. The functions
-- above do not ask "what may I reach", they ask "who am I" — and they asked
-- `auth`, which has no opinion about deactivation because deactivation is our
-- concept and not the auth provider's. `active_uid()` is that question answered
-- with our concept included, and the rewrite is a pure substitution so nothing
-- else in any body moves.
--
-- ⚠️ Generated, not typed. Every body below is `pg_get_functiondef` output with
-- one mechanical edit applied. Regenerate rather than hand-editing.
--
-- Verified by scripts/verify-deactivation.mjs.

-- ── Who am I, if I am still anyone ────────────────────────────────────────
-- NULL for a deactivated account, and NULL for an account with no profile row
-- at all — both of which make `<column> = active_uid()` match no row rather
-- than every row. It fails closed in the only direction it can fail.
create or replace function active_uid()
returns uuid language sql stable security definer set search_path = public as $$
  select u.id from users u where u.id = auth.uid() and u.deactivated_at is null;
$$;

revoke all on function active_uid() from public, anon;
grant execute on function active_uid() to authenticated, service_role;

comment on function active_uid is
  'auth.uid(), but NULL once the account is deactivated. For the functions that ask who the caller IS rather than what they may reach - the self-scoped my_* readers and the vendor/attachment predicates. Added by 0195, after 0194 fixed four resolvers and left twenty-nine direct callers.';

-- ── The bodies, rewritten from the catalogue ──────────────────────────────
-- my_requests: auth.uid() -> active_uid(), 1 occurrence(s).
CREATE OR REPLACE FUNCTION public.my_requests()
 RETURNS TABLE(ticket_id uuid, summary text, category text, urgency text, status text, created_at timestamp with time zone, first_response_at timestamp with time zone, resolved_at timestamp with time zone, hours_open numeric, assigned_to text, awaiting_review boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    t.id,
    coalesce(t.summary, left(t.message_text, 120)),
    coalesce(t.category::text, 'unclassified'),
    coalesce(t.urgency::text, 'normal'),
    t.status::text,
    t.created_at,
    t.first_response_at,
    t.resolved_at,
    round(extract(epoch from (coalesce(t.resolved_at, now()) - t.created_at)) / 3600.0, 1),
    -- The vendor's name only. Not who dispatched it, not internal notes — a
    -- tenant is owed progress on their own request, not the org's workings.
    v.name,
    -- Done, has a vendor to rate, and no tenant-source row exists yet.
    (
      t.status in ('resolved', 'closed')
      and t.assigned_vendor_id is not null
      and not exists (
        select 1 from vendor_evaluations ve
         where ve.ticket_id = t.id and ve.source = 'tenant'
      )
    )
  from tickets t
  left join vendors v on v.id = t.assigned_vendor_id
  -- The whole boundary, in one line: this is SECURITY DEFINER, so this WHERE is
  -- the only thing between a caller and every ticket in the database.
  where t.sender_id = active_uid()
  order by t.created_at desc;
$function$
;

-- my_tenancies: auth.uid() -> active_uid(), 1 occurrence(s).
CREATE OR REPLACE FUNCTION public.my_tenancies()
 RETURNS TABLE(lease_id uuid, property_name text, unit_label text, status lease_status, start_date date, end_date date, days_to_expiry integer, rent_amount numeric, rent_frequency rent_frequency, currency text, rent_billed numeric, rent_paid numeric, rent_outstanding numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    l.id, p.name, u.label, l.status, l.start_date, l.end_date,
    (l.end_date - current_date)::integer,
    l.rent_amount, l.rent_frequency, l.currency,
    coalesce(c.billed, 0),
    coalesce(c.paid, 0),
    coalesce(c.billed, 0) - coalesce(c.paid, 0)
  from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join lateral (
    select sum(rc.amount) as billed, sum(rc.amount_paid) as paid
      from rent_charges rc where rc.lease_id = l.id
  ) c on true
  -- The whole boundary, in one line: this function is SECURITY DEFINER, so its
  -- WHERE clause is the only thing standing between a caller and every tenancy
  -- in the database.
  where l.tenant_user_id = active_uid()
    and l.deleted_at is null;
$function$
;

-- my_rent_charges: auth.uid() -> active_uid(), 1 occurrence(s).
CREATE OR REPLACE FUNCTION public.my_rent_charges()
 RETURNS TABLE(charge_id uuid, lease_id uuid, property_name text, unit_label text, period_start date, period_end date, due_date date, amount numeric, amount_paid numeric, outstanding numeric, currency text, status text, open_intent_reference text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    rc.id, rc.lease_id, p.name, u.label,
    rc.period_start, rc.period_end, rc.due_date,
    rc.amount, rc.amount_paid,
    rc.amount - rc.amount_paid,
    rc.currency, rc.status::text,
    -- `pending` only, matching the live guard in create_rent_payment_intent
    -- above — a `part_paid` intent is not a link waiting to be followed.
    (select pi.gateway_reference
       from payment_intents pi
      where pi.rent_charge_id = rc.id
        and pi.status = 'pending'
      order by pi.created_at desc
      limit 1)
  from rent_charges rc
  join leases l     on l.id = rc.lease_id
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  -- The whole boundary, in one line — the same shape `my_tenancies()` uses,
  -- and for the same reason: this is SECURITY DEFINER, so this WHERE clause is
  -- all that stands between a caller and every rent charge in the database.
  where l.tenant_user_id = active_uid()
    and l.deleted_at is null
  order by rc.period_start desc;
$function$
;

-- my_service_charges: auth.uid() -> active_uid(), 1 occurrence(s).
CREATE OR REPLACE FUNCTION public.my_service_charges()
 RETURNS TABLE(charge_id uuid, property_or_unit text, billing_period text, due_date date, amount numeric, amount_paid numeric, outstanding numeric, apportionment_pct numeric, status text, open_intent_reference text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    sc.id, sc.property_or_unit, sc.billing_period, sc.due_date,
    sc.amount, sc.amount_paid, sc.amount - sc.amount_paid,
    sc.apportionment_pct, sc.status,
    (select pi.gateway_reference
       from payment_intents pi
      where pi.service_charge_id = sc.id
        and pi.status = 'pending'
      order by pi.created_at desc
      limit 1)
  from service_charges sc
  -- The whole boundary, in one line. This is SECURITY DEFINER, so this WHERE
  -- clause is all that stands between a caller and every invoice in the
  -- database.
  where sc.billed_to_user_id = active_uid()
    and sc.deleted_at is null
  order by sc.billing_period desc nulls last, sc.due_date desc nulls last;
$function$
;

-- my_payment_history: auth.uid() -> active_uid(), 1 occurrence(s).
CREATE OR REPLACE FUNCTION public.my_payment_history()
 RETURNS TABLE(intent_id uuid, purpose text, reference text, description text, amount_expected numeric, amount_paid numeric, currency text, status text, paid_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    pi.id,
    pi.purpose::text,
    pi.gateway_reference,
    coalesce(sc.property_or_unit || ' · ' || sc.billing_period, p.name, replace(pi.purpose::text, '_', ' ')),
    pi.amount_expected, pi.amount_paid, pi.currency, pi.status::text,
    pi.paid_at, pi.created_at
  from payment_intents pi
  left join service_charges sc on sc.id = pi.service_charge_id
  left join properties p on p.id = pi.property_id
  where pi.payer_user_id = active_uid()
  order by coalesce(pi.paid_at, pi.created_at) desc;
$function$
;

-- my_approval_limit: auth.uid() -> active_uid(), 1 occurrence(s).
CREATE OR REPLACE FUNCTION public.my_approval_limit()
 RETURNS TABLE(threshold numeric, unlimited boolean, may_approve boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    case effective_approval_tier(u.role, u.approval_tier)
      when 1 then coalesce(s.tier1_threshold_amount, 100000)
      when 2 then coalesce(s.approval_threshold_amount, 1000000)
      else null                                  -- tier 3, or no authority
    end,
    effective_approval_tier(u.role, u.approval_tier) = 3,
    effective_approval_tier(u.role, u.approval_tier) is not null
    from users u
    left join payment_settings s on s.org_id = u.org_id
   where u.id = active_uid();
$function$
;

-- my_channel_consents: auth.uid() -> active_uid(), 1 occurrence(s).
CREATE OR REPLACE FUNCTION public.my_channel_consents()
 RETURNS TABLE(channel text, action text, statement text, channel_identifier text, recorded_at timestamp with time zone, recorded_via text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.channel, c.action, c.statement, c.channel_identifier,
         c.recorded_at, c.recorded_via
  from channel_consents c
  where c.user_id = active_uid()
  order by c.recorded_at desc, c.id desc;
$function$
;

-- my_notifications: auth.uid() -> active_uid(), 1 occurrence(s).
CREATE OR REPLACE FUNCTION public.my_notifications(p_days integer DEFAULT 30)
 RETURNS TABLE(id uuid, kind text, title text, body text, link text, read_at timestamp with time zone, created_at timestamp with time zone, entity_type text, entity_id uuid, target_live boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select
    n.id, n.kind, n.title, n.body, n.link, n.read_at, n.created_at,
    n.entity_type, n.entity_id,
    case
      when n.entity_id is null then true          -- a static link cannot dangle
      when n.entity_type = 'ticket'   then exists (select 1 from tickets t    where t.id = n.entity_id)
      when n.entity_type = 'payment'  then exists (select 1 from payments p   where p.id = n.entity_id)
      when n.entity_type = 'asset'    then exists (select 1 from assets a     where a.id = n.entity_id)
      when n.entity_type = 'property' then exists (select 1 from properties r where r.id = n.entity_id)
      when n.entity_type = 'lease'    then exists (select 1 from leases l     where l.id = n.entity_id)
      else true
    end
  from user_notifications n
  where n.user_id = active_uid()
    and (n.read_at is null or n.created_at >= now() - make_interval(days => greatest(p_days, 1)))
  order by n.read_at nulls first, n.created_at desc;
$function$
;

-- vendor_user_can: auth.uid() -> active_uid(), 2 occurrence(s).
CREATE OR REPLACE FUNCTION public.vendor_user_can(p_capability vendor_capability)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from vendor_users vu
     where vu.user_id = active_uid()
       and (vu.is_owner or p_capability = any (vu.capabilities))
  )
  -- A legacy primary login that has not been backfilled holds everything, so
  -- this migration cannot take away access somebody had this morning.
  or exists (select 1 from vendors v where v.user_id = active_uid());
$function$
;

-- ticket_attachment_deletable: auth.uid() -> active_uid(), 1 occurrence(s).
CREATE OR REPLACE FUNCTION public.ticket_attachment_deletable(p_ticket_id uuid, p_uploaded_by uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_uploaded_by = active_uid()
     and exists (
       select 1 from tickets t
        where t.id = p_ticket_id
          and t.status not in ('resolved', 'closed')
     );
$function$
;

-- record_payment_approval: guard injected after the opening begin.
CREATE OR REPLACE FUNCTION public.record_payment_approval(p_payable_type text, p_payable_id uuid, p_stage smallint, p_decision text, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_actor uuid := auth.uid();
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if v_actor is null then
    raise exception 'your session expired — sign in again';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'a stage is either approved or rejected';
  end if;
  if p_decision = 'rejected' and length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'tell them why in at least 10 characters — a refusal nobody can act on is a dead end';
  end if;

  insert into payment_approvals (
    org_id, payable_type, payable_id, stage_order,
    actor_id, actor_role, actor_tier, amount, decision, reason
  ) values (
    -- org, role, tier and amount are all overwritten by the trigger from the
    -- authoritative records. These placeholders satisfy NOT NULL and nothing else.
    '00000000-0000-0000-0000-000000000000', p_payable_type, p_payable_id, p_stage,
    v_actor, 'viewer', null, 1, p_decision, nullif(trim(coalesce(p_reason, '')), '')
  )
  returning id into v_id;

  return v_id;
end;
$function$
;

-- create_landlord_remittance: guard injected after the opening begin.
CREATE OR REPLACE FUNCTION public.create_landlord_remittance(p_org_id uuid, p_landlord_user_id uuid, p_property_id uuid, p_period text, p_gross numeric, p_reference text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  st payment_settings%rowtype;
  v_recipient uuid;
  v_mgmt numeric(16,2);
  v_admin numeric(16,2);
  v_net numeric(16,2);
  v_id uuid;
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if p_gross is null or p_gross <= 0 then
    raise exception 'there is nothing to remit';
  end if;

  select id into v_recipient from payout_recipients
   where org_id = p_org_id and party = 'landlord' and user_id = p_landlord_user_id
     and active and recipient_code is not null
   limit 1;
  if v_recipient is null then
    raise exception 'no verified bank recipient is on file for this landlord';
  end if;

  select * into st from payment_settings where org_id = p_org_id;

  -- Percentages default to 0 (0027), so an org that has not agreed a fee model
  -- remits the full amount rather than guessing one. Rounding is applied per
  -- fee and the net takes the remainder, so the three always sum to the gross —
  -- the table's own CHECK constraint would reject them otherwise.
  v_mgmt  := round(p_gross * coalesce(st.management_fee_percent, 0) / 100, 2);
  v_admin := round(p_gross * coalesce(st.admin_fee_percent, 0) / 100, 2);
  v_net   := p_gross - v_mgmt - v_admin;

  if v_net <= 0 then
    -- `%%` is a literal percent sign in RAISE and consumes no argument, so the
    -- sign is spelled out rather than risking a placeholder/argument mismatch.
    raise exception 'combined fees of % percent would leave the landlord nothing',
      coalesce(st.management_fee_percent, 0) + coalesce(st.admin_fee_percent, 0);
  end if;

  insert into remittances (
    org_id, party, recipient_id, property_id, period,
    gross_amount, management_fee, admin_fee, net_amount,
    reference, created_by
  ) values (
    p_org_id, 'landlord', v_recipient, p_property_id, p_period,
    p_gross, v_mgmt, v_admin, v_net,
    p_reference, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$function$
;

-- raise_ops_requisition: guard injected after the opening begin.
CREATE OR REPLACE FUNCTION public.raise_ops_requisition(p_reference text, p_lines jsonb, p_ticket_id uuid DEFAULT NULL::uuid, p_attachment_path text DEFAULT NULL::text)
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

  insert into ops_requisitions (org_id, ticket_id, raised_by, reference, invoice_attachment_path)
  values (v_org, p_ticket_id, v_uid, trim(p_reference), v_path)
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
$function$
;

-- save_requisition_line_payee: guard injected after the opening begin.
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
  if v_role not in ('fm_ops_staff', 'facility_manager', 'property_manager', 'regional_manager', 'admin') then
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
$function$
;

-- submit_vendor_registration: guard injected after the opening begin.
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
    array['admin', 'facility_manager', 'property_manager', 'regional_manager']::user_role[],
    -- 'application' is the notification kind for "a vendor thing to review"
    -- (0025's allowed list); there is no 'vendor' kind and adding one would
    -- widen a CHECK that every existing consumer already switches on.
    'application',
    'A contractor submitted their registration',
    v_name || ' has completed their registration pack and it is ready to review.',
    '/dashboard/vendors/' || v_vendor_id::text
  );
end;
$function$
;

-- offer_vendor_introduction: guard injected after the opening begin.
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
    array['admin', 'facility_manager', 'property_manager', 'regional_manager']::user_role[],
    'application',
    'A contractor offered their registration',
    v_vendor.name || ' has an approved registration elsewhere on the platform and has consented to share it with you.',
    '/dashboard/vendors/introductions'
  );

  return v_id;
end;
$function$
;

-- update_my_profile: guard injected after the opening begin.
CREATE OR REPLACE FUNCTION public.update_my_profile(p_full_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name text := nullif(trim(p_full_name), '');
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if auth.uid() is null then
    raise exception 'you must be signed in';
  end if;

  -- A blank name is refused rather than stored. Everything that addresses a
  -- person falls back to their email when `full_name` is null, so an empty
  -- string would be strictly worse than never having set one — it renders as a
  -- gap rather than as an address.
  if v_name is null then
    raise exception 'give a name we can address you by';
  end if;
  if length(v_name) > 120 then
    raise exception 'that name is too long (120 characters maximum)';
  end if;

  update users set full_name = v_name where id = auth.uid();
end;
$function$
;

-- update_my_notification_prefs: guard injected after the opening begin.
CREATE OR REPLACE FUNCTION public.update_my_notification_prefs(p_phone text DEFAULT NULL::text, p_telegram_chat_id text DEFAULT NULL::text, p_email boolean DEFAULT true, p_whatsapp boolean DEFAULT false, p_sms boolean DEFAULT false, p_telegram boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_phone text := nullif(trim(p_phone), '');
  v_tg text := nullif(trim(p_telegram_chat_id), '');
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if auth.uid() is null then
    raise exception 'you must be signed in';
  end if;

  update users set
    phone            = v_phone,
    telegram_chat_id = v_tg,
    notify_email     = coalesce(p_email, true),
    -- Both ride on the phone number; without one they are not deliverable.
    notify_whatsapp  = coalesce(p_whatsapp, false) and v_phone is not null,
    notify_sms       = coalesce(p_sms, false) and v_phone is not null,
    notify_telegram  = coalesce(p_telegram, false) and v_tg is not null
  where id = auth.uid();
end;
$function$
;

-- record_my_channel_consent: guard injected after the opening begin.
CREATE OR REPLACE FUNCTION public.record_my_channel_consent(p_channel text, p_statement text, p_identifier text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_id  uuid;
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if v_uid is null then
    raise exception 'you must be signed in';
  end if;
  if p_channel not in ('whatsapp', 'telegram', 'sms', 'email') then
    raise exception 'unknown channel';
  end if;
  if p_statement is null or length(trim(p_statement)) = 0 then
    -- Refused rather than defaulted. A consent row with no statement is
    -- indistinguishable from the tick box this table replaced.
    raise exception 'a consent record must carry the wording that was shown';
  end if;

  select org_id into v_org from users where id = v_uid;
  if v_org is null then
    raise exception 'no organisation for this account';
  end if;

  insert into channel_consents (
    org_id, user_id, channel, action, statement, channel_identifier,
    recorded_by, recorded_via
  )
  values (
    v_org, v_uid, p_channel, 'granted', trim(p_statement),
    nullif(trim(p_identifier), ''), v_uid, 'self_service'
  )
  returning id into v_id;

  return v_id;
end;
$function$
;

-- withdraw_my_channel_consent: guard injected after the opening begin.
CREATE OR REPLACE FUNCTION public.withdraw_my_channel_consent(p_channel text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_id  uuid;
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if v_uid is null then
    raise exception 'you must be signed in';
  end if;
  if p_channel not in ('whatsapp', 'telegram', 'sms', 'email') then
    raise exception 'unknown channel';
  end if;

  select org_id into v_org from users where id = v_uid;
  if v_org is null then
    raise exception 'no organisation for this account';
  end if;

  insert into channel_consents (
    org_id, user_id, channel, action, statement, recorded_by, recorded_via
  )
  values (v_org, v_uid, p_channel, 'withdrawn', null, v_uid, 'self_service')
  returning id into v_id;

  update users set
    notify_whatsapp = case when p_channel = 'whatsapp' then false else notify_whatsapp end,
    notify_telegram = case when p_channel = 'telegram' then false else notify_telegram end,
    notify_sms      = case when p_channel = 'sms'      then false else notify_sms      end,
    -- Email is NOT switched off here. It is the fallback of last resort in the
    -- B8 cascade and the only channel guaranteed to carry a notice someone is
    -- contractually owed -- a statement, an invoice, a decision. Withdrawing
    -- email consent is recorded, and it stops MARKETING, but it cannot leave a
    -- person with no way to receive what their tenancy entitles them to.
    notify_email    = notify_email
  where id = v_uid;

  return v_id;
end;
$function$
;

-- apply_reporter_urgency: guard injected after the opening begin.
CREATE OR REPLACE FUNCTION public.apply_reporter_urgency(p_ticket_id uuid, p_urgency text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t tickets%rowtype;
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if p_urgency not in ('critical', 'high', 'normal', 'low') then
    return false;
  end if;

  select * into t from tickets
   where id = p_ticket_id
     and status not in ('resolved', 'closed')
   for update;

  if t.id is null then
    return false;
  end if;

  -- A human has since judged this. The reporter's opinion is recorded as a
  -- message but does not overwrite a decision an operator made deliberately.
  if t.urgency_source = 'staff' then
    insert into ticket_messages (org_id, ticket_id, author, channel, body)
    values (t.org_id, t.id, 'reporter', t.channel::text,
            format('Asked for priority %s (not applied — an operator had already set it).', p_urgency));
    return false;
  end if;

  update tickets
     set urgency = p_urgency::ticket_urgency,
         urgency_source = 'reporter',
         urgency_changed_at = now(),
         -- Someone telling us it is worse than we thought is exactly the case a
         -- person should look at, so the review flag is raised, never cleared.
         requires_human_review = case
           when p_urgency in ('critical', 'high') then true
           else requires_human_review
         end
   where id = t.id;

  -- `t` still holds the row as it was read above, so both messages below
  -- report the BEFORE value correctly.
  insert into ticket_messages (org_id, ticket_id, author, channel, body)
  values (t.org_id, t.id, 'reporter', t.channel::text,
          format('Priority corrected by the reporter: %s → %s.', t.urgency, p_urgency));

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (t.org_id, auth.uid(), 'ticket.urgency_corrected_by_reporter', 'ticket', t.id,
          jsonb_build_object('urgency', t.urgency, 'source', t.urgency_source),
          jsonb_build_object('urgency', p_urgency, 'source', 'reporter'));

  return true;
end;
$function$
;

-- resolve_chat_sender: deactivation clause appended to both org anchors.
CREATE OR REPLACE FUNCTION public.resolve_chat_sender(p_org_id uuid, p_sender_ref text)
 RETURNS TABLE(user_id uuid, property_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_digits text;
  v_user   uuid;
  v_prop   uuid;
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

  select u.id into v_user
    from users u
   where u.org_id = p_org_id
     and u.deactivated_at is null                       -- 0195
     and u.phone is not null
     and right(regexp_replace(u.phone, '\D', '', 'g'), 10) = v_digits;

  -- Their unit gives the property. Again exactly one: a tenant occupying two
  -- units gives no basis to file the request against either, so it stays
  -- unassigned and a human decides.
  select count(*) into v_n
    from units un
   where un.occupant_user_id = v_user
     and un.org_id = p_org_id
     and un.property_id is not null;

  if v_n = 1 then
    select un.property_id into v_prop
      from units un
     where un.occupant_user_id = v_user
       and un.org_id = p_org_id
       and un.property_id is not null;
  end if;

  return query select v_user, v_prop;
end;
$function$
;

comment on function resolve_chat_sender is
  'Who is writing to us on WhatsApp or Telegram, by their phone number. A deactivated account resolves to nobody (0195) - this path runs service-role from the webhook, so RLS and the 0194 resolvers never see it, and without the clause here the primary intake channel stayed open to someone the organisation had removed.';

-- ── The notification feed ─────────────────────────────────────────────────
-- `user_notifications_select` was `using (user_id = auth.uid())`: no org gate
-- and no deactivation. It is also what `my_notifications` reads through — that
-- one being the single non-DEFINER function in the set — so the policy fixes
-- both.
drop policy if exists user_notifications_select on user_notifications;
create policy user_notifications_select on user_notifications for select
  using (user_id = active_uid());

comment on policy user_notifications_select on user_notifications is
  'Your own notifications, for as long as the account is live (0195).';

-- ── Prove the RULE, not the list ──────────────────────────────────────────
-- 0194's check named four functions and asserted a substring appeared in each.
-- It would have passed unchanged on the day every gap above was open, which is
-- exactly what its own header argues against: it proved the clause was PRESENT,
-- never that anything REFUSED.
--
-- This asks the catalogue instead. Every function in `public` that reaches
-- auth.uid() must either resolve identity through a deactivation-aware path, or
-- be named below with the reason it cannot. A function added later that does
-- neither fails the migration that introduces it.
do $$
declare
  v_bad text[] := '{}';
  r record;
begin
  for r in
    select p.proname, pg_get_functiondef(p.oid) as def,
           pg_get_function_result(p.oid) as ret
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) like '%auth.uid()%'
  loop
    -- A trigger cannot refuse a caller it was not called about: it fires on a
    -- row, and the write that reached it has already passed RLS. Guarding
    -- log_audit() would block the write it exists to record.
    continue when r.ret = 'trigger';

    continue when r.proname = any (array[
      -- creates the users row - a guard reading that row would refuse every new joiner
      'accept_invitation',
      -- not SECURITY DEFINER - runs under RLS as the caller, which already fails closed
      'reject_payment'
    ]);

    if r.def !~ '(deactivated_at\s+is\s+null|active_uid\(\)|current_user_is_active\(\)|current_user_org_id\(\)|current_user_role\(\)|current_user_property_ids\(\)|current_user_vendor_ids\(\))'
    then
      v_bad := v_bad || r.proname;
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception
      'These functions reach auth.uid() with no deactivation-aware path and are not declared exceptions: %',
      array_to_string(v_bad, ', ');
  end if;
end;
$$;
