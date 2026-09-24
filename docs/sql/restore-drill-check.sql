-- After a restore drill: compare EVERY number here with the backup's
-- `.manifest.json` — `rowCounts` and `constraints`. See BACKUP_AND_RESTORE.md §4.
--
-- ⚠️ Rows alone are not enough. Measured 24 Sept 2026: a restore that lost the
-- double-let guard and three foreign keys matched the source on every row count.
-- A lower `exclusion` or `foreign` figure than the manifest is a FAILED restore.

select 'schema' as what, max(name) as value from _migrations
union all select 'migrations applied', count(*)::text from _migrations
union all
select 'constraints: ' || case c.contype when 'p' then 'primary' when 'f' then 'foreign'
         when 'u' then 'unique' when 'c' then 'check' when 'x' then 'exclusion' else c.contype::text end,
       count(*)::text
  from pg_constraint c join pg_namespace s on s.oid = c.connamespace
 where s.nspname = 'public' group by c.contype
union all
select 'double-let guard (leases_no_overlap)',
       case when exists (select 1 from pg_constraint where conname = 'leases_no_overlap')
            then 'PRESENT' else 'MISSING — restore FAILED' end
union all select 'rows: orgs', count(*)::text from orgs
union all select 'rows: users', count(*)::text from users
union all select 'rows: properties', count(*)::text from properties
union all select 'rows: units', count(*)::text from units
union all select 'rows: leases', count(*)::text from leases
union all select 'rows: tickets', count(*)::text from tickets
union all select 'rows: payments', count(*)::text from payments
union all select 'rows: remittances', count(*)::text from remittances
union all select 'rows: rent_charges', count(*)::text from rent_charges
union all select 'rows: service_charges', count(*)::text from service_charges
union all select 'rows: tenant_applications', count(*)::text from tenant_applications
union all select 'rows: audit_log', count(*)::text from audit_log;
