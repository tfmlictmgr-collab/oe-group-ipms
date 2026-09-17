-- 0290 — The trail says who acted, where, and what was attached.
--
-- Asked for directly (board, 12 Sept 2026): make the audit trail more
-- descriptive, carrying what the old AURA desktop log carried and this one did
-- not — above all, sign-ins and sign-outs, and the attaching of documents.
--
-- Two gaps in what is RECORDED, closed here. What is SHOWN (the property a row
-- concerns, who it is attributed to, a sentence rather than an action code) is
-- the page's job and needs nothing from the database that is not already there.

-- ── Documents attached after the fact ───────────────────────────────────────
--
-- Found by asking the catalogue which tables hold a document path and which of
-- those write an audit row when the path changes, rather than by remembering.
-- Four did not:
--   • payments — audited on INSERT and on a STATUS change only (0005), so an
--     invoice scan attached or replaced later left no trace;
--   • ops_requisitions — the same shape (0251: "status-change only on update");
--   • ops_requisition_lines — not audited at all;
--   • application_attachments — not audited at all.
-- The first three reuse `log_audit`, narrowed by WHEN to the one column, so a
-- row per keystroke on a draft is not what this adds.
create trigger audit_payment_attachment
  after update on payments
  for each row
  when (old.invoice_attachment_path is distinct from new.invoice_attachment_path)
  execute function log_audit('payment.attachment');

create trigger audit_ops_requisition_attachment
  after update on ops_requisitions
  for each row
  when (old.invoice_attachment_path is distinct from new.invoice_attachment_path)
  execute function log_audit('ops_requisition.attachment');

create trigger audit_ops_requisition_line_attachment_insert
  after insert on ops_requisition_lines
  for each row
  when (new.attachment_path is not null)
  execute function log_audit('ops_requisition_line.attachment');

create trigger audit_ops_requisition_line_attachment_update
  after update on ops_requisition_lines
  for each row
  when (old.attachment_path is distinct from new.attachment_path)
  execute function log_audit('ops_requisition_line.attachment');

-- ⚠️ An applicant's documents are recorded WITHOUT their names.
--
-- `log_audit` snapshots the whole row into a log that can never be edited or
-- deleted, and this row's `file_name` is whatever the applicant called the file
-- — "passport_adaeze_okafor.jpg" is ordinary. The OEA expansion's locked rule
-- purges a rejected or withdrawn applicant's personal data after 90 days; an
-- immutable copy of their document names in the trail would outlive that purge
-- forever. So this records that a document of a given KIND and SIZE was added
-- or removed, against which application — enough to audit the event, and
-- nothing that identifies the person once the application itself is gone.
create or replace function audit_application_attachment()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r application_attachments%rowtype;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (
    r.org_id,
    auth.uid(),
    case tg_op when 'INSERT' then 'application.document_added'
               when 'DELETE' then 'application.document_removed'
               else 'application.document_replaced' end,
    'tenant_applications',
    r.application_id,
    null,
    jsonb_build_object('kind', r.kind, 'size_bytes', r.size_bytes, 'content_type', r.content_type)
  );
  return coalesce(new, old);
end;
$$;

revoke all on function audit_application_attachment() from public, anon, authenticated, service_role;

create trigger audit_application_attachment
  after insert or update or delete on application_attachments
  for each row execute function audit_application_attachment();

-- ── Signing in and signing out ──────────────────────────────────────────────
--
-- Not a table write, so no trigger can see it — Supabase keeps its own auth log
-- in a schema this application cannot read, and on this project it is empty.
-- The sign-in page and the sign-out control call this once each.
--
-- Records the device and the address the request came from, because "who
-- signed in" is only half of what a security reviewer asks; "from where" is the
-- other half. Both are cut short, and neither is ever shown outside the trail.
create index if not exists audit_log_actor_action_idx
  on audit_log (actor_id, action, created_at desc);

create or replace function record_session_event(
  p_event      text,
  p_user_agent text default null,
  p_ip         text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  -- Nothing to attribute — a sign-out from a session that had already expired.
  if v_uid is null then
    return;
  end if;
  if p_event not in ('signed_in', 'signed_out') then
    raise exception 'unknown session event';
  end if;
  select org_id into v_org from users where id = v_uid;
  if v_org is null then
    return;
  end if;
  -- One row per real event. A double click, a retried request or a tab that
  -- re-runs the end of sign-in does not write two.
  if exists (
    select 1 from audit_log
     where actor_id = v_uid and action = 'session.' || p_event
       and created_at > now() - interval '30 seconds'
  ) then
    return;
  end if;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (
    v_org, v_uid, 'session.' || p_event, 'user', v_uid, null,
    jsonb_strip_nulls(jsonb_build_object(
      'device', left(nullif(trim(coalesce(p_user_agent, '')), ''), 160),
      'ip',     left(nullif(trim(coalesce(p_ip, '')), ''), 45)
    ))
  );
end;
$$;

revoke all on function record_session_event(text, text, text) from public, anon;
grant execute on function record_session_event(text, text, text) to authenticated, service_role;

-- ── Proof ───────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'audit_payment_attachment', 'audit_ops_requisition_attachment',
    'audit_ops_requisition_line_attachment_insert', 'audit_ops_requisition_line_attachment_update',
    'audit_application_attachment'
  ] loop
    if not exists (select 1 from pg_trigger where tgname = t and not tgisinternal) then
      raise exception 'the % trigger was not created', t;
    end if;
  end loop;

  -- The applicant's document names must never reach the trail.
  if pg_get_functiondef('public.audit_application_attachment()'::regprocedure) like '%file_name%'
     or pg_get_functiondef('public.audit_application_attachment()'::regprocedure) like '%storage_path%' then
    raise exception 'the application-document audit copies a name or path into the immutable trail';
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
     where routine_schema = 'public' and routine_name = 'record_session_event'
       and privilege_type = 'EXECUTE' and grantee in ('PUBLIC', 'anon')
  ) then
    raise exception 'record_session_event is callable without signing in';
  end if;
end $$;
