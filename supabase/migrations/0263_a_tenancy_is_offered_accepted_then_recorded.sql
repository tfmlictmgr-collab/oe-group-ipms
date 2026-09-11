-- A tenancy is offered, then accepted, then recorded.
--
-- Asked as "what email/letter is supposed to follow a successfully approved
-- application?" Tracing it found that the answer had no data behind it.
--
-- `record_application_approval` (0082) issued a PORTAL INVITATION and the email
-- said "your application was approved — set up your account". That is an
-- account, not an offer. In Nigerian lettings an approval is followed by a
-- LETTER OF OFFER: the unit, the term, the rent, the service charge, the
-- deposit, what is payable on acceptance, and how long the offer stands. It is
-- the document the tenant pays against and the thing they accept. Nothing in
-- this schema held one of those figures at the moment of approval —
-- `units` carries a label and an apportionment factor and no asking rent, and
-- rent first exists when a lease is written, which is AFTER the tenant has
-- agreed to it. The product had the sequence backwards.
--
-- So: **offer → acceptance → lease.**
--
--   1. The completing approval records an OFFER with its terms and issues an
--      acceptance link. No invitation is created and no account exists yet.
--   2. The applicant opens the link, reads the terms and accepts or declines.
--      Acceptance is what creates the portal invitation — an account is the
--      consequence of accepting, not the way of being told.
--   3. The lease is recorded from the accepted offer, prefilled from it.
--
-- ⚠️ `record_application_approval` is DROPPED and recreated with a new
-- signature rather than being given optional parameters. An optional-terms
-- version would leave the old three-argument path callable, and that path
-- issues an invitation and skips the offer entirely — two ways to approve an
-- application, one of them the behaviour this migration exists to replace.
-- Everything in it that is NOT about the offer — the maker-checker rule, the
-- property scoping, the corporate two-approver count, the unit precondition —
-- is `pg_get_functiondef` output, moved and not retyped (0183).
--
-- ⚠️ The offer functions are for a person with NO ACCOUNT, and the token is the
-- whole authority. They are therefore revoked from `anon` as well as `public`
-- and called through the service role from the server action, which rate-limits
-- by IP. Granting `anon` execute would have been the other shape and it is
-- strictly looser: 0204/0209/0210 record three separate occasions in this repo
-- where an anon-callable definer function taking a caller-supplied value
-- shipped by accident, and nothing here needs one.

-- ── The offer ───────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tenancy_offer_status') then
    create type tenancy_offer_status as enum ('issued', 'accepted', 'declined', 'withdrawn');
  end if;
end $$;

create table if not exists tenancy_offers (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  application_id uuid not null references tenant_applications(id) on delete cascade,
  property_id    uuid references properties(id),
  unit_id        uuid references units(id),

  status tenancy_offer_status not null default 'issued',

  -- The terms, as offered. Amounts are annual except the deposit, which is a
  -- one-off — decision 15: rent here is billed annually in advance, and an
  -- offer that does not say so is not an offer a Nigerian tenant can act on.
  --
  -- ⚠️ Rent and service charge are held and shown SIDE BY SIDE and are never
  -- added into one "rent" figure (decision 25). They are different money going
  -- to different places: rent is collected for the landlord and remitted net of
  -- fees, service charge into a fund the building spends.
  rent_amount           numeric(14,2) not null check (rent_amount > 0),
  service_charge_amount numeric(14,2) not null default 0 check (service_charge_amount >= 0),
  deposit_amount        numeric(14,2) not null default 0 check (deposit_amount >= 0),
  other_charges_amount  numeric(14,2) not null default 0 check (other_charges_amount >= 0),
  other_charges_label   text,

  term_months  integer not null check (term_months between 1 and 120),
  commences_on date not null,
  -- The acceptance deadline. An offer with no expiry holds a unit off the
  -- market indefinitely on the strength of somebody's silence.
  expires_on   date not null,
  conditions   text,

  -- Only the hash, exactly as invitations (0020) and application resume (0062):
  -- a database reader cannot accept somebody's offer.
  accept_token_hash text not null unique,

  issued_by     uuid not null references users(id),
  issued_at     timestamptz not null default now(),
  responded_at  timestamptz,
  decline_reason text,
  withdrawn_reason text,

  -- A charge nobody can name is a charge nobody can query.
  constraint tenancy_offers_other_charges_named check (
    other_charges_amount = 0
    or nullif(trim(coalesce(other_charges_label, '')), '') is not null
  ),
  constraint tenancy_offers_deadline_sane check (expires_on >= issued_at::date),
  constraint tenancy_offers_app_same_org_fk
    foreign key (application_id, org_id) references tenant_applications (id, org_id)
);

