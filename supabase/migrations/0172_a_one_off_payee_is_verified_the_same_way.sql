-- A requisition line with no registered vendor still needs a bank-verified
-- payee before any money can move to it — never a number someone typed and
-- nobody checked.
--
-- ⚠️ `payout_recipient_party_matches` rewritten from its LIVE definition, per
-- the 0136 lesson, adding exactly one branch: `party = 'other'` names neither
-- a vendor nor a registered user — the bank details live directly on
-- `display_name`/`account_name`/`account_number_last4`/`recipient_code`,
-- columns this table already has for exactly this reason.

alter table payout_recipients drop constraint if exists payout_recipient_party_matches;
alter table payout_recipients add constraint payout_recipient_party_matches check (
  (party = 'vendor'   and vendor_id is not null and user_id is null)
  or (party = 'landlord' and user_id is not null and vendor_id is null)
  or (party = 'other'    and vendor_id is null    and user_id is null)
);

comment on constraint payout_recipient_party_matches on payout_recipients is
  'vendor -> vendor_id; landlord -> user_id; other (0172, a requisition''s one-off or staff payee) -> neither, identified by its own bank details alone.';

-- ── Recording a verified payee against a requisition line ─────────────────
--
-- The gateway call (Paystack transferrecipient, which performs the bank's own
-- name enquiry) happens in the APPLICATION, exactly as it already does for a
-- vendor (saveVendorPayoutRecipient) -- this function only records what the
-- gateway already verified. It never sees an account number; `p_recipient_code`
-- is the gateway's answer, not a value this function could fabricate money
-- movement from.
create or replace function save_requisition_line_payee(
  p_line_id       uuid,
  p_display_name  text,
  p_account_name  text,
  p_account_number_last4 text,
  p_recipient_code text,
  p_gateway       text default 'paystack'
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_org  uuid;
  v_line ops_requisition_lines%rowtype;
  v_req  ops_requisitions%rowtype;
  v_recipient_id uuid;
begin
  if v_uid is null then
    raise exception 'your session expired — sign in again';
  end if;
  select role, org_id into v_role, v_org from users where id = v_uid;
  if v_role not in ('fm_ops_staff', 'facility_manager', 'regional_manager', 'admin') then
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
$$;

revoke all on function save_requisition_line_payee(uuid, text, text, text, text, text) from public, anon;
grant execute on function save_requisition_line_payee(uuid, text, text, text, text, text) to authenticated, service_role;

comment on function save_requisition_line_payee is
  'Records a bank-verified one-off or staff payee against a requisition line. The gateway performs the name enquiry in the application; this only stores its answer. Refuses once the requisition''s chain has started, so a payee cannot be swapped underneath an approver who already acted on the original one (0172).';
