-- ⚠️ Caught by `verify-invoice-appeal` on its first clean run: a vendor trying
-- to reopen their own rejected invoice was told
--
--     "only a rejected invoice can be reopened (this one is rejected)"
--
-- which is self-contradictory, and therefore useless to the person reading it.
--
-- The cause is that `reject_payment` and `reopen_payment` are SECURITY INVOKER
-- — deliberately, so `payments_update` decides who may act — and an UPDATE that
-- affects zero rows is AMBIGUOUS under RLS. It means either "the invoice is not
-- at a status this applies to" or "you may not write to this invoice", and both
-- were being reported as the first.
--
-- The row is readable (the SELECT above found it, under the same policy set),
-- so nothing is disclosed by distinguishing the two. What was disclosed was
-- confusion.
create or replace function reject_payment(p_id uuid, p_reason text)
returns void language plpgsql set search_path = public as $$
declare
  v payments%rowtype;
  v_vendor_user uuid;
  v_n integer;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'tell the vendor why in at least 10 characters -- they have to act on this';
  end if;

  select * into v from payments where id = p_id;
  if v.id is null then
    raise exception 'that invoice could not be found';
  end if;

  update payments
     set status = 'rejected',
         rejected_reason = trim(p_reason),
         rejected_by = auth.uid(),
         rejected_at = now()
   where id = p_id
     and status in ('pending_verification', 'verified', 'recommended');
  get diagnostics v_n = row_count;

  if v_n = 0 then
    -- Which refusal was it? The status is checked FIRST because it is the one
    -- the caller can act on themselves.
    if v.status not in ('pending_verification', 'verified', 'recommended') then
      raise exception 'that invoice is at % and cannot be rejected from there', v.status;
    end if;
    raise exception 'you do not have permission to reject this invoice';
  end if;

  select user_id into v_vendor_user from vendors where id = v.vendor_id;
  if v_vendor_user is not null then
    perform notify_user(
      v_vendor_user, 'payment',
      'Invoice ' || coalesce(v.invoice_reference, left(replace(v.id::text,'-',''), 8)) || ' was not approved',
      trim(p_reason) || ' — you can correct it and submit again from My Work.',
      '/dashboard/my-work', 'payment', v.id
    );
  end if;
end;
$$;

create or replace function reopen_payment(p_id uuid, p_reason text)
returns void language plpgsql set search_path = public as $$
declare
  v payments%rowtype;
  v_vendor_user uuid;
  v_n integer;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'record why this rejection is being reversed, in at least 10 characters';
  end if;

  select * into v from payments where id = p_id;
  if v.id is null then
    raise exception 'that invoice could not be found';
  end if;

  update payments
     set status = 'pending_verification',
         service_verified_at = null,
         service_verified_by = null,
         performance_validated = false,
         reopened_at = now(),
         rejected_reason = 'Reopened: ' || trim(p_reason)
                           || coalesce(' (was: ' || v.rejected_reason || ')', '')
   where id = p_id and status = 'rejected';
  get diagnostics v_n = row_count;

  if v_n = 0 then
    if v.status <> 'rejected' then
      raise exception 'only a rejected invoice can be reopened (this one is %)', v.status;
    end if;
    -- It IS rejected, so the write was refused by policy, not by state. Said
    -- plainly instead of the contradiction this replaces.
    raise exception 'only finance or an administrator may reopen a rejected invoice';
  end if;

  select user_id into v_vendor_user from vendors where id = v.vendor_id;
  if v_vendor_user is not null then
    perform notify_user(
      v_vendor_user, 'payment',
      'Invoice ' || coalesce(v.invoice_reference, left(replace(v.id::text,'-',''), 8)) || ' has been reopened',
      trim(p_reason) || ' — it is back with the team for service verification.',
      '/dashboard/my-work', 'payment', v.id
    );
  end if;
end;
$$;

comment on function reopen_payment is
  'Reverses a rejection that should not have happened, back to pending_verification with the verification and performance flags CLEARED. Finance or an administrator only. ⚠️ A zero-row UPDATE under RLS is ambiguous -- wrong status, or no permission -- and reporting both as the first produced "only a rejected invoice can be reopened (this one is rejected)". The two are now distinguished; the row is already readable to the caller, so nothing is disclosed by saying which.';
