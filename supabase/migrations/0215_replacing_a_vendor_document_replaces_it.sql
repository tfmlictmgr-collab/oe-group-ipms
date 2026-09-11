-- ── Replacing a document actually replaces it ─────────────────────────────
--
-- ⚠️ A SECOND DEFECT IN THE SAME FLOW, found while proving the first was fixed.
--
-- `recordDocument()` supersedes the previous document of the same type before
-- inserting the new one:
--
--     update vendor_documents set superseded_at = now()
--      where vendor_id = … and doc_type = … and superseded_at is null
--
-- A vendor holds **no UPDATE policy** on `vendor_documents` — 0164 gives the
-- table one update policy, `vendor_documents_staff_update`, gated on
-- `vendors.write`, because verification is staff-only and a subject must not be
-- able to edit their own evidence. The column-level grant on `superseded_at`
-- exists, so the statement is well-formed; RLS then matches no rows and
-- PostgREST returns **success with zero rows affected**. Nothing raised, nothing
-- logged.
--
-- So "Replace" left TWO live rows of the same doc_type and the reviewer's screen
-- showed whichever one the map happened to keep last. Same shape as the path
-- bug above: a write that silently does nothing, in the one flow nobody had
-- driven as a real vendor.
--
-- The fix is NOT to give vendors an UPDATE policy — that would hand the subject
-- of a verification the ability to write `verified_at`'s neighbours on their own
-- evidence. It is one narrow function that supersedes and does nothing else.
create or replace function supersede_vendor_document(
  p_vendor_id uuid,
  p_doc_type  vendor_document_type
)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := current_user_org_id();
  n integer := 0;
begin
  if auth.uid() is null or v_org is null then
    raise exception 'you are not signed in to an organisation';
  end if;

  -- The same two ways in that `vendor_documents_insert` allows, and no others:
  -- the company's own people with manage_profile, or staff who may write
  -- vendors. Stated here rather than inherited, because SECURITY DEFINER means
  -- the policy will not be consulted.
  if not (
    (p_vendor_id in (select current_user_vendor_ids()) and vendor_user_can('manage_profile'))
    or coalesce((select has_permission('vendors.write')), false)
  ) then
    raise exception 'you are not able to change this company''s documents';
  end if;

  update vendor_documents
     set superseded_at = now()
   where vendor_id = p_vendor_id
     and doc_type = p_doc_type
     and org_id = v_org
     and superseded_at is null;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function supersede_vendor_document(uuid, vendor_document_type) from public, anon;
grant execute on function supersede_vendor_document(uuid, vendor_document_type) to authenticated, service_role;

comment on function supersede_vendor_document is
  'Retires the live document of one type for one vendor, so attaching a replacement leaves exactly one current row. Exists because a vendor has no UPDATE policy on vendor_documents — the supersede in recordDocument() matched nothing and returned no error, and "Replace" quietly produced two live rows (0215). Deliberately narrow: superseding is all it does, and the subject of a verification still cannot touch verified_at or machine_findings.';