comment on table tenancy_offers is
  'The letter of offer that follows an approved tenancy application (0263). Written only by issue_tenancy_offer(); answered only through the applicant''s own tokenised link. Acceptance is what creates the portal invitation — before 0263 the invitation WAS the approval email, and the commercial terms existed nowhere until a lease was written after the fact.';

comment on column tenancy_offers.expires_on is
  'The acceptance deadline. Enforced when accepting, not by a scheduled job: an offer nobody answered is lapsed by arithmetic, and a cron that failed to run must never be what lets a stale offer be accepted.';

create index if not exists tenancy_offers_application_idx on tenancy_offers (application_id, issued_at desc);
create index if not exists tenancy_offers_org_status_idx on tenancy_offers (org_id, status);

-- One LIVE offer per application. A second live offer is two different sets of
-- terms with two working links, and whichever the applicant happened to open
-- would be the tenancy.
create unique index if not exists tenancy_offers_one_live_uidx
  on tenancy_offers (application_id) where status = 'issued';

alter table tenancy_offers enable row level security;

-- Visible to exactly whoever may see the application, by delegation rather than
-- by restating the predicate — the same discipline `application_decisions`
-- (0082) uses, so the two can never drift apart.
drop policy if exists tenancy_offers_select on tenancy_offers;
create policy tenancy_offers_select on tenancy_offers for select to authenticated
  using (application_id in (select id from tenant_applications));

-- No write policy of any kind. Every write below carries a state check and a
-- capability check that belong together in one function.
revoke insert, update, delete on tenancy_offers from authenticated, anon;

-- Decision 34's rule, applied at the point of writing rather than after
-- somebody asks where the record is: an offer is a commercial commitment and
-- its life belongs in the audit trail.
drop trigger if exists audit_tenancy_offer_insert on tenancy_offers;
create trigger audit_tenancy_offer_insert
  after insert on tenancy_offers
  for each row execute function log_audit('tenancy_offer.issued');

drop trigger if exists audit_tenancy_offer_status on tenancy_offers;
create trigger audit_tenancy_offer_status
  after update on tenancy_offers
  for each row
  when (old.status is distinct from new.status)
  execute function log_audit('tenancy_offer.status_change');

-- ── One place that says who hears about an application ──────────────────────
--
-- 0243 narrowed the submission blast to the desk whose place actually covers
-- the property, with the join written inline in `submit_tenant_application`.
-- An offer being accepted or declined has to reach exactly the same people —
-- and a second copy of that join is how the two drift, which is what decision 8
-- says about resolvers and what `0185` says about writing against the rule.
create or replace function notify_application_desk(
  p_application_id uuid,
  p_title text,
  p_body  text
)
returns void language plpgsql security definer set search_path = public as $fn$
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
       and u.role in ('facility_manager', 'property_manager', 'regional_manager')
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
$fn$;

revoke all on function notify_application_desk(uuid, text, text) from public, anon, authenticated;
grant execute on function notify_application_desk(uuid, text, text) to service_role;

comment on function notify_application_desk is
  'The one place that says who is told about a tenancy application: the administrator org-wide, plus the facility/property/regional manager whose place actually covers the property (0243''s join, lifted out of submit_tenant_application so a second consumer cannot own a second copy of it).';

-- ── submit_tenant_application, reading from that one place ──────────────────
--
-- The body below is 0243's, with its inline recipient loop replaced by the call
-- above and nothing else touched.
create or replace function public.submit_tenant_application(
  p_token_hash text, p_form jsonb, p_sensitive jsonb, p_consent text
)
returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare
  v_was_info_requested boolean;
  a tenant_applications%rowtype;
  v_missing text;
  v_title text;
  v_body text;
