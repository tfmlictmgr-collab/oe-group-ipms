-- Audit 0805, H1 and H2 — PC2's `build-auditor` + `/code-review` pass.
--
-- ── H1 — work-order-media storage RLS was org-scoped, not ticket-scoped ────
--
-- 0106's own header says the design principle plainly: "Visibility FOLLOWS
-- THE TICKET. It is not re-derived." `ticket_attachments_select` (the TABLE
-- policy) implements that correctly, via an EXISTS over `tickets` that
-- inherits `tickets_select` in full. But the STORAGE policy for the same
-- bucket — what actually gates `createSignedUrl()` and `list()`, since those
-- read the bytes, not the index row — never got the same treatment. It re-
-- derived a materially broader rule: org membership alone. Any authenticated
-- member of the org could list and sign a URL for any OTHER ticket's photos,
-- entirely outside `ticket_attachments_select`, by calling Supabase Storage
-- directly with their own session — no application code required.
--
-- The fix applies the exact same principle 0106 already stated, one layer
-- down: ask whether an INDEX ROW exists for this object path, and let
-- `ticket_attachments_select` (which already asks the ticket) answer it.
-- `storage_path` is `unique` on `ticket_attachments`, so this is a precise
-- 1:1 lookup, not a prefix match.
drop policy if exists "work order media readable within the org" on storage.objects;
create policy "work order media readable within the org" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'work-order-media'
    and exists (
      select 1 from ticket_attachments ta
       where ta.storage_path = storage.objects.name
    )
  );

-- The upload (INSERT) policy is deliberately UNCHANGED and stays org-scoped
-- only: at upload time there is no `ticket_attachments` row yet (the browser
-- writes the bytes first, then `recordAttachment()` indexes it) — a
-- ticket-scoped check has nothing to check against yet. The INSERT policy
-- into `ticket_attachments` itself is what proves the ticket is visible and
-- still open; an object that fails that insert is removed by
-- `recordAttachment()`'s own cleanup and, under the SELECT fix above, was
-- already unreadable by anyone in the meantime.

-- ── The DELETE storage policy had the identical shape of gap ───────────────
--
-- Not in the audit's H1 (which is about reading), found while fixing it: the
-- delete policy used `owner = auth.uid()` — Storage's own automatic upload-
-- time attribution — with no check that the JOB IS STILL OPEN. The table's
-- own delete policy (`ticket_attachments_delete`, below) already refuses once
-- a ticket resolves, on the reasoning that evidence may by then have been
-- weighed in a vendor evaluation or a payment verification. But that refusal
-- only stopped the INDEX ROW from being deleted — the underlying STORAGE
-- OBJECT could still be deleted directly by its owner after resolution,
-- leaving a `ticket_attachments` row that is real, undeletable, and points at
-- nothing. A stale reference is a worse failure than a stray file: the row
-- claims evidence exists when it does not.
--
-- Factored into one function rather than duplicating "uploaded_by = caller
-- AND the ticket is still open" inline in two places (the table's own DELETE
-- policy, below, and the storage policy) — a nested SELECT inside a policy
-- always applies the referenced table's SELECT policy, never its DELETE
-- policy, so the storage policy cannot simply "borrow"
-- `ticket_attachments_delete` by querying through it. One function, called
-- from both, is the same "ask once, apply everywhere" principle 0106 already
-- used for ticket visibility — applied here to the narrower question of who
-- may retract a specific piece of evidence.
create or replace function ticket_attachment_deletable(p_ticket_id uuid, p_uploaded_by uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_uploaded_by = auth.uid()
     and exists (
       select 1 from tickets t
        where t.id = p_ticket_id
          and t.status not in ('resolved', 'closed')
     );
$$;

revoke all on function ticket_attachment_deletable(uuid, uuid) from public;
grant execute on function ticket_attachment_deletable(uuid, uuid) to authenticated;

drop policy if exists ticket_attachments_delete on ticket_attachments;
create policy ticket_attachments_delete on ticket_attachments for delete
  to authenticated
  using (ticket_attachment_deletable(ticket_id, uploaded_by));

drop policy if exists "uploader removes their own work order media" on storage.objects;
create policy "uploader removes their own work order media" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'work-order-media'
    and exists (
      select 1 from ticket_attachments ta
       where ta.storage_path = storage.objects.name
         and ticket_attachment_deletable(ta.ticket_id, ta.uploaded_by)
    )
  );

-- ── H2 — the dual-source composite never reached the payment gate or BI ────
--
-- `vendor_evaluations.composite_score` is a GENERATED column written for the
-- OLD model (one row, all five dimensions filled at once). 0104's dual-source
-- design writes two half-populated rows per ticket instead, and the generated
-- column COALESCEs every dimension it doesn't have to zero — so an FM/PM row
-- with a perfect 100 on all four of its own dimensions generates
-- `composite_score = 80` (30+20+20+0+10), and a tenant row with perfect
-- satisfaction generates 20. Neither number means what it looks like it
-- means, and nothing about the column's own shape warns a caller of that.
--
-- 0104 already built the correct answer — `vendor_evaluation_tickets`, which
-- pairs the two rows per ticket and populates `composite_score` ONLY once
-- both exist, at the real AURA weights. The vendor scorecard page
-- (`vendors/[id]/page.tsx`) already reads it correctly. These two did not:
--
--   * `runPerformanceCheck` (app/dashboard/payments/[id]/actions.ts) — THE
--     PAYMENT GATE ITSELF. Averaging raw `vendor_evaluations.composite_score`
--     pulled a vendor with only new-style pairs toward roughly (80+20)/2 = 50
--     per pair, well under the 70 default threshold — genuinely excellent
--     work auto-rejected by a KPI gate reading data the new schema never
--     intended it to read.
--   * `bi_vendor_scores` — the executive/BI vendor-performance figure,
--     averaging the same raw column.
--
-- Fixed by repointing both at `vendor_evaluation_tickets` in the application
-- code (this migration only needs to change the view `bi_vendor_scores`
-- reads from; `runPerformanceCheck`'s query is changed in the same commit).
-- `averageComposite()` already discards nulls, which is exactly what a
-- still-awaiting-the-other-half pair needs — its half-row must contribute
-- NOTHING to the average, not a corrupted partial number.
create or replace view bi_vendor_scores
with (security_invoker = on) as
  select
    v.org_id,
    v.id as vendor_id,
    v.name,
    round(avg(t.composite_score)::numeric, 1) as average_score,
    count(t.composite_score) as evaluations
  from vendors v
  join vendor_evaluation_tickets t on t.vendor_id = v.id
  where t.composite_score is not null
  group by v.org_id, v.id, v.name;

comment on view bi_vendor_scores is
  'Executive vendor-performance figure. Reads vendor_evaluation_tickets (0104), never the raw vendor_evaluations.composite_score generated column directly -- that column is written for the pre-dual-source model and structurally undercounts a half-populated row (each missing dimension COALESCEs to zero rather than leaving the composite unset). Only pairs where BOTH fm_pm and tenant have submitted are counted, matching the payment gate exactly (audit 0805-H2).';
