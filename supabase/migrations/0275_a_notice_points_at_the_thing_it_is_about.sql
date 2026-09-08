-- A notice points at the thing it is about (8 Sept 2026).
--
-- Reported from the live portal, with the bell open: "the notification on
-- tenancy expiry does not currently point to anywhere, can it be updated to
-- point to an actual destination where the action expected in the destination
-- can be taken?"
--
-- It was not a dangling link — `verify-notification-links` would have caught
-- that, and does not, because the row is perfectly well formed: it carries
-- `entity_type = 'lease'` and a live `entity_id`, and its `link` is
-- `/dashboard`, which resolves. That is the whole problem. **A link that
-- resolves is not thereby a destination.** The tenant is told their tenancy
-- ends in sixty days and is put on a screen that mentions neither the tenancy
-- nor the date nor anything they can do about it, and the notice already knew
-- exactly which lease it was about.
--
-- ⚠️ The code half of this is the fix going forward: `app/api/jobs/lease-
-- notices/route.ts` now writes `/dashboard/leases/<lease_id>`, and that page
-- gained the renewal panel — the term, the end date, the escalation recorded
-- against a renewal, and the two things a tenant can actually do (ask to
-- renew, or say they are leaving), each raised as a request pre-addressed to
-- that tenancy so it arrives carrying the property and unit (0273).
--
-- 📌 This migration exists because **a fix that only applies going forward is
-- not a fix for the person who reported it** — 0221's own words, about
-- `raise_work_order`'s missing sender. The notice on the screen in the report
-- is a row that is already written, and a job that runs once per (lease,
-- threshold) will never write it again: `lease_notices` has claimed that pair
-- since 0093, deliberately, so there is no re-run that would repair it.
--
-- Measured before writing: exactly 1 row on this world, unread, from 28 Aug.
-- Bounded to `entity_type = 'lease'` with a bare `/dashboard` link, and to
-- leases that still exist — repointing at a deleted row would manufacture the
-- dangling link 0138 was written to prevent, while fixing a link that merely
-- went nowhere useful.

update user_notifications n
   set link = '/dashboard/leases/' || n.entity_id
 where n.entity_type = 'lease'
   and n.entity_id is not null
   and n.link = '/dashboard'
   and exists (select 1 from leases l where l.id = n.entity_id);

-- ── Prove it, rather than trusting the predicate ──────────────────────────
--
-- ⚠️ Scoped to notices whose lease is STILL THERE, which is the set this
-- migration is responsible for. The first draft asserted the whole set and
-- failed on `dev` — correctly, and on something else entirely: a lease notice
-- whose lease has been hard-deleted, which the `exists` clause above rightly
-- declines to repoint. That orphan is 0138's subject, not this one, and it is
-- closed in 0276 along with the reason it survived. Widening this assertion to
-- cover it would have made one migration answer for two unrelated faults and
-- named neither.
do $$
declare v_left int;
begin
  select count(*) into v_left
    from user_notifications n
   where n.entity_type = 'lease' and n.entity_id is not null and n.link = '/dashboard'
     and exists (select 1 from leases l where l.id = n.entity_id);

  if v_left > 0 then
    raise exception
      '% lease notification(s) still point at /dashboard rather than at their own tenancy', v_left;
  end if;
end $$;
