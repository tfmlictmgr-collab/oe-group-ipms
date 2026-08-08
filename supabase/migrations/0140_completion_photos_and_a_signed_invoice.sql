-- Two pieces of evidence a vendor attaches to their own work, each with its
-- own tight limit — deliberately NOT the general 25 MB work-order-media
-- uploader (0106), which stays exactly as it is for the open-ended "what does
-- the problem/finished work look like" case.
--
--   * Completion photos: up to 2, 5 MB combined. Reuses `ticket_attachments`
--     and the `work-order-media` bucket as-is — no schema change needed, the
--     count/size cap is a narrower client-side rule layered on an already
--     correctly-scoped table, enforced the same way the UI already enforces
--     "images only, 25MB each" alongside the bucket's own limit.
--   * A signed paper invoice: one file, 2 MB, image OR PDF (a photo/scan of a
--     physical document, unlike work-order-media which is evidence of the
--     job itself). New bucket, because the allowed types and the size cap are
--     both genuinely different, and a payment's paperwork is a different
--     concern from a ticket's photos.
--
-- ⚠️ No new attachments TABLE for the invoice. One optional file per invoice
-- is a column, not a collection — `payments.invoice_attachment_path`, set
-- ONCE at submission inside `submit_vendor_invoice` itself. Consistent with
-- payments being append-only records (B4): there is deliberately no UPDATE
-- path that could attach or swap a file onto an existing payment row after
-- the fact.

alter table payments add column if not exists invoice_attachment_path text;

comment on column payments.invoice_attachment_path is
  'Path in the private invoice-attachments bucket to a scanned/photographed signed paper invoice, set once at submission by submit_vendor_invoice(). Optional -- most invoices have none. Never updated after insert, matching payments'' own append-only design.';

-- ── submit_vendor_invoice gains one optional parameter ─────────────────────
--
-- Postgres allows adding a trailing DEFAULT parameter with CREATE OR REPLACE
-- without dropping the function first (unlike 0112's return-shape change) —
-- the existing call from vendor-actions.ts, which does not pass it, keeps
-- working unchanged.
create or replace function submit_vendor_invoice(
  p_amount numeric,
  p_invoice_reference text,
  p_ticket_id uuid default null,
  p_attachment_path text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
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
$$;

revoke all on function submit_vendor_invoice(numeric, text, uuid, text) from public, anon;
grant execute on function submit_vendor_invoice(numeric, text, uuid, text) to authenticated;

-- ── Private storage for the invoice scan ───────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'invoice-attachments', 'invoice-attachments', false, 2097152,
    array['image/jpeg','image/png','image/webp','image/heic','application/pdf']
  )
  on conflict (id) do update
    set file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types,
        public = false;

-- Same org-prefix convention as work-order-media (0106) and application-
-- documents (0062): storage RLS is the coarse org boundary only. The real
-- authorization -- that this is genuinely this vendor's own invoice -- is
-- `submit_vendor_invoice`'s own check above, the same division of labour
-- 0106's own comment already draws between the bucket and the index row.
create policy "vendors upload their own invoice scan to their org prefix" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'invoice-attachments'
    and (storage.foldername(name))[1]::uuid = current_user_org_id()
  );

-- Read follows payments_select, exactly the way ticket_attachments_select
-- follows tickets_select (0106) -- one EXISTS, so every existing and future
-- clause of that policy applies here automatically rather than by copy.
create policy "invoice attachments readable by whoever can see the payment" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'invoice-attachments'
    and exists (
      select 1 from payments p
       where p.invoice_attachment_path = storage.objects.name
    )
  );

-- No update, no delete policy. A submitted invoice's paperwork does not
-- change after the fact any more than the payment row it belongs to does --
-- the same append-only reasoning payments and the ledger already follow.
