-- An account name is a name, and the number never lands in it.
--
-- Found reconciling "why does 'no verified bank recipient is on file for this
-- vendor' appear when the vendor HAS attached a bank account?" The refusal is
-- correct: decision 17 is explicit that a vendor's stated bank details are
-- evidence, never payment instructions, and there is deliberately no path from
-- a registration into `payout_recipients`. But reading the pack that prompted
-- the question surfaced a second, quieter defect underneath it.
--
-- GreenLeaf Landscaping's registration, on BOTH brands, reads:
--
--     bank_name             "first bank"
--     account_name          "3110958803"      <- the full account number
--     account_number_last4  "8803"
--
-- The last four are correct and derived from that same number, so this is not a
-- typo: it is the form being read as "Account" rather than "Account name", by
-- every person who has filled it in. 0164 says in its own comment that the full
-- number "is never stored -- it is read off the uploaded bank_evidence document
-- by finance". It was being stored, in a free-text column, on an approved pack.
--
-- Two changes, both narrow:
--
--   1. `save_vendor_registration` refuses a numeric account name, so it cannot
--      recur. ⚠️ The body below is `pg_get_functiondef` output with exactly one
--      guard spliced in -- 0183's rule, because this function is the ONE write
--      path onto that table (0216) and a clause lost to retyping is a control
--      lost. Nothing else in it moves.
--
--   2. The rows already carrying a number are redacted. Nothing of value goes:
--      the last four digits are stored separately and are what a person
--      recognises an account by. `vendor_registration_state()` will then report
--      "account name" as outstanding on those packs, which is TRUE -- nobody
--      ever gave one -- and it gates no payment (decision 17, unchanged).
--
-- The reader's half lives in `lib/payout-account.ts`, and the vendor page now
-- shows the stated details and the bank letter beside the form that registers
-- the payout account -- which is where 0164 always said the number is read
-- from, and which the product had never put on the same screen.

CREATE OR REPLACE FUNCTION public.save_vendor_registration(p_vendor_id uuid, p_legal_name text DEFAULT NULL::text, p_trading_name text DEFAULT NULL::text, p_cac_number text DEFAULT NULL::text, p_tin text DEFAULT NULL::text, p_business_type text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_bank_name text DEFAULT NULL::text, p_account_name text DEFAULT NULL::text, p_account_number_last4 text DEFAULT NULL::text, p_compliance_statement text DEFAULT NULL::text, p_declare_compliance boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- ⚠️ An account NAME that is a run of digits is an account NUMBER in the
  -- wrong box, and 0040b's rule -- unchanged since it was written -- is that we
  -- never hold one. Measured on staging before this migration: 2 of 2
  -- registrations carrying bank details had the full ten-digit number sitting
  -- in `account_name`, with `account_number_last4` correctly derived from it.
  -- So the person filling the form read "Account name" as "account", every
  -- time, and the product stored precisely the value 0164's own comment says it
  -- must never store.
  --
  -- Refused rather than silently truncated: only the vendor knows the name the
  -- bank holds the account in, and inventing one here would put a made-up name
  -- in front of the administrator who registers the payout account against it.
  if nullif(trim(coalesce(p_account_name, '')), '') ~ '^[0-9][0-9 -]{5,}$' then
    raise exception 'that looks like an account number, not an account name -- enter the name the bank holds the account in, and only the last four digits of the number';
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
$function$
;

-- 0204/0209/0210's standing lesson: `create or replace` re-applies Supabase's
-- default PUBLIC grants, so the revoke belongs in the same migration as the
-- replace, every time.
revoke all on function save_vendor_registration(
  uuid, text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, boolean) from public, anon;
grant execute on function save_vendor_registration(
  uuid, text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, boolean) to authenticated, service_role;

comment on function save_vendor_registration is
  'The ONE way a vendor registration is written from the product (0216). Resolves the org from the vendor row, accepts only profile columns, never takes status/reviewed_*/submitted_* from a caller, and since 0262 refuses an account NAME that is a run of digits -- an account number in the wrong box, which 0040b says we never hold.';

-- ── The rows already carrying a number ──────────────────────────────────
--
-- Matched on the VALUE, not on a vendor id: any pack whose account name is six
-- or more digits and nothing else is holding a number, whichever org it belongs
-- to and whenever it was written. The audit trigger on this table records the
-- before-row, so the change stays attributable -- which is why it is an UPDATE
-- here rather than something done quietly against the database by hand.
update vendor_registrations
   set account_name = null,
       updated_at   = now()
 where account_name ~ '^[0-9][0-9 -]{5,}$';
