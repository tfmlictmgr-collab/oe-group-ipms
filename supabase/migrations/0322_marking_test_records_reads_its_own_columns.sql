-- 📌 9 Oct 2026. 0321's mark_test_records could not run.
--
-- It RETURNS TABLE (entity_type text, marked bigint), which declares a PL/pgSQL
-- variable named `entity_type`, and its body reads the temp table's
-- `entity_type` column unqualified — Postgres refused every call with "column
-- reference entity_type is ambiguous". Caught by the first dry run of
-- `purge-test-records --mark-test` on staging, before any production use.
-- `#variable_conflict use_column` makes every unqualified name the column, which
-- is what every reference in the body means; the body is otherwise 0321's.

create or replace function mark_test_records(
  p_org_id uuid,
  p_user_ids uuid[] default '{}',
  p_vendor_ids uuid[] default '{}',
  p_property_ids uuid[] default '{}',
  p_note text default 'Walkthrough test record'
) returns table (entity_type text, marked bigint)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  u uuid[] := coalesce(p_user_ids, '{}');
  v uuid[] := coalesce(p_vendor_ids, '{}');
  pr uuid[] := coalesce(p_property_ids, '{}');
begin
  create temporary table _mark (entity_type text, entity_id uuid) on commit drop;

  insert into _mark select 'user', id from users where org_id = p_org_id and id = any (u);
  insert into _mark select 'vendor', id from vendors where org_id = p_org_id and id = any (v);
  insert into _mark select 'property', id from properties where org_id = p_org_id and id = any (pr);

  insert into _mark select 'lease', l.id from leases l
   where l.org_id = p_org_id and (l.tenant_user_id = any (u) or l.property_id = any (pr));
  insert into _mark select 'ticket', t.id from tickets t
   where t.org_id = p_org_id and (t.sender_id = any (u) or t.assigned_vendor_id = any (v) or t.property_id = any (pr));
  insert into _mark select 'tenant_application', a.id from tenant_applications a
   where a.org_id = p_org_id and (a.property_id = any (pr)
      or lower(a.applicant_email) in (select lower(email) from users where id = any (u)));
  insert into _mark select 'payment', p.id from payments p
   where p.org_id = p_org_id and (p.vendor_id = any (v)
      or p.ticket_id in (select entity_id from _mark where entity_type = 'ticket'));
  insert into _mark select 'ops_requisition', r.id from ops_requisitions r
   where r.org_id = p_org_id and (r.raised_by = any (u)
      or r.ticket_id in (select entity_id from _mark where entity_type = 'ticket')
      or exists (select 1 from ops_requisition_lines l where l.requisition_id = r.id and l.vendor_id = any (v)));
  insert into _mark select 'payment_intent', i.id from payment_intents i
   where i.org_id = p_org_id and (i.payer_user_id = any (u) or i.property_id = any (pr)
      or i.rent_charge_id in (select rc.id from rent_charges rc
                               where rc.lease_id in (select entity_id from _mark where entity_type = 'lease')));
  insert into _mark select 'offline_payment_claim', c.id from offline_payment_claims c
   where c.org_id = p_org_id and c.payer_user_id = any (u);
  insert into _mark select 'remittance', r.id from remittances r
   where r.org_id = p_org_id and (
         r.payment_id in (select entity_id from _mark where entity_type = 'payment')
      or r.requisition_id in (select entity_id from _mark where entity_type = 'ops_requisition')
      or r.recipient_id in (select id from payout_recipients where vendor_id = any (v) or user_id = any (u)));
  -- The ledger entries those records posted. Labelled, never removed from any sum.
  insert into _mark select 'ledger_entry', e.id from ledger_entries e
   where e.org_id = p_org_id
     and exists (select 1 from _mark m where m.entity_id = e.entity_id
                  and m.entity_type = case e.entity_type
                        when 'payment_intent' then 'payment_intent'
                        when 'payment' then 'payment'
                        when 'remittance' then 'remittance'
                        when 'ops_requisition' then 'ops_requisition'
                        else null end);

  insert into test_records (org_id, entity_type, entity_id, note)
  select distinct p_org_id, m.entity_type, m.entity_id, p_note from _mark m
  on conflict (entity_type, entity_id) do nothing;

  return query select m.entity_type, count(distinct m.entity_id) from _mark m group by m.entity_type order by 1;
end;
$$;

revoke all on function mark_test_records(uuid, uuid[], uuid[], uuid[], text) from public, anon, authenticated, service_role;
grant execute on function mark_test_records(uuid, uuid[], uuid[], uuid[], text) to service_role;

do $$
declare bad text;
begin
  select string_agg(routine_name || '→' || grantee, ', ') into bad
    from information_schema.routine_privileges
   where routine_schema = 'public' and routine_name = 'mark_test_records'
     and grantee in ('PUBLIC', 'anon', 'authenticated');
  if bad is not null then raise exception 'mark_test_records over-granted: %', bad; end if;
  if position('#variable_conflict use_column' in pg_get_functiondef('public.mark_test_records(uuid, uuid[], uuid[], uuid[], text)'::regprocedure)) = 0 then
    raise exception 'mark_test_records still resolves names to its own variables';
  end if;
end $$;
