-- The vendor KYC pack could not be completed, because every upload failed RLS.
-- (Reported from the demo, 28 Aug 2026 — decision 23.)
--
-- ── The defect, confirmed rather than assumed ─────────────────────────────
--
-- `CompanyClient.tsx` wrote its object to
--
--     `${vendorId}/${docType}-<uuid>.<ext>`
--
-- and 0164's INSERT policy requires the FIRST path segment to be the
-- organisation:
--
--     (storage.foldername(name))[1]::uuid = current_user_org_id()
--
-- A vendor id is not an org id, so **every attach in the product failed**, the
-- pack never reached complete, `submit_vendor_registration` kept refusing, and
-- "Send for review" stayed disabled with nothing on screen saying why. The
-- convention the policy wants is the one `accept_vendor_introduction` (0165)
-- already writes for the copies it makes — `<org>/<vendor>/<doc>` — so the one
-- path a human actually used was the only one out of step. Fixed in the client;
-- recorded here because the next person to read the policy should find the
-- story next to it.
--
-- ── What this migration changes ───────────────────────────────────────────
--
-- Only the bucket's own limits, to the numbers the board set and to the ones the
-- browser now enforces:
--
--   • **2 MB**, down from 15 MB. Three different limits were in play — 15 MB in
--     the bucket, 5 MB in the client, and the board's 2 MB in neither.
--   • **PDF, JPEG, PNG, WebP**, unchanged in the bucket and now matched exactly
--     by the client's list. The client additionally offered `image/heic`, which
--     the bucket has never accepted, so an iPhone photo passed the browser check
--     and was refused by storage with a message written for a developer.
--
-- 📌 A limit is stated in BOTH places on purpose. The browser has to refuse a
-- 9 MB photograph before spending a minute of a Nigerian mobile connection
-- uploading it; the bucket has to refuse it regardless of what any browser
-- claimed. Neither is redundant, and `verify-vendor-self-service.mjs` asserts
-- the pair agree.

update storage.buckets
   set file_size_limit = 2097152,
       allowed_mime_types = array['application/pdf','image/jpeg','image/png','image/webp']
 where id = 'vendor-documents';

-- ── Anything already stored above the new limit stays readable ────────────
--
-- `file_size_limit` governs UPLOADS, not reads, so lowering it cannot strand a
-- document a reviewer is part-way through. Stated because "we lowered the limit"
-- reads as though it might, and a reviewer losing sight of evidence mid-review
-- is exactly the failure 0165's transfer job is arranged to avoid.
do $$
declare
  v_big int;
begin
  select count(*) into v_big
    from storage.objects
   where bucket_id = 'vendor-documents'
     and coalesce((metadata->>'size')::bigint, 0) > 2097152;

  if v_big > 0 then
    raise notice
      '0213: % existing vendor document(s) are larger than the new 2 MB limit. They remain readable; only new uploads are held to it.',
      v_big;
  end if;
end $$;