begin
  select * into a from tenant_applications
   where resume_token_hash = p_token_hash
     and status in ('draft', 'info_requested')
     and resume_expires_at > now()
     and purged_at is null
   for update;

  if a.id is null then
    raise exception 'this application link is no longer valid';
  end if;

  v_was_info_requested := a.status = 'info_requested';
  if coalesce(trim(p_consent), '') = '' then
    raise exception 'consent must be recorded before an application is accepted';
  end if;

  select string_agg(r.label, ', ' order by r.sort_order) into v_missing
    from application_document_requirements r
   where r.org_id = a.org_id
     and r.type = a.type
     and r.required
     and not exists (
       select 1 from application_attachments t
        where t.application_id = a.id and t.kind = r.kind
     );

  if v_missing is not null then
    raise exception 'Still to upload: %', v_missing;
  end if;

  update tenant_applications
     set form = coalesce(p_form, '{}'::jsonb),
         sensitive = coalesce(p_sensitive, '{}'::jsonb),
         status = 'submitted',
         submitted_at = now(),
         consent_given_at = now(),
         consent_statement = p_consent,
         resume_token_hash = null,
         recommendation = null,
         recommended_by = null,
         recommended_at = null
   where id = a.id;

  v_title := case when v_was_info_requested
                  then 'An applicant answered your request'
                  else 'A new tenancy application' end;
  v_body := a.applicant_name ||
    case when v_was_info_requested
         then ' has updated their application and sent it back for review.'
         else ' submitted a tenancy application.' end;

  perform notify_application_desk(a.id, v_title, v_body);

  return a.id;
end;
$function$;

revoke all on function submit_tenant_application(text, jsonb, jsonb, text) from public;
grant execute on function submit_tenant_application(text, jsonb, jsonb, text) to anon, authenticated, service_role;

comment on function submit_tenant_application is
  'Accepts a tenant application from `draft`/`info_requested` (0219). Recipients are resolved by notify_application_desk (0263) rather than by a loop of its own — 0243''s rule, in the one place an offer''s acceptance also reads.';

-- ── Issuing an offer ────────────────────────────────────────────────────────
--
-- The ONE write path onto `tenancy_offers`. Called by the completing approval
-- and, on its own, to re-issue after a withdrawal — because an offer with a
-- mistyped rent that cannot be corrected is the dead end decision 30 was
-- written about, reached from the lettings side.
create or replace function issue_tenancy_offer(
  p_application_id        uuid,
  p_accept_token_hash     text,
  p_rent_amount           numeric,
  p_service_charge_amount numeric,
  p_deposit_amount        numeric,
  p_other_charges_amount  numeric,
  p_other_charges_label   text,
  p_term_months           integer,
  p_commences_on          date,
  p_expires_on            date,
  p_conditions            text
)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  a tenant_applications%rowtype;
  v_id uuid;
