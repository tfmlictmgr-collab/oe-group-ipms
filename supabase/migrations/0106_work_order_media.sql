-- Work-order evidence: photos and video against a service request.
--
-- Day 11's remaining scope. A vendor says the job is done, an FM/PM evaluates
-- the quality of it, and a payment gate turns on that evaluation (B4) — with,
-- until now, no way to attach the one thing that actually shows the work: a
-- photograph of it. Tenants have the same gap in the other direction: "the
-- leak is under the sink" is a paragraph where a photo is unambiguous.
--
-- ⚠️ Visibility FOLLOWS THE TICKET. It is not re-derived.
--
-- The obvious-looking implementation is to copy `tickets_select`'s clauses
-- (sender, assignee, vendor, has_permission, property scoping, the unfiled
-- triage clause) onto this table. That is precisely what the locked scope
-- decisions forbid — "a second scoping mechanism alongside the first is
-- forbidden" — and for good reason: `tickets_select` has been amended four
-- times across 0006/0008/0051/0052/0064, and a copy would have needed every
-- one of those amendments applied twice, correctly, forever.
--
-- Instead the policy asks the only question that matters — "can you see the
-- ticket this belongs to?" — as an EXISTS over `tickets`. Postgres evaluates
-- that subquery AS THE CALLER, so `tickets_select` applies to it in full.
-- Every clause, every future amendment, automatically and exactly once. An
-- attachment is visible to precisely the people its ticket is visible to,
-- by construction rather than by matching maintenance.

create table ticket_attachments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  ticket_id    uuid not null references tickets(id) on delete cascade,
  -- Path within the private bucket. The FILE is the record; this row indexes
  -- it — the same shape `application_attachments` (0062) already uses.
  storage_path text not null unique,
  file_name    text not null,
  content_type text not null,
  size_bytes   bigint not null check (size_bytes > 0),
  -- Who attached it. Never null: unattributed evidence is not evidence, and
  -- this is also what lets an uploader undo their own mistake below.
  uploaded_by  uuid not null references users(id),
  uploaded_at  timestamptz not null default now(),

  -- Images and video only, checked here as well as on the bucket. The bucket
  -- limit governs the actual bytes; this governs what the INDEX will admit,
  -- so a row can never claim a type the evidence viewer cannot render.
  constraint ticket_attachments_media_only
    check (content_type like 'image/%' or content_type like 'video/%')
);

create index ticket_attachments_ticket_idx on ticket_attachments (ticket_id, uploaded_at desc);

alter table ticket_attachments enable row level security;

-- ── Read: exactly the ticket's own audience ────────────────────────────────
create policy ticket_attachments_select on ticket_attachments for select
  to authenticated
  using (
    exists (select 1 from tickets t where t.id = ticket_attachments.ticket_id)
  );

-- ── Write: the same audience, while the job is still live ──────────────────
--
-- `org_id` and `uploaded_by` are pinned to the caller's own so a row cannot be
-- filed into another organisation or attributed to another person, and the
-- ticket must still be open: evidence arrives while the work is happening, not
-- after it has been evaluated and paid against.
create policy ticket_attachments_insert on ticket_attachments for insert
  to authenticated
  with check (
    org_id = current_user_org_id()
    and uploaded_by = auth.uid()
    and exists (
      select 1 from tickets t
       where t.id = ticket_attachments.ticket_id
         and t.org_id = current_user_org_id()
         and t.status not in ('resolved', 'closed')
    )
  );

-- ── No UPDATE policy at all ────────────────────────────────────────────────
-- Deliberate, and the same reasoning as the ledger and the audit log: a piece
-- of evidence that can be edited after the fact is not evidence. Re-uploading
-- is the supported correction, and it leaves both rows.

-- ── Delete: your own mistake, and only before the job is done ──────────────
--
-- Someone photographs the wrong unit and notices immediately; making that
-- permanent helps nobody. But once the ticket is resolved the attachment may
-- already have been weighed in a vendor evaluation (0104) or a payment
-- verification (B4), so from that point it belongs to the record, not to the
-- person who happened to upload it.
create policy ticket_attachments_delete on ticket_attachments for delete
  to authenticated
  using (
    uploaded_by = auth.uid()
    and exists (
      select 1 from tickets t
       where t.id = ticket_attachments.ticket_id
         and t.status not in ('resolved', 'closed')
    )
  );

create trigger audit_ticket_attachment after insert or delete on ticket_attachments
  for each row execute function log_audit('ticket.evidence');

-- ── Private storage ────────────────────────────────────────────────────────
--
-- Private, like application-documents and unlike org-logos. A work-order photo
-- routinely shows the inside of somebody's home; it is reached through a
-- short-lived signed URL, never a public path.
--
-- 25 MB admits a modern phone photo comfortably and a short clip; it also
-- refuses the 4K minute-long video that would never finish uploading on the
-- Nigerian mobile connections this build targets (A2.5). The limit is enforced
-- by the bucket itself, so a client that skips its own check still fails.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'work-order-media', 'work-order-media', false, 26214400,
    array['image/jpeg','image/png','image/webp','image/heic','video/mp4','video/quicktime','video/webm']
  )
  on conflict (id) do update
    set file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types,
        public = false;

-- The first path segment is the org id, so one org's evidence cannot be
-- written into another's folder — the 0062 convention, unchanged.
create policy "staff upload work order media to their org prefix" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'work-order-media'
    and (storage.foldername(name))[1]::uuid = current_user_org_id()
  );

create policy "work order media readable within the org" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'work-order-media'
    and (storage.foldername(name))[1]::uuid = current_user_org_id()
  );

-- Removing the object backing a row the uploader is allowed to delete. The
-- INDEX row is the authority on who may do this (policy above); this simply
-- must not be narrower, or a deleted row would strand its file forever.
create policy "uploader removes their own work order media" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'work-order-media'
    and (storage.foldername(name))[1]::uuid = current_user_org_id()
    and owner = auth.uid()
  );
