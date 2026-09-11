-- A permission row nobody chose follows the baseline (5 Sept 2026).
--
-- 📌 Caught by `verify-portfolio-and-controls` on the FIRST world it was run
-- against, on the one assertion written to be load-bearing:
--
--     FAIL  the FACILITIES manager holds leases.write — it was granted to the
--           wrong peer
--
-- Decision 29's whole point is that the property manager administers money on
-- their own buildings and the facilities manager does not. `b7_grants` says so
-- correctly. The DATA did not: measured on dev, `facility_manager` held
-- `leases.write` = true on both live orgs, `set_by is null`.
--
-- ⚠️ The cause is `0249`'s propagation, and it is 0185's lesson repeated by
-- somebody who had read 0185. That migration updated:
--
--     ... and rp.role = 'property_manager'
--
-- copying `0246`, which had legitimately updated only `payment_approver`
-- because it only ADDED to one role. `0249` does something different: it makes
-- a claim about TWO roles — one gains these capabilities and the other must not
-- hold them — and re-propagating only the winner leaves the loser exactly as it
-- was. The stale `true` comes from `0090_leases_and_rent`, whose original seed
-- granted `leases.write` to `admin, facility_manager, regional_manager`; every
-- later rewrite of the baseline changed what the FUNCTION returns and nothing
-- re-read the ROWS.
--
-- 0185 closed the identical shape on request visibility: "a migration written
-- against the diff rather than against the rule ... 0185 closes it as anything
-- not in the allowed set." So this does not name a role either.
--
-- Every row NOBODY DELIBERATELY MOVED is set to what the baseline says. A row
-- an operator changed (`set_by is not null`) is left exactly where they put it
-- — that is the existing contract, stated in 0246's own propagation and shown
-- in the matrix as a badged deviation. Nothing here can silently overrule a
-- decision a person made.
--
-- 📌 Staging measured clean before this ran (0 drifting rows on live orgs); dev
-- carried 6. That difference is the point: the rule cannot depend on which
-- world happened to be re-seeded most recently.

update role_permissions rp
   set granted = b7_grants(rp.role, rp.capability),
       set_at  = now()
  from orgs o
 where o.id = rp.org_id
   and o.deleted_at is null
   and rp.set_by is null
   and rp.granted is distinct from b7_grants(rp.role, rp.capability);

-- Proof, on the way out. An assertion rather than a comment, because the whole
-- failure mode here is a baseline that is right and rows that are not — which
-- produces no error, no empty screen, and a capability check that quietly
-- answers the wrong thing.
do $$
declare
  v_drift int;
  v_detail text;
begin
  select count(*),
         string_agg(distinct o.name || ' · ' || rp.role::text || ' · ' || rp.capability, '; ')
    into v_drift, v_detail
    from role_permissions rp
    join orgs o on o.id = rp.org_id
   where o.deleted_at is null
     and rp.set_by is null
     and rp.granted is distinct from b7_grants(rp.role, rp.capability);

  if v_drift > 0 then
    raise exception
      '% permission row(s) still disagree with the B7 baseline after re-propagation: %',
      v_drift, v_detail;
  end if;
end $$;