begin
  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then raise exception 'no such application'; end if;

  -- The same two gates the approval itself passes. Re-asked rather than
  -- assumed: this function is reachable on its own, for a re-issue.
  if not (select has_permission('applications.approve')) then
    raise exception 'you do not hold applications.approve';
  end if;
  if not (
    (select has_permission('applications.review_all'))
    or a.property_id in (select current_user_property_ids())
  ) then
    raise exception 'you may not act on this application';
  end if;

  if a.status not in ('under_review', 'approved') then
    raise exception 'an offer can only be made on an application that is being approved';
  end if;
  if a.unit_id is null then
    raise exception 'assign a unit to this application before making an offer';
  end if;
  if exists (select 1 from tenancy_offers where application_id = a.id and status = 'issued') then
    raise exception 'this application already has an offer outstanding — withdraw it before making another';
  end if;

  if coalesce(p_accept_token_hash, '') = '' then
    raise exception 'an offer needs an acceptance link';
  end if;
  if p_rent_amount is null or p_rent_amount <= 0 then
    raise exception 'state the rent — an offer without one is not an offer';
  end if;
  if p_term_months is null or p_term_months < 1 then
    raise exception 'state how long the tenancy runs for';
  end if;
  if p_commences_on is null then
    raise exception 'state when the tenancy commences';
  end if;
  if p_expires_on is null or p_expires_on < current_date then
    raise exception 'the acceptance deadline has to be today or later';
  end if;
  -- ⚠️ Deliberately NOT refused when the deadline falls after commencement.
  -- A tenant accepting on the day they move in is ordinary here, and a late
  -- acceptance on an agreed date is a commercial judgement, not a data error.

  insert into tenancy_offers (
    org_id, application_id, property_id, unit_id,
    rent_amount, service_charge_amount, deposit_amount,
    other_charges_amount, other_charges_label,
    term_months, commences_on, expires_on, conditions,
    accept_token_hash, issued_by
  ) values (
    a.org_id, a.id, a.property_id, a.unit_id,
    p_rent_amount,
    coalesce(p_service_charge_amount, 0),
    coalesce(p_deposit_amount, 0),
    coalesce(p_other_charges_amount, 0),
    nullif(trim(coalesce(p_other_charges_label, '')), ''),
    p_term_months, p_commences_on, p_expires_on,
    nullif(trim(coalesce(p_conditions, '')), ''),
    p_accept_token_hash, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function issue_tenancy_offer(
  uuid, text, numeric, numeric, numeric, numeric, text, integer, date, date, text
) from public, anon;
grant execute on function issue_tenancy_offer(
  uuid, text, numeric, numeric, numeric, numeric, text, integer, date, date, text
) to authenticated, service_role;

comment on function issue_tenancy_offer is
  'The one write path onto tenancy_offers (0263). Re-asks the approver''s capability and property scope on its own account, because it is reachable directly to re-issue after a withdrawal. Never takes status, issued_by or the org from a caller.';

-- ── Withdrawing one ─────────────────────────────────────────────────────────
create or replace function withdraw_tenancy_offer(p_offer_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  o tenancy_offers%rowtype;
  a tenant_applications%rowtype;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'say why the offer is being withdrawn — it goes on the record';
  end if;

  select * into o from tenancy_offers
   where id = p_offer_id and org_id = current_user_org_id() for update;
  if o.id is null then raise exception 'no such offer'; end if;
  if o.status <> 'issued' then
    raise exception 'this offer has already been %', o.status;
  end if;

  select * into a from tenant_applications where id = o.application_id;
  if not (select has_permission('applications.approve')) then
    raise exception 'you do not hold applications.approve';
  end if;
  if not (
    (select has_permission('applications.review_all'))
    or a.property_id in (select current_user_property_ids())
  ) then
    raise exception 'you may not act on this application';
  end if;

  update tenancy_offers
     set status = 'withdrawn',
         responded_at = now(),
         withdrawn_reason = p_reason,
         -- The link stops working the moment the offer does. A withdrawn offer
         -- whose token still resolves is an offer the applicant can accept.
         accept_token_hash = 'withdrawn:' || o.id::text
   where id = o.id;
end;
$fn$;

revoke all on function withdraw_tenancy_offer(uuid, text) from public, anon;
grant execute on function withdraw_tenancy_offer(uuid, text) to authenticated, service_role;

-- ── Approval, which now makes an offer instead of an account ────────────────
--
-- ⚠️ The old three-argument signature is DROPPED, not left in place with
-- defaults: it issues an invitation and no offer, and leaving it callable
-- leaves two ways to approve an application with different consequences.
drop function if exists record_application_approval(uuid, text, text);

create or replace function record_application_approval(
  p_application_id        uuid,
  p_reason                text,
  p_accept_token_hash     text default null,
  p_rent_amount           numeric default null,
  p_service_charge_amount numeric default null,
  p_deposit_amount        numeric default null,
  p_other_charges_amount  numeric default null,
  p_other_charges_label   text    default null,
  p_term_months           integer default null,
  p_commences_on          date    default null,
  p_expires_on            date    default null,
  p_conditions            text    default null
)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  a tenant_applications%rowtype;
  v_required  integer;
  v_approvals integer;
  v_offer_id  uuid;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then raise exception 'no such application'; end if;
  if not (select has_permission('applications.approve')) then
    raise exception 'you do not hold applications.approve';
  end if;
  if not (
    (select has_permission('applications.review_all'))
    or a.property_id in (select current_user_property_ids())
  ) then
    raise exception 'you may not act on this application';
  end if;
  if a.status <> 'under_review' then
    raise exception 'this application has not been recommended by a first reviewer yet';
  end if;
  if a.recommended_by = auth.uid() then
    raise exception 'the person who recommended an application may not also approve it';
  end if;
  if exists (
    select 1 from application_decisions
     where application_id = a.id and kind = 'approve' and decided_by = auth.uid()
  ) then
    raise exception 'you have already approved this application';
  end if;
  if a.unit_id is null then
    raise exception 'assign a unit to this application before approving it';
  end if;

  insert into application_decisions (org_id, application_id, kind, decided_by, reason)
  values (a.org_id, a.id, 'approve', auth.uid(), p_reason);

  v_required := case when a.type = 'corporate' then 2 else 1 end;
  select count(distinct decided_by) into v_approvals
    from application_decisions where application_id = a.id and kind = 'approve';

  if v_approvals < v_required then
    -- Corporate, first of two. Recorded; not yet decided, and deliberately no
    -- offer — terms stated by one approver before the second has looked would
    -- be an offer the organisation had not finished making.
    return null;
  end if;

  -- The completing approval issues the OFFER. It no longer issues an
  -- invitation: an account is what acceptance produces, not what approval
  -- announces.
  v_offer_id := issue_tenancy_offer(
    a.id, p_accept_token_hash,
    p_rent_amount, p_service_charge_amount, p_deposit_amount,
    p_other_charges_amount, p_other_charges_label,
    p_term_months, p_commences_on, p_expires_on, p_conditions
  );

  update tenant_applications
     set status = 'approved',
         decided_by = auth.uid(),
         decided_at = now(),
         decision_notes = p_reason
   where id = a.id;

  return v_offer_id;
end;
$fn$;

revoke all on function record_application_approval(
  uuid, text, text, numeric, numeric, numeric, numeric, text, integer, date, date, text
) from public, anon;
grant execute on function record_application_approval(
  uuid, text, text, numeric, numeric, numeric, numeric, text, integer, date, date, text
) to authenticated, service_role;

comment on function record_application_approval is
  'Tier 2, independent of the recommendation (0082). Since 0263 the completing approval records a LETTER OF OFFER rather than a portal invitation: the terms a tenant is being asked to accept did not exist anywhere in the schema at the moment of approval, and "your application was approved, set up your account" is not an offer. The invitation is created by accept_tenancy_offer.';


-- ⚠️ `authenticated` as well as `anon`, on the four functions above.
--
-- 0204/0209/0210 record this repo reaching for `revoke ... from public` three
-- times and each time watching a definer function ship callable by somebody it
-- was never meant for. The role that catches people out here is not `public`
-- or `anon` — it is `authenticated`, because Supabase's DEFAULT PRIVILEGES on
-- the public schema grant EXECUTE on every new function to anon, authenticated
-- AND service_role, and a `revoke ... from public, anon` leaves the middle one
-- standing. Measured on dev the moment this migration first ran: all four
-- were still executable by `authenticated`.
--
-- Three of them take a TOKEN as their whole authority and answer for a person
-- with no account, so no signed-in session should be able to call them at all.
-- The fourth composes a notification's title and body from its arguments and
-- posts it to an organisation's administrators — an arbitrary-message primitive,
-- which is only safe because the definer functions that call it run as the
-- table owner and do not need the caller to hold it.

-- ── Reading an offer by its token ───────────────────────────────────────────
--
-- Everything the public page renders, in one row, including the org's own
-- branding — the page has no session to resolve it from.
create or replace function tenancy_offer_by_token(p_token_hash text)
returns table (
  offer_id uuid,
  state text,
  org_id uuid,
  org_name text,
  portal_name text,
  logo_url text,
  theme_primary text,
  delivery_brand text,
  applicant_name text,
  applicant_email text,
  property_name text,
  property_address text,
  unit_label text,
  rent_amount numeric,
  service_charge_amount numeric,
  deposit_amount numeric,
  other_charges_amount numeric,
  other_charges_label text,
  term_months integer,
  commences_on date,
  expires_on date,
  conditions text,
  issued_at timestamptz,
  responded_at timestamptz
)
language sql security definer set search_path = public stable as $fn$
  select
    o.id,
    -- ⚠️ `lapsed` is arithmetic, never a stored status. Nothing sweeps these
    -- rows, so a status column would say `issued` on an offer that expired in
    -- March. The accept path applies the same test, so what the page shows and
    -- what the database allows cannot disagree.
    case when o.status = 'issued' and o.expires_on < current_date
         then 'lapsed' else o.status::text end,
    o.org_id, g.name, g.portal_name, g.logo_url, g.theme_primary, g.delivery_brand::text,
    a.applicant_name, a.applicant_email,
    p.name, p.address,
    u.label,
    o.rent_amount, o.service_charge_amount, o.deposit_amount,
    o.other_charges_amount, o.other_charges_label,
    o.term_months, o.commences_on, o.expires_on, o.conditions,
    o.issued_at, o.responded_at
  from tenancy_offers o
  join tenant_applications a on a.id = o.application_id
  join orgs g on g.id = o.org_id
  left join properties p on p.id = o.property_id
  left join units u on u.id = o.unit_id
  where o.accept_token_hash = p_token_hash
  limit 1;
$fn$;

revoke all on function tenancy_offer_by_token(text) from public, anon, authenticated;
grant execute on function tenancy_offer_by_token(text) to service_role;

comment on function tenancy_offer_by_token is
  'Everything the public offer page renders, resolved by the token''s hash alone. Service-role only: the page has no session, and the token is the authority. Returns at most one row and cannot be made to list.';

-- ── Accepting ───────────────────────────────────────────────────────────────
--
-- This is the act that creates the tenant's portal invitation. The caller
-- generates the invitation token and holds the raw value, exactly as every
-- other invitation in this system — the function only ever sees the hash.
create or replace function accept_tenancy_offer(
  p_token_hash        text,
  p_invite_token_hash text
)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  o tenancy_offers%rowtype;
  a tenant_applications%rowtype;
  v_invite_id uuid;
  v_unit text;
begin
  select * into o from tenancy_offers where accept_token_hash = p_token_hash for update;
  if o.id is null then
    raise exception 'this offer link is no longer valid';
  end if;
  if o.status <> 'issued' then
    raise exception 'this offer has already been %', o.status;
  end if;
  if o.expires_on < current_date then
    raise exception 'this offer lapsed on %', to_char(o.expires_on, 'DD Mon YYYY');
  end if;
  if coalesce(p_invite_token_hash, '') = '' then
    raise exception 'accepting needs an invitation token';
  end if;

  select * into a from tenant_applications where id = o.application_id;

  -- ⚠️ `issued_by`, not `auth.uid()`. There is no session here by definition —
  -- the person accepting has no account, which is the whole reason acceptance
  -- creates one. Stamping null would leave the invitation with no author, which
  -- is the fault 0142 had to go back and fix on remittances.
  insert into invitations (org_id, email, role, full_name, unit_id, token_hash, invited_by, expires_at)
  values (o.org_id, a.applicant_email, 'tenant', a.applicant_name, o.unit_id,
          p_invite_token_hash, o.issued_by, now() + interval '14 days')
  returning id into v_invite_id;

  update tenancy_offers
     set status = 'accepted', responded_at = now()
   where id = o.id;

  select label into v_unit from units where id = o.unit_id;

  perform notify_application_desk(
    a.id,
    'A tenancy offer was accepted',
    a.applicant_name || ' accepted the offer on ' || coalesce(v_unit, 'their unit') ||
    '. Record the tenancy to start billing it.'
  );

  return jsonb_build_object(
    'invitation_id', v_invite_id,
    'org_id', o.org_id,
    'application_id', a.id,
    'email', a.applicant_email,
    'name', a.applicant_name
  );
end;
$fn$;

revoke all on function accept_tenancy_offer(text, text) from public, anon, authenticated;
grant execute on function accept_tenancy_offer(text, text) to service_role;

comment on function accept_tenancy_offer is
  'The applicant accepting their own offer, by token. Creates the portal invitation — before 0263 that invitation was issued at approval, so a tenant had an account before anyone had told them the rent.';

-- ── Declining ───────────────────────────────────────────────────────────────
create or replace function decline_tenancy_offer(p_token_hash text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  o tenancy_offers%rowtype;
  a tenant_applications%rowtype;
begin
  select * into o from tenancy_offers where accept_token_hash = p_token_hash for update;
  if o.id is null then
    raise exception 'this offer link is no longer valid';
  end if;
  if o.status <> 'issued' then
    raise exception 'this offer has already been %', o.status;
  end if;

  select * into a from tenant_applications where id = o.application_id;

  update tenancy_offers
     set status = 'declined',
         responded_at = now(),
         -- Optional, unlike a reviewer's reason. A reviewer is accountable for
         -- a decision about somebody else; a person turning down a flat owes
         -- nobody an explanation, and demanding one is how they abandon the
         -- page instead and the unit sits held.
         decline_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = o.id;

  perform notify_application_desk(
    a.id,
    'A tenancy offer was declined',
    a.applicant_name || ' declined the offer' ||
    case when nullif(trim(coalesce(p_reason, '')), '') is not null
         then ': ' || trim(p_reason) else '.' end
  );

  return jsonb_build_object('org_id', o.org_id, 'application_id', a.id);
end;
$fn$;

revoke all on function decline_tenancy_offer(text, text) from public, anon, authenticated;
grant execute on function decline_tenancy_offer(text, text) to service_role;
