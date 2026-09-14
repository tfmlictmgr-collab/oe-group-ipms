-- Fix: auditing the `orgs` table itself failed.
--
-- log_audit() derives audit_log.org_id from the changed row's `org_id` column.
-- Every audited table has one EXCEPT `orgs`, whose identity is its own `id`.
-- So the org.updated trigger added in 0013 raised
--   null value in column "org_id" of relation "audit_log"
-- and, because the audit fires in the same transaction, it rolled back the
-- admin's branding update entirely — theming appeared to save but never did.
--
-- Make the resolution explicit: for `orgs`, the org is the row itself. Other
-- tables are unaffected (their org_id is NOT NULL, so the fallback never runs).

create or replace function log_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  j_new jsonb := case when TG_OP <> 'DELETE' then to_jsonb(new) else null end;
  j_old jsonb := case when TG_OP <> 'INSERT' then to_jsonb(old) else null end;
  v_org uuid := coalesce(
    (j_new->>'org_id')::uuid,
    (j_old->>'org_id')::uuid,
    -- `orgs` IS the org: fall back to its primary key.
    case when TG_TABLE_NAME = 'orgs'
      then coalesce((j_new->>'id')::uuid, (j_old->>'id')::uuid)
    end
  );
  v_entity uuid := coalesce((j_new->>'id')::uuid, (j_old->>'id')::uuid, v_org);
begin
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (v_org, auth.uid(), TG_ARGV[0], TG_TABLE_NAME, v_entity, j_old, j_new);
  return coalesce(new, old);
end;
$$;
