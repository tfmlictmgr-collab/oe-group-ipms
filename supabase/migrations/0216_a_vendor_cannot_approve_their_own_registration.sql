-- The vendor KYC pack could not be completed, and could be self-approved.
-- (Found while investigating the 28 Aug 2026 demo — decision 23.)
--
-- 0213/0215 fixed the two reasons a document would not ATTACH. This is why the
-- pack still could not be SUBMITTED, and one thing worse found on the way.
--
-- ── 1. ⚠️ A VENDOR COULD APPROVE THEIR OWN REGISTRATION ───────────────────
--
-- `vendor_registrations_insert` (0164) checks the org and that the caller may
-- manage the profile. It says NOTHING about which columns the new row carries,
-- and `authenticated` holds a table-level INSERT grant. So this succeeded, as
-- the vendor, against their own company:
--
--     insert into vendor_registrations (org_id, vendor_id, legal_name,
--                                       status, reviewed_at)
--     values (…, 'approved', now());
--
-- Confirmed by attempting it as a real signed-in vendor, not by reading the
-- policy. `vendor_registration_state()` then reported **approved with 13 items
-- still outstanding**, and `review_vendor_registration` refuses to act on an
-- already-approved pack — so the vendor leaves the review queue having been
-- reviewed by nobody.
--
-- 📌 No money moves on this: decision 17 is explicit that nothing here gates a
-- payment, and it still does not. What it forges is the RECORD OF A HUMAN
-- DECISION — the rubber stamp decision 10 refuses, reached from the subject's
-- side. `0215` already said giving vendors an UPDATE policy "would hand the
-- subject of a verification the keys to their own evidence"; INSERT was the
-- door left open beside it.
--
-- ── 2. The pack could never be completed anyway ───────────────────────────
--
-- `vendor_registration_missing()` requires `compliance_declared_at`, and
-- **nothing in the product ever wrote it** — there is no compliance control on
-- any screen. A vendor who filled every field and attached every document was
-- still told "still outstanding: the compliance declaration", with no way to
-- satisfy it. That is the demo's actual dead end.
--
-- ── 3. Details could be saved once and never corrected ────────────────────
--
-- `vendor_registrations_update` exists as a POLICY, and the table grant is
-- `select, insert` — no UPDATE. Postgres needs both. So the first save
-- inserted and every later save died on `permission denied for table
-- vendor_registrations`; the client's `upsert` turned that into a silent wrong
-- answer, because its ON CONFLICT branch is the one that never ran.
--
-- Same shape as 0083b/0083c on `orgs`, and as `0215` on `vendor_documents`:
-- **a policy that permits what the grant does not.**
--
-- ── The fix: one write path that stamps its own status ────────────────────
--
-- Rather than add an UPDATE grant — which, with a `with check` constraining
-- only `org_id`, would have made the self-approval writable as well as
-- insertable — the direct table write goes away entirely. `authenticated`
-- keeps SELECT and loses the rest; the one way in is this function, which
-- resolves the org from the VENDOR row, writes only profile columns, and never
-- takes `status`, `reviewed_*` or `submitted_*` from a caller at all.
--
-- The same shape as `submit_vendor_registration` (0164) and
-- `supersede_vendor_document` (0215), for the same reason.

create or replace function save_vendor_registration(
  p_vendor_id            uuid,
  p_legal_name           text default null,
  p_trading_name         text default null,
  p_cac_number           text default null,
  p_tin                  text default null,
  p_business_type        text default null,
  p_address              text default null,
  p_city                 text default null,
  p_state                text default null,
  p_phone                text default null,
  p_email                text default null,
  p_website              text default null,
  p_bank_name            text default null,
  p_account_name         text default null,
  p_account_number_last4 text default null,
  -- The declaration text AS SHOWN, stored verbatim per vendor so a later
  -- change to the wording never rewrites what somebody actually agreed to —
  -- decision 10's rule for consent copy, applied to the same kind of statement.
  p_compliance_statement text default null,
  p_declare_compliance   boolean default false
)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_org      uuid;
  v_existing vendor_registrations%rowtype;
  v_last4    text;
  v_is_staff boolean := coalesce((select has_permission('vendors.write')), false);
