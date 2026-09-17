-- A tenant can report a payment on WhatsApp (9 Sept 2026).
--
-- `0281` made a bank transfer reportable in the portal. The portal is not where
-- these people are. A2.2 has said "WhatsApp-first intake, web portal of record"
-- since the first build prompt, and a tenant who has just transferred rent from
-- their banking app is holding a phone with the receipt already on it.
--
-- ⚠️ What makes this safe to build at all is that a reported payment is NOT a
-- payment. It creates a claim, and `0282`'s three desks still have to confirm it
-- against the bank before a naira moves. So the blast radius of the router
-- getting one wrong is a wasted review, not money — which is a very different
-- risk calculation from the one decision 24 had to make about turning a question
-- into a work order.
--
-- What is NOT relaxed: proof stays compulsory. That is the reason section 4
-- exists — without an inbound-media pipeline the honest answer on WhatsApp would
-- have been "please use the portal", and `lib/handle-inbound.ts`'s own comment
-- ("nothing here can attach the media itself, since there is no inbound-media
-- storage pipeline") is what that limitation looked like written down.

-- ── 1. The conversation can hold a half-finished payment ────────────────────
--
-- Decision 24's finding, one state further on: `chat_conversations.awaiting` had
-- ONE legal value and so it held the wrong one. Collecting a payment takes three
-- facts — the evidence, the amount, and which demand — and a person supplies
-- them across several messages, so each outstanding question needs a name.

alter table chat_conversations drop constraint if exists chat_conversations_awaiting_check;
alter table chat_conversations add constraint chat_conversations_awaiting_check
  check (awaiting = any (array[
    'urgency_confirmation', 'describe_problem', 'disambiguate_ticket',
    -- 0285.
    'payment_proof',      -- they said they paid; we need the receipt
    'payment_amount',     -- we have the receipt; how much was it
    'payment_allocation'  -- we have both; which demand does it settle
  ]));

-- ⚠️ The partial claim, held on the CONVERSATION rather than as a draft row in
-- `offline_payment_claims`. A draft claim would be a row in the money table that
-- no rule in 0281 applies to — no proof, no breakdown, nothing reconciling —
-- and every reader of that table would have to learn to skip it. The half-built
-- thing belongs with the half-finished conversation, and becomes a claim only
-- when it can satisfy the constraints in full.
alter table chat_conversations add column if not exists payment_draft jsonb;

comment on column chat_conversations.payment_draft is
  'A payment being collected across several messages: proof_path, amount, charge choice. Becomes an offline_payment_claim only when complete (0285).';

-- Rebuilt from the live catalogue with one parameter added. `create or replace`
-- alone would leave the 7-argument overload callable beside the 8-argument one —
-- decision 39's recorded lesson about `raise_work_order`, where exactly that
-- produced two live functions and was caught only by the migration failing.
drop function if exists remember_conversation_state(uuid, text, text, uuid, text, text, integer);

create or replace function remember_conversation_state(
  p_org_id uuid,
  p_channel text,
  p_sender_ref text,
  p_ticket_id uuid,
  p_awaiting text,
  p_last_prompt text,
  p_hours integer default 24,
  p_payment_draft jsonb default null
)
returns void
language sql security definer set search_path = public as $fn$
  insert into chat_conversations
    (org_id, channel, sender_ref, last_ticket_id, awaiting, last_prompt,
     payment_draft, expires_at, updated_at)
  values
    (p_org_id, p_channel, p_sender_ref, p_ticket_id, p_awaiting, p_last_prompt,
     p_payment_draft, now() + make_interval(hours => p_hours), now())
  on conflict (org_id, channel, sender_ref) do update
     set last_ticket_id = excluded.last_ticket_id,
         awaiting       = excluded.awaiting,
         last_prompt    = excluded.last_prompt,
         -- ⚠️ NULL clears the draft rather than preserving it. Every reply goes
         -- out through one `say()` helper, so a branch that is not about a
         -- payment passes nothing here and the half-finished payment is
         -- abandoned — which is what should happen when somebody changes the
         -- subject. Preserving it would leave a stale amount waiting to attach
         -- itself to the next receipt they send.
         payment_draft  = excluded.payment_draft,
         expires_at     = excluded.expires_at,
         updated_at     = now();
$fn$;

revoke all on function remember_conversation_state(uuid, text, text, uuid, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function remember_conversation_state(uuid, text, text, uuid, text, text, integer, jsonb)
  to service_role;

-- ── 2. What this sender could be paying ─────────────────────────────────────
--
-- The chat twin of `offline_allocatable_charges`, resolved from the phone number
-- rather than from a session. Ownership is `resolve_chat_sender` and nothing
-- else — 0075's rule, and decision 24's restatement of it: knowing a reference
-- (or a phone number) buys nothing that the resolver does not already grant.
create or replace function sender_open_charges(
  p_org_id uuid,
  p_sender_ref text,
  p_limit integer default 5
)
returns table (
  kind text,
  charge_id uuid,
  label text,
  period text,
  outstanding numeric,
  currency text,
  property_id uuid,
  unit_id uuid,
  due_date date
)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_user uuid;
begin
  select r.user_id into v_user from resolve_chat_sender(p_org_id, p_sender_ref) r;
  if v_user is null then
    return;
  end if;

  return query
    select 'rent'::text, rc.id,
           p.name || coalesce(' · ' || u.label, ''),
           to_char(rc.period_start, 'Mon YYYY') || ' - ' || to_char(rc.period_end, 'Mon YYYY'),
           rc.amount - rc.amount_paid, rc.currency,
           l.property_id, l.unit_id, rc.due_date
      from rent_charges rc
      join leases l on l.id = rc.lease_id and l.deleted_at is null
      join properties p on p.id = l.property_id
      left join units u on u.id = l.unit_id
     where rc.org_id = p_org_id
       and l.tenant_user_id = v_user
       and rc.amount - rc.amount_paid > 0

    union all

    select 'service_charge'::text, sc.id,
           coalesce(sc.property_or_unit, p.name, 'Service charge'),
           sc.billing_period,
           sc.amount - sc.amount_paid, 'NGN',
           sb.property_id, sc.unit_id, sc.due_date
      from service_charges sc
      left join sc_budgets sb on sb.id = sc.budget_id
      left join properties p on p.id = sb.property_id
     where sc.org_id = p_org_id
       and sc.billed_to_user_id = v_user
       and sc.deleted_at is null
       and sc.amount - sc.amount_paid > 0

     order by 9 nulls last, 3
     limit greatest(1, least(coalesce(p_limit, 5), 10));
end;
$fn$;

revoke all on function sender_open_charges(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function sender_open_charges(uuid, text, integer) to service_role;

comment on function sender_open_charges is
  'The outstanding rent demands and service-charge invoices belonging to whoever this chat sender resolves to. Ownership is resolve_chat_sender and nothing else (0285).';

-- ── 3. The allocation writer learns to act for somebody with no session ─────
--
-- ⚠️ ONE allocation writer, still. A webhook has no `auth.uid()`, so the obvious
-- move is a second sender-scoped copy of the validation — which is precisely the
-- duplication 0284's own header argues against, and the shape behind most of the
-- defects in this repo's record.
--
-- Instead the acting user becomes an explicit parameter, defaulting to
-- `active_uid()` so both existing callers are untouched. This is the same shape
-- `post_offline_payment_claim(p_claim_id, p_confirmed_by)` already uses, and for
-- the same reason: `auth.uid()` is null under the service role by definition, so
-- the one path that has no session must pass the actor rather than hope for one.
--
-- The safety of it rests on the grant. This function is callable by NOBODY —
-- reached only from inside another SECURITY DEFINER body — so "who is acting" is
-- never supplied by a client, only by a caller that has already resolved it.
--
-- With an acting user and no session, `has_permission()` is false, so the
-- staff branch is unreachable and a chat sender can only ever allocate to their
-- OWN charges. That is the correct answer for this caller, arrived at by the
-- rules already there rather than by a new branch.
drop function if exists write_offline_claim_allocations(uuid, jsonb, numeric);

create or replace function write_offline_claim_allocations(
  p_claim_id uuid,
  p_allocations jsonb,
  p_amount numeric,
  p_acting_user uuid default null
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_actor uuid := coalesce(p_acting_user, active_uid());
  c offline_payment_claims%rowtype;
  v_line jsonb;
  v_sum numeric(16,2) := 0;
  v_amount numeric(16,2);
  v_purpose collection_purpose;
  v_ledger_purpose ledger_account_purpose;
  v_rc rent_charges%rowtype;
  v_sc service_charges%rowtype;
  v_lease leases%rowtype;
  v_property uuid;
  v_unit uuid;
  v_outstanding numeric(16,2);
  v_own boolean;
  v_payer uuid;
  v_own_properties uuid[] := array[]::uuid[];
  v_staff boolean;
begin
  select * into c from offline_payment_claims where id = p_claim_id for update;
  if c.id is null then
    raise exception 'that recorded payment could not be found';
  end if;

  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'say what this payment is for - pick at least one demand or invoice';
  end if;

  -- False for a caller with no session, which is what makes the chat path
  -- own-charges-only without a branch of its own.
  v_staff := coalesce(has_permission('payments.record_offline'), false);
  v_payer := c.payer_user_id;

  delete from offline_payment_allocations where claim_id = c.id;

  -- ── PASS ONE: lines that name a charge ───────────────────────────────────
  for v_line in select * from jsonb_array_elements(p_allocations) loop
    v_purpose := (v_line->>'purpose')::collection_purpose;
    v_amount := round((v_line->>'amount')::numeric, 2);
    v_property := null;
    v_unit := null;
    v_own := false;

    if v_amount is null or v_amount <= 0 then
      raise exception 'every line of the breakdown needs an amount';
    end if;
    v_sum := v_sum + v_amount;

    v_ledger_purpose := case v_purpose
      when 'rent' then 'landlord_payable'
      when 'service_charge' then 'service_charge_fund'
      when 'deposit' then 'tenant_deposit'
      else 'suspense'
    end;

    if v_purpose = 'rent' then
      select * into v_rc from rent_charges where id = (v_line->>'rent_charge_id')::uuid;
      if v_rc.id is null or v_rc.org_id is distinct from c.org_id then
        raise exception 'one of the rent demands on this payment could not be found';
      end if;
      select * into v_lease from leases where id = v_rc.lease_id;
      v_property := v_lease.property_id;
      v_unit := v_lease.unit_id;
      v_own := v_lease.tenant_user_id = v_actor;
      v_outstanding := v_rc.amount - v_rc.amount_paid;
      v_payer := coalesce(v_payer, v_lease.tenant_user_id);

      if upper(v_rc.currency) <> upper(c.currency) then
        raise exception 'that rent demand is in % and this payment is in %',
          v_rc.currency, c.currency;
      end if;

    elsif v_purpose = 'service_charge' then
      if upper(c.currency) <> 'NGN' then
        raise exception
          'service charges are billed in naira, so a % payment cannot be put against one - record the naira part separately',
          c.currency;
      end if;

      select * into v_sc from service_charges
       where id = (v_line->>'service_charge_id')::uuid and deleted_at is null;
      if v_sc.id is null or v_sc.org_id is distinct from c.org_id then
        raise exception 'one of the service-charge invoices on this payment could not be found';
      end if;
      select sb.property_id into v_property from sc_budgets sb where sb.id = v_sc.budget_id;
      v_unit := v_sc.unit_id;
      v_own := v_sc.billed_to_user_id = v_actor;
      v_outstanding := v_sc.amount - v_sc.amount_paid;
      v_payer := coalesce(v_payer, v_sc.billed_to_user_id);

    else
      continue;
    end if;

    if canonical_ledger_account(c.org_id, v_ledger_purpose, c.currency,
                                case when v_purpose = 'service_charge' then v_property end) is null then
      raise exception
        'this organisation has no % account in % - an administrator enables the currency under Settings before a payment in it can be recorded',
        replace(v_ledger_purpose::text, '_', ' '), c.currency;
    end if;
    if v_purpose = 'rent'
       and canonical_ledger_account(c.org_id, 'fee_income', c.currency) is null then
      raise exception
        'this organisation has no fee income account in % - an administrator enables the currency under Settings before rent in it can be recorded',
        c.currency;
    end if;

    if not coalesce(v_own, false) then
      if not v_staff then
        raise exception 'that demand is billed to somebody else';
      end if;
      if not (current_user_role() = any (oversight_roles()))
         and not (v_property in (select current_user_property_ids())) then
        raise exception 'you do not manage the property that demand belongs to';
      end if;
    else
      v_own_properties := v_own_properties || v_property;
    end if;

    if v_amount > v_outstanding then
      raise exception
        'you have put % against a demand with only % outstanding - reduce it, or put the difference on account',
        trim(to_char(v_amount, 'FM999,999,999,990.00')),
        trim(to_char(v_outstanding, 'FM999,999,999,990.00'));
    end if;

    insert into offline_payment_allocations (
      org_id, claim_id, purpose, rent_charge_id, service_charge_id,
      property_id, unit_id, amount
    ) values (
      c.org_id, c.id, v_purpose,
      case when v_purpose = 'rent' then v_rc.id end,
      case when v_purpose = 'service_charge' then v_sc.id end,
      v_property, v_unit, v_amount
    );
  end loop;

  -- ── PASS TWO: deposits and money on account ──────────────────────────────
  for v_line in select * from jsonb_array_elements(p_allocations) loop
    v_purpose := (v_line->>'purpose')::collection_purpose;
    if v_purpose in ('rent', 'service_charge') then
      continue;
    end if;
    v_amount := round((v_line->>'amount')::numeric, 2);
    v_property := nullif(v_line->>'property_id', '')::uuid;
    v_ledger_purpose := case v_purpose when 'deposit' then 'tenant_deposit' else 'suspense' end;

    if v_property is null then
      raise exception 'a deposit or a credit on account has to say which property it belongs to';
    end if;
    if not exists (select 1 from properties where id = v_property and org_id = c.org_id) then
      raise exception 'that property could not be found';
    end if;

    if canonical_ledger_account(c.org_id, v_ledger_purpose, c.currency) is null then
      raise exception
        'this organisation has no % account in % - an administrator enables the currency under Settings before a payment in it can be recorded',
        replace(v_ledger_purpose::text, '_', ' '), c.currency;
    end if;

    if v_staff then
      if not (current_user_role() = any (oversight_roles()))
         and not (v_property in (select current_user_property_ids())) then
        raise exception 'you do not manage that property';
      end if;
    elsif not (v_property = any (v_own_properties)) then
      raise exception
        'you can only leave money on account at a property you are also paying a demand for on this payment';
    end if;

    insert into offline_payment_allocations (
      org_id, claim_id, purpose, property_id, unit_id, amount
    ) values (
      c.org_id, c.id, v_purpose, v_property,
      nullif(v_line->>'unit_id', '')::uuid, v_amount
    );
  end loop;

  if v_sum <> round(p_amount, 2) then
    raise exception
      'the breakdown comes to % but the payment is % - every part of it has to be allocated to something',
      trim(to_char(v_sum, 'FM999,999,999,990.00')),
      trim(to_char(round(p_amount, 2), 'FM999,999,999,990.00'));
  end if;

  return v_payer;
end;
$fn$;

revoke all on function write_offline_claim_allocations(uuid, jsonb, numeric, uuid)
  from public, anon, authenticated, service_role;

comment on function write_offline_claim_allocations is
  'Replaces an off-platform claim breakdown, vetting every line against the acting person''s standing, the charge''s outstanding balance and the chart of accounts. Shared by the portal submit path (0281), the correction path (0282) and the chat path (0285). Callable by nobody: reached only from inside another definer body, which is what stops "who is acting" ever being client-supplied.';

-- ── 4. Recording one for a chat sender ──────────────────────────────────────
--
-- The webhook's way in. Everything the portal's `submit_offline_payment_claim`
-- checks is checked here too — because it calls the same allocation writer and
-- repeats the same preconditions — with one difference that matters: the payer
-- is RESOLVED from the sender reference, never accepted as an argument.
create or replace function submit_offline_claim_for_sender(
  p_org_id uuid,
  p_sender_ref text,
  p_method offline_payment_method,
  p_amount numeric,
  p_paid_on date,
  p_proof_path text,
  p_allocations jsonb,
  p_payer_note text default null,
  p_proof_filename text default null,
  p_currency text default 'NGN'
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_user uuid;
  v_currency text := upper(trim(coalesce(p_currency, 'NGN')));
  v_bank bank_accounts%rowtype;
  v_claim_id uuid;
  v_ref text;
  v_payer uuid;
begin
  select r.user_id into v_user from resolve_chat_sender(p_org_id, p_sender_ref) r;
  if v_user is null then
    raise exception 'we do not recognise this number, so we cannot record a payment against an account';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'a recorded payment needs an amount';
  end if;
  if p_proof_path is null or trim(p_proof_path) = '' then
    raise exception 'a recorded payment needs its proof attached';
  end if;
  if (storage.foldername(p_proof_path))[1] is distinct from p_org_id::text then
    raise exception 'that proof was not uploaded to this organisation';
  end if;
  if not exists (
    select 1 from storage.objects
     where bucket_id = 'payment-proofs' and name = p_proof_path
  ) then
    raise exception 'that proof could not be found';
  end if;
  if p_paid_on is null or p_paid_on > current_date then
    raise exception 'a payment cannot have been made in the future';
  end if;

  -- ⚠️ The destination account is CHOSEN here, not asked. A person on WhatsApp
  -- cannot usefully pick between ledger accounts, and `bank_accounts_one_client_funds_per_currency_uidx`
  -- (0103) guarantees there is at most one active client-funds account per
  -- currency — so there is exactly one right answer and no question worth
  -- asking. If an org has none, that is a configuration gap and it is refused
  -- rather than guessed.
  select * into v_bank from bank_accounts
   where org_id = p_org_id and purpose = 'client_funds'
     and active and upper(currency) = v_currency
   limit 1;
  if v_bank.id is null then
    raise exception 'this organisation has no % account for tenant payments', v_currency;
  end if;

  v_ref := 'OPC-' || to_char(p_paid_on, 'YYYYMM') || '-' ||
           upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into offline_payment_claims (
    org_id, reference, payer_user_id, payer_email, recorded_by, method,
    claimed_amount, currency, paid_on, destination_bank_account_id,
    payer_reference, payer_note, proof_path, proof_filename
  ) values (
    p_org_id, v_ref, v_user,
    (select u.email from users u where u.id = v_user),
    -- ⚠️ RECORDED BY the sender themselves, which is the honest answer and also
    -- the one the maker-checker needs: a payment somebody reported about their
    -- own account must not be confirmable by them, and a tenant holds no
    -- confirmation role anyway. Attributing it to a staff account would be a
    -- lie that also silently disqualified that staff member from the chain.
    v_user, p_method,
    round(p_amount, 2), v_currency, p_paid_on, v_bank.id,
    null, nullif(trim(coalesce(p_payer_note, '')), ''),
    p_proof_path, nullif(trim(coalesce(p_proof_filename, '')), '')
  )
  returning id into v_claim_id;

  v_payer := write_offline_claim_allocations(
    v_claim_id, p_allocations, round(p_amount, 2), v_user
  );

  return v_claim_id;
end;
$fn$;

revoke all on function submit_offline_claim_for_sender(
  uuid, text, offline_payment_method, numeric, date, text, jsonb, text, text, text
) from public, anon, authenticated;
grant execute on function submit_offline_claim_for_sender(
  uuid, text, offline_payment_method, numeric, date, text, jsonb, text, text, text
) to service_role;

comment on function submit_offline_claim_for_sender is
  'Records an off-platform payment reported over WhatsApp or Telegram. The payer is resolved from the sender reference (0075), never supplied; the destination account is the org''s one client-funds account for the currency (0285).';

-- ── 5. Assertions ───────────────────────────────────────────────────────────
do $$
begin
  -- Exactly ONE allocation writer, and it is the four-argument one.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'write_offline_claim_allocations') <> 1 then
    raise exception 'the allocation writer has more than one overload — decision 39 all over again';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'remember_conversation_state') <> 1 then
    raise exception 'remember_conversation_state has two overloads';
  end if;

  -- Callable by nobody. This is what stops the acting user being client-supplied.
  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public' and routine_name = 'write_offline_claim_allocations'
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) > 0 then
    raise exception 'the allocation writer is reachable from outside its callers';
  end if;

  -- The chat writer is service-role only: it is reached with no session at all.
  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public' and routine_name = 'submit_offline_claim_for_sender'
         and grantee in ('anon', 'authenticated', 'PUBLIC')) > 0 then
    raise exception 'the chat claim writer is callable by a signed-in user or anonymously';
  end if;
  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public' and routine_name = 'sender_open_charges'
         and grantee in ('anon', 'authenticated', 'PUBLIC')) > 0 then
    raise exception 'sender_open_charges is callable outside the webhook';
  end if;

  -- It must NOT take a payer: ownership is the resolver's answer (0075).
  if pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'submit_offline_claim_for_sender'))
     not like '%resolve_chat_sender%' then
    raise exception 'the chat claim writer does not resolve its payer from the sender reference';
  end if;

  -- 0281's rules survived the rebuild.
  if pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'write_offline_claim_allocations'))
     not like '%current_user_property_ids%'
   or pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'write_offline_claim_allocations'))
     not like '%billed in naira%' then
    raise exception 'the allocation writer lost a rule in the rebuild';
  end if;
end $$;
