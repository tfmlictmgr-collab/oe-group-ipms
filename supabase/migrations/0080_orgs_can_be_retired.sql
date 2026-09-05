-- An organisation can be retired.
--
-- Every other entity in this system has a soft delete — properties, units,
-- assets, service charges — because history has to survive the thing it describes.
-- `orgs` did not, and the gap surfaced the hard way: a verification suite
-- provisioned test orgs and could not remove them, because `audit_log.org_id`
-- references `orgs` and the audit trail is append-only by design (A3).
--
-- That is the correct behaviour and worth stating plainly: **an organisation that
-- has ever done anything cannot be deleted, because deleting it would erase the
-- record that it did.** Real clients churn, so retiring one has to be possible
-- without destroying its trail.
--
-- The immediate consequence was worse than the tidiness problem. Three leftover
-- OEA-branded fixtures meant `orgs.find(o => o.delivery_brand === 'OEA')` — which
-- most suites use — started resolving to the wrong organisation, and two suites
-- failed with errors that looked like product faults ("OEA does not have
-- lettings") but were fixture debris shadowing the real org.
--
-- 📌 **`delivery_brand` is not a unique key and was being used as one.**

alter table orgs add column if not exists deleted_at timestamptz;

comment on column orgs.deleted_at is
  'Retired. The row stays because audit_log references it and the trail is append-only — an organisation that has done anything can never be deleted, only retired.';

create index if not exists orgs_active_idx on orgs (id) where deleted_at is null;

-- The three test fixtures that provisioning left behind, named for what they are.
update orgs
   set deleted_at = coalesce(deleted_at, now()),
       tenant_applications_open = false
 where name like 'RETIRED test fixture%'
    or name like 'PROBEOP-%';

-- A retired org accepts nothing. Cheaper to enforce here than to remember in each
-- of the places that ask.
create or replace function org_accepts_tenant_applications(p_org_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce(
    (select o.tenant_applications_open
              and o.deleted_at is null
              and org_has_module(o.id, 'lettings')
       from orgs o where o.id = p_org_id),
    false
  );
$$;
