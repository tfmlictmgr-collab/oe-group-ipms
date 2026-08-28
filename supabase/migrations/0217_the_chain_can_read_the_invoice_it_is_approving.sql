-- The approval chain could not open the invoice it was being asked to approve.
-- (Reported after the 28 Aug 2026 demo — decision 23.)
--
-- ── The defect, confirmed against the live database ───────────────────────
--
-- `raise_ops_requisition` (0170) takes `p_attachment_path` and the FM/PM form
-- uploads to the SAME `invoice-attachments` bucket a vendor invoice scan uses.
-- The read policy 0140 wrote for that bucket is:
--
--     bucket_id = 'invoice-attachments'
--     and exists (select 1 from payments p
--                  where p.invoice_attachment_path = storage.objects.name)
--
-- It joins **`payments` and nothing else**. A requisition's attachment sits in
-- the bucket with no policy that can ever match it, so it is unreadable by
-- everyone — not merely by the wrong roles.
--
-- Measured on the real requisition from the demo (`PO-10001`, OEA, ₦632,200,
-- 94,070 bytes genuinely present in the bucket), signing in as each role:
--
--     payment_audit_approver   requisition ✓  lines ✓  job card ✓  invoice ✗
--     executive                requisition ✓  lines ✓  job card ✓  invoice ✗
--     payment_approver         requisition ✓  lines ✓  job card ✓  invoice ✗
--     finance_approver         requisition ✓  lines ✓  job card ✓  invoice ✗
--
-- Storage answers a hidden object as "Object not found", so nothing on the
-- screen or in the logs said "you are not allowed" — it looked like a missing
-- file. The auditor's whole job at stage 1 is checking an invoice against the
-- job card and the evidence; they had the job card and not the evidence.
--
-- 📌 **The third instance of one pattern**, and worth naming as such. `0171`
-- taught `payment_approvals` and `resolve_payable()` about `ops_requisition`;
-- `0212` found `current_user_payable_ticket_ids()` still looking only at
-- `payments`; this is the same omission one layer further out, in a STORAGE
-- policy nobody thought of as a payable consumer. A payable type added late is
-- not done when the chain accepts it — it is done when every consumer of the
-- older type has been re-read.
--
-- So this is written as "the payable this file belongs to", with both kinds
-- named in one place, rather than as a second policy beside the first.

drop policy if exists "invoice attachments readable by whoever can see the payment" on storage.objects;

create policy "invoice attachments readable by whoever can see the payable" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'invoice-attachments'
    and (
      -- A vendor's invoice scan. Unchanged from 0140: one EXISTS against
      -- `payments`, so every existing and future clause of `payments_select`
      -- applies here automatically rather than by copy.
      exists (
        select 1 from payments p
         where p.invoice_attachment_path = storage.objects.name
      )
      -- ⚠️ NEW. An FM/PM ops requisition's invoice, which has been uploadable
      -- since 0170 and readable by nobody since 0170. Same shape: the row's own
      -- policy (`ops_requisitions_select` — oversight, the chain roles, fm_roles
      -- and the raiser) decides, and this inherits it rather than restating it.
      or exists (
        select 1 from ops_requisitions q
         where q.invoice_attachment_path = storage.objects.name
      )
    )
  );

comment on policy "invoice attachments readable by whoever can see the payable" on storage.objects is
  'Readable by whoever can see the PAYABLE the file belongs to — a vendor payment or an ops requisition. Each branch is one EXISTS against the owning table, so that table''s own SELECT policy decides and this never restates it. Replaces 0140''s payments-only version, under which a requisition''s invoice was unreadable by every role including the auditor whose stage exists to check it (0217).';

-- ── The uploader, likewise ────────────────────────────────────────────────
--
-- 0140's INSERT policy is named for vendors and gated only on the org prefix,
-- which an FM/PM raising a requisition already satisfies — so raising one has
-- always worked and nothing here needs to change for it to keep working. The
-- policy is renamed to say what it actually governs, because "vendors upload
-- their own invoice scan" describes half of its users and is how the read
-- policy came to be written for half of them too.
drop policy if exists "vendors upload their own invoice scan to their org prefix" on storage.objects;

create policy "invoice scans are uploaded to the org prefix" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'invoice-attachments'
    and (storage.foldername(name))[1]::uuid = current_user_org_id()
  );

comment on policy "invoice scans are uploaded to the org prefix" on storage.objects is
  'Storage RLS is the coarse org boundary only, for a vendor invoice scan (0140) and an ops requisition''s invoice alike (0170). The real authorization — that this is genuinely this vendor''s invoice, or that this person may raise a requisition — is submit_vendor_invoice() and raise_ops_requisition(), the same division of labour 0106 draws between the bucket and the index row.';