begin
  if auth.uid() is null then
    raise exception 'your session expired — sign in again';
  end if;

  -- The org comes from the VENDOR, never from the caller. A caller who could
  -- name the organisation would be naming which organisation's register they
  -- are writing into.
  select org_id into v_org from vendors where id = p_vendor_id;
  if v_org is null or v_org is distinct from current_user_org_id() then
    raise exception 'that company could not be found';
  end if;

  if not (
    (p_vendor_id in (select current_user_vendor_ids()) and vendor_user_can('manage_profile'))
    or v_is_staff
  ) then
    raise exception 'your account is not set up to edit this company''s registration';
  end if;

  select * into v_existing from vendor_registrations where vendor_id = p_vendor_id for update;

  -- 0164's rule, kept: a pack that changes underneath the person reviewing it
  -- is not a pack that was reviewed. Staff keep the override they already had
  -- through `vendor_registrations_update`.
  if v_existing.id is not null
     and v_existing.status in ('submitted', 'approved')
     and not v_is_staff then
    raise exception
      'this registration is % and cannot be edited — ask the organisation to send it back to you',
      case v_existing.status when 'submitted' then 'with the team for review' else 'already approved' end;
  end if;

  v_last4 := nullif(regexp_replace(coalesce(p_account_number_last4, ''), '\D', '', 'g'), '');
  if v_last4 is not null and v_last4 !~ '^[0-9]{4}$' then
    raise exception 'enter only the LAST FOUR digits of the account number';
  end if;

  if v_existing.id is null then
    insert into vendor_registrations (
      org_id, vendor_id,
      legal_name, trading_name, cac_number, tin, business_type,
      address, city, state, phone, email, website,
      bank_name, account_name, account_number_last4,
      compliance_statement, compliance_declared_at, compliance_declared_by,
      updated_at
    ) values (
      v_org, p_vendor_id,
      nullif(trim(coalesce(p_legal_name, '')), ''),
      nullif(trim(coalesce(p_trading_name, '')), ''),
      nullif(trim(coalesce(p_cac_number, '')), ''),
      nullif(trim(coalesce(p_tin, '')), ''),
      nullif(trim(coalesce(p_business_type, '')), ''),
      nullif(trim(coalesce(p_address, '')), ''),
      nullif(trim(coalesce(p_city, '')), ''),
      nullif(trim(coalesce(p_state, '')), ''),
      nullif(trim(coalesce(p_phone, '')), ''),
      nullif(trim(coalesce(p_email, '')), ''),
      nullif(trim(coalesce(p_website, '')), ''),
      nullif(trim(coalesce(p_bank_name, '')), ''),
      nullif(trim(coalesce(p_account_name, '')), ''),
      v_last4,
      case when p_declare_compliance then nullif(trim(coalesce(p_compliance_statement, '')), '') end,
      case when p_declare_compliance then now() end,
      case when p_declare_compliance then auth.uid() end,
      now()
    );
    -- `status` is NOT in that column list. It takes its 'draft' default, and
    -- there is no argument by which a caller could ask for anything else.
  else
    update vendor_registrations set
      legal_name           = nullif(trim(coalesce(p_legal_name, '')), ''),
      trading_name         = nullif(trim(coalesce(p_trading_name, '')), ''),
      cac_number           = nullif(trim(coalesce(p_cac_number, '')), ''),
      tin                  = nullif(trim(coalesce(p_tin, '')), ''),
      business_type        = nullif(trim(coalesce(p_business_type, '')), ''),
      address              = nullif(trim(coalesce(p_address, '')), ''),
      city                 = nullif(trim(coalesce(p_city, '')), ''),
      state                = nullif(trim(coalesce(p_state, '')), ''),
      phone                = nullif(trim(coalesce(p_phone, '')), ''),
      email                = nullif(trim(coalesce(p_email, '')), ''),
      website              = nullif(trim(coalesce(p_website, '')), ''),
      bank_name            = nullif(trim(coalesce(p_bank_name, '')), ''),
      account_name         = nullif(trim(coalesce(p_account_name, '')), ''),
      account_number_last4 = v_last4,
      -- Ticking it records the statement they saw; UNticking retracts it in
      -- full, so the row never keeps a timestamp for a declaration that is no
      -- longer being made.
      compliance_statement   = case when p_declare_compliance
                                    then nullif(trim(coalesce(p_compliance_statement, '')), '') end,
      compliance_declared_at = case when p_declare_compliance then now() end,
      compliance_declared_by = case when p_declare_compliance then auth.uid() end,
      updated_at             = now()
    where id = v_existing.id;
  end if;
