-- 0300 — The anonymous upload surface gets the limits its own form already
-- claims to enforce (20 Sept 2026).
--
-- Found by the cutover-document refresh (§2.1, PR #25) while reading every
-- bucket's real configuration out of the migration that creates it:
-- `application-documents` is the ONLY bucket in the system with neither a
-- `file_size_limit` nor an `allowed_mime_types`, and it is also the only
-- surface in the system an ANONYMOUS caller can write to —
--
--     create policy "applicants upload to their org prefix" on storage.objects
--       for insert to anon, authenticated
--       with check (bucket_id = 'application-documents'
--                   and org_accepts_tenant_applications(...))
--
-- Every bucket built since sets both (`0106`, `0140`, `0164`/`0213`, `0281`,
-- `0289`). This one predates that habit.
--
-- ── Why this is a real bypass and not a tidy-up ────────────────────────────
--
-- `app/tenancy/[org]/actions.ts` already refuses the wrong thing, and says so
-- to the applicant in plain words:
--
--     const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
--     const MAX = 10 * 1024 * 1024;
--
-- ⚠️ But that check runs on the values the CALLER SUPPLIES, before a signed
-- upload URL is issued — and the file itself is then uploaded straight to
-- Storage with that token. Nothing re-checks the bytes that actually arrive.
-- A caller who claims `application/pdf` and `sizeBytes: 1000` is handed a
-- signed URL and can push anything of any size through it, because the bucket
-- has no opinion. The app-layer check is advisory; the bucket is the only
-- place this can be ENFORCED.
--
-- So the limits below are not new policy. They are the limits the product
-- already tells applicants it applies, finally applied.
--
-- 📌 Deliberately the SAME numbers as the form, not stricter. `0213` is the
-- cautionary tale: it found three different limits for one bucket (15 MB
-- bucket / 5 MB client / the board's 2 MB) and the disagreement itself was the
-- defect. One limit, stated once in the form and enforced once here.

update storage.buckets
   set file_size_limit   = 10485760,  -- 10 MB — app/tenancy/[org]/actions.ts's own MAX
       allowed_mime_types = array['application/pdf','image/jpeg','image/png','image/webp']
 where id = 'application-documents';

-- ── Nothing already stored becomes unreachable ─────────────────────────────
--
-- `file_size_limit` and `allowed_mime_types` govern UPLOADS, not reads — the
-- same point `0213` made when it lowered `vendor-documents`, and worth
-- repeating because "we added a limit" reads as though it might strand a
-- document a reviewer is part-way through. It does not. An identity document
-- already in the bucket stays readable by exactly the people who could read it
-- yesterday.
--
-- What it does change: a re-upload of an oversized file that got in before
-- today will now be refused. That is the intended behaviour and the reason to
-- know the population rather than assume it.
do $$
declare
  v_over integer;
  v_odd  integer;
begin
  select count(*) into v_over
    from storage.objects
   where bucket_id = 'application-documents'
     and coalesce((metadata->>'size')::bigint, 0) > 10485760;

  select count(*) into v_odd
    from storage.objects
   where bucket_id = 'application-documents'
     and coalesce(metadata->>'mimetype', '') not in
         ('application/pdf','image/jpeg','image/png','image/webp');

  if v_over > 0 or v_odd > 0 then
    raise notice
      'application-documents: % object(s) above the new 10 MB limit, % with a type outside the new allowlist. They remain READABLE; only new uploads are affected.',
      v_over, v_odd;
  else
    raise notice
      'application-documents: every stored object already satisfies the new limits.';
  end if;
end $$;
