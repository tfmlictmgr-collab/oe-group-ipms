-- Bulk record export and document downloads — operator-governed, same shape
-- as 0203's `training.read`.
--
-- Every KYC review screen already lets a reviewer open one document at a time
-- through a signed URL (tenancy, vendor registrations) — that stays exactly
-- as it was. What did not exist anywhere was a way to pull many records or
-- many documents out of the platform at once: a CSV of a roster, or every
-- document on one applicant zipped into a single file. That is a materially
-- different capability from reading one row on a screen — it is the shape of
-- thing a data-protection review asks about by name — so it gets its own
-- capability rather than riding on `people.invite` or `vendors.read`.
--
-- Same precedent as 0203/0178: named explicitly OFF for every role, admin
-- included, before admin's blanket grant. The platform operator (the OE
-- Group org, `is_platform_operator`) reaches every export/download route
-- through a hardcoded operator check in the route itself — the same pattern
-- `training.read`'s screen uses for its own operator edition — so this
-- capability is never needed for the operator to use the feature. What it
-- IS for: the one lever that turns bulk export on for a SPECIFIC client
-- org's OWN admin, per org, through the Settings → Permissions matrix that
-- already exists — nothing new to build there, exactly as 0203 documented.

-- ⚠️ RENUMBERED 0223 → 0239. Written and applied to staging as 0223, ahead of
-- a concurrent session working the same shared database directly on `phase-1`
-- — which by the time it reached `0236`/`0238` had absorbed this migration's
-- effect on `seed_b7_permissions` by extracting the LIVE definition
-- (pg_get_functiondef) rather than retyping from a stale file, exactly as
-- 0183's rule says to. So the function this migration originally defined is
-- not a fork to reconcile: `0238`'s body already states `records.export` off
-- for every role, admin included, and this migration now runs strictly after
-- it in the merged sequence. Redefining it again here would either be a
-- no-op (if copied correctly) or — the real risk of retyping a stale copy —
-- silently drop every capability `0236`/`0238` added since
-- (`hierarchy.write`, `sc.manage`, `leases.write`, `vendors.recommend`,
-- `vendors.approve`). So it is not restated. Only the capability row is
-- inserted, and `0238`'s function already treats it correctly.

insert into capabilities (key, module, label, description, locked, sort_order)
values (
  'records.export', 'Records',
  'Bulk record export and document downloads',
  'Download a CSV roster (staff, tenants, vendors, landlords/owners) or a zip of every document on one applicant/vendor. Off by default for every role, including admin — the platform operator always has this on their own portal, and turns it on for a client organisation''s administrator only when asked.',
  false, 91
)
on conflict (key) do nothing;