end;
$fn$;

-- 0204/0209/0210's standing lesson, applied at the point of writing rather than
-- after a third recurrence: `create or replace` re-applies Supabase's default
-- grants, so the revoke belongs here, in the same migration.
revoke all on function save_vendor_registration(
  uuid, text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, boolean) from public, anon;
grant execute on function save_vendor_registration(
  uuid, text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, boolean) to authenticated, service_role;

comment on function save_vendor_registration is
  'The ONE way a vendor registration is written from the product. Resolves the org from the vendor row, accepts only profile columns, and never takes status/reviewed_*/submitted_* from a caller — which is how 0216 closes a vendor inserting their own row as `approved`. Also the only path that records the compliance declaration, which nothing in the product had ever written and which vendor_registration_missing() has always required.';

-- ── The direct table write goes away ──────────────────────────────────────
--
-- ⚠️ INSERT is revoked, not narrowed. A column allowlist would still leave the
-- policy's `with check` constraining only `org_id`, and the next person to add
-- a column would have to remember which side of the line it sits on. One
-- function, no table write, nothing to keep in step.
--
-- SELECT stays: three screens read this table and every one of them should.
-- `accept_vendor_introduction` (0165) is SECURITY DEFINER and runs as the table
-- owner, so its own INSERT is untouched by this.
revoke insert, update on vendor_registrations from authenticated, anon;

comment on table vendor_registrations is
  'One KYC pack per vendor. Written ONLY through save_vendor_registration() / submit_vendor_registration() / review_vendor_registration(); `authenticated` holds SELECT and nothing else since 0216, because the insert policy constrained the row''s org but not its status and a vendor could file themselves as approved.';

-- ── Anything already self-approved is put back ────────────────────────────
--
-- Deliberately narrow: a pack is moved back only if it is approved with NO
-- reviewer AND still incomplete, which no real review could produce —
-- `review_vendor_registration` reads the same `vendor_registration_missing()`
-- this does. A genuinely reviewed pack is left exactly as it is.
do $mig$
declare
  v_row record;
  v_n int := 0;
begin
  for v_row in
    select r.id, r.org_id, r.vendor_id
      from vendor_registrations r
     where r.status = 'approved'
       and r.reviewed_by is null
       and exists (select 1 from vendor_registration_missing(r.vendor_id))
  loop
    update vendor_registrations
       set status = 'draft', reviewed_at = null, review_notes = null, updated_at = now()
     where id = v_row.id;

    insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                           before_state, after_state)
    values (v_row.org_id, null, 'vendor_registration.unapproved', 'vendor_registration', v_row.id,
            jsonb_build_object('status', 'approved', 'reviewed_by', null),
            jsonb_build_object('status', 'draft', 'reason',
              'Approved with no reviewer and an incomplete pack — a vendor could file their own row as approved before 0216'));
    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    raise notice
      '0216: % registration(s) were marked approved with no reviewer and an incomplete pack. Returned to draft; each is audited and needs a real review.',
      v_n;
  end if;
end $mig$;
