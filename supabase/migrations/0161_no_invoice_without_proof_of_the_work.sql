-- A contractor shows the finished work before they bill for it.
--
-- ⚠️ THE GAP. `submit_vendor_invoice` checked four things — that the caller is
-- the vendor, that the job is theirs, that it is finished, and that it has not
-- already been invoiced — and NOTHING about evidence. A vendor could mark a job
-- resolved and invoice it in the same minute with no photograph of anything.
--
-- The capability to attach proof has existed since 0106: `ticket_attachments`
-- plus the `work-order-media` bucket, which already accepts video (mp4, mov,
-- webm) as well as stills, up to 25 MB. What was missing was never the uploader
-- — it was the REQUIREMENT. Optional evidence is evidence you have on the jobs
-- nobody disputes and lack on the one you do.
--
-- 📌 It must be the VENDOR'S OWN evidence. A tenant's photo of a broken lift is
-- proof of the problem, not of the repair, and counting it would let a
-- contractor invoice against the complaint that started the job. So the test is
-- an attachment on this ticket uploaded BY THE PERSON BILLING FOR IT.
--
-- ⚠️ This is a hard gate, not a per-org preference. B4 already states the
-- principle — "no vendor payment without (a) service verification and (b)
-- performance evaluation" — and evidence is what the verifier in (a) actually
-- looks at. A toggle would make the control optional exactly where it is
-- inconvenient, which is where it earns its keep. The cost is real and worth
-- naming: a job with genuinely nothing to photograph (an inspection that found
-- nothing, advice given over the phone) now needs a photo of the site or the
-- worksheet. That is a small friction against a class of dispute that is
-- otherwise unanswerable six months later.
--
-- Rewritten from the LIVE definition (`pg_get_functiondef`) per the 0136
-- lesson. Everything below is the live text plus the evidence check; the
-- 4-argument signature from 0140/0141 is unchanged, so every existing call site
-- keeps working.

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
  v_evidence integer;
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

    -- ── Proof of the work ────────────────────────────────────────────────
    --
    -- At least one photo or video on this job, uploaded by this vendor. The
    -- message names the fix, because a refusal a contractor cannot act on just
    -- becomes a phone call to the FM.
    select count(*) into v_evidence
      from ticket_attachments a
     where a.ticket_id = p_ticket_id
       and a.uploaded_by = auth.uid();

    if v_evidence = 0 then
      raise exception 'attach a photo or video of the finished work to this job before invoicing for it';
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
  'A contractor raises their own invoice, entering the B4 gate at its first stage. Since 0161 a job-linked invoice REQUIRES at least one photo or video of the finished work, uploaded to that job by the vendor themselves — a tenant''s photo of the original problem is proof of the fault, not of the repair.';

-- ── Which jobs a vendor can actually invoice ──────────────────────────────
--
-- The "Submit invoice" screen lists finished, uninvoiced jobs. It has to know
-- which of them carry evidence, or it offers a job the database will then
-- refuse — the shape of failure that turns a control into a support call.
create or replace function vendor_invoiceable_jobs()
returns table (
  ticket_id uuid,
  summary text,
  resolved_at timestamptz,
  evidence_count bigint,
  ready boolean
)
language sql stable security definer set search_path = public as $$
  select
    t.id,
    coalesce(t.summary, left(t.message_text, 80)),
    t.resolved_at,
    count(a.id),
    count(a.id) > 0
  from tickets t
  join vendors v on v.id = t.assigned_vendor_id and v.user_id = auth.uid()
  left join ticket_attachments a
    on a.ticket_id = t.id and a.uploaded_by = auth.uid()
  where t.status in ('resolved', 'closed')
    and not exists (
      select 1 from payments p where p.ticket_id = t.id and p.status <> 'rejected'
    )
  group by t.id, t.summary, t.message_text, t.resolved_at
  order by t.resolved_at desc nulls last;
$$;

revoke all on function vendor_invoiceable_jobs() from public, anon;
grant execute on function vendor_invoiceable_jobs() to authenticated, service_role;

comment on function vendor_invoiceable_jobs is
  'Finished, uninvoiced jobs belonging to the calling vendor, each saying whether it carries their own completion evidence yet. Lets the invoice screen show WHY a job cannot be billed instead of offering it and letting the database refuse (0161).';
