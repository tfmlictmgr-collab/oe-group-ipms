-- The evidence requirement comes back out.
--
-- 0161 made a photo or video of the finished work MANDATORY before a vendor
-- could invoice a job. It was built against a request that was withdrawn the
-- same day — the uploader already existed (0106 for photo and video, 0140 for
-- the signed invoice), and what looked like a missing feature was a
-- misremembered one.
--
-- ⚠️ Reverted rather than left in, deliberately. A hard gate on invoicing is
-- not a neutral addition: it REFUSES money a contractor is owed, and every job
-- with nothing photographable — an inspection that found nothing, advice given
-- on the phone — becomes a support call. Shipping a control nobody asked for,
-- on the grounds that it is a good idea, is how a system acquires rules its
-- owners cannot explain. If it is wanted later it can be reinstated in one
-- migration; the reasoning is preserved in 0161 rather than deleted.
--
-- What STAYS: `vendor_invoiceable_jobs()`, which reports whether a job carries
-- the vendor's own evidence. It refuses nothing and is what lets the invoice
-- screen say "this job has no photo yet" without preventing the invoice. An
-- observation is not a control.
--
-- Rewritten from the LIVE definition, minus the evidence block.

create or replace function submit_vendor_invoice(
  p_amount numeric,
  p_invoice_reference text,
  p_ticket_id uuid default null::uuid,
  p_attachment_path text default null::text
)
returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare
  v_vendor vendors%rowtype;
  t tickets%rowtype;
  v_id uuid;
  v_path text := nullif(trim(coalesce(p_attachment_path, '')), '');
begin
  select * into v_vendor from vendors where user_id = auth.uid();
  if v_vendor.id is null then
    raise exception 'only a vendor can submit an invoice';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'an invoice must be for a positive amount';
  end if;
  if length(trim(coalesce(p_invoice_reference, ''))) < 3 then
    raise exception 'give the invoice a reference of your own so you can reconcile it';
  end if;

  if p_ticket_id is not null then
    select * into t from tickets where id = p_ticket_id;
    if t.id is null or t.assigned_vendor_id is distinct from v_vendor.id then
      raise exception 'that job is not yours to invoice';
    end if;
    if t.status not in ('resolved', 'closed') then
      raise exception 'finish the job before invoicing for it';
    end if;
  end if;

  if p_ticket_id is not null and exists (
    select 1 from payments
     where ticket_id = p_ticket_id and status <> 'rejected'
  ) then
    raise exception 'an invoice for that job has already been submitted';
  end if;

  -- The attachment, if given, must already sit under this vendor's own org
  -- prefix. Storage RLS enforces the same boundary at upload time; this
  -- refuses a caller who typed a plausible-looking path for someone else's
  -- file rather than one they actually uploaded, before it is ever recorded
  -- against real money.
  if v_path is not null and v_path !~ ('^' || v_vendor.org_id::text || '/') then
    raise exception 'that attachment does not belong to your organisation';
  end if;

  insert into payments (
    org_id, vendor_id, ticket_id, invoice_reference, amount, status, invoice_attachment_path
  ) values (
    v_vendor.org_id, v_vendor.id, p_ticket_id,
    trim(p_invoice_reference), p_amount, 'pending_verification', v_path
  )
  returning id into v_id;

  perform notify_role(
    v_vendor.org_id,
    array['admin', 'facility_manager', 'finance_approver']::user_role[],
    'payment',
    'A contractor submitted an invoice',
    v_vendor.name || ' submitted ' || trim(p_invoice_reference),
    '/dashboard/payments/' || v_id::text
  );

  return v_id;
end;
$function$;

comment on function submit_vendor_invoice is
  'A contractor raises their own invoice, entering the B4 gate at its first stage. Completion evidence is EXPECTED and surfaced by vendor_invoiceable_jobs(), but not required — 0161 briefly enforced it and 0162 took that back out, because refusing money a contractor is owed is not a change to make on inference.';
