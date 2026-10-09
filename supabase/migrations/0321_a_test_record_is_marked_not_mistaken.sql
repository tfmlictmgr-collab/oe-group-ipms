-- 📌 9 Oct 2026. Test records that cannot be deleted are marked, and hidden by default.
--
-- After the production walkthrough, the records money touched cannot be purged:
-- the WT tenant paid rent, a WT vendor was paid, the ledger holds their entries
-- and the ledger is immutable by design. Asked: "can they be hidden from real
-- activity, in a tab or a selection button shown optionally, and labelled so
-- nobody is confused in future, so the UI stays clean?"
--
-- One table says which records are test data. Deliberately NOT an `is_test`
-- column on a dozen tables:
--   • the ledger cannot carry one — `ledger_entries` refuses every UPDATE
--     (`block_ledger_mutation`), so a column could never be set on the entries
--     that most need the label;
--   • a new column on a table whose UPDATE is granted to `authenticated` is a
--     column any policy-admitted user could set, hiding their own records
--     (0216's lesson: a write the policy admits is a write that happens);
--   • every screen then asks one question — "which of these ids are test?" —
--     instead of a dozen columns each needing its own guard.
--
-- Marking is done by `mark_test_records`, service-role only, called by the
-- clean-up script (`purge-test-records.mjs --mark-test`) for exactly the records
-- the purge refuses because money touched them. It cascades from the people,
-- vendors and properties named to what hangs off them: their tenancies,
-- requests, payments, requisitions, collections, payouts, claims and the
-- ledger entries those posted. Nothing is changed or hidden in the ledger's
-- arithmetic: balances, the trial balance and fund statements always include
-- test entries (a ledger that leaves rows out does not add up). Activity lists
-- hide marked records unless "Show test records" is chosen, and label them TEST.
--
-- Readable by anyone signed in to the same organisation: it holds only ids of
-- that organisation's own records and a note, and every screen needs it to
-- decide what to show. Writable by nobody but the function.

create table if not exists test_records (
  org_id uuid not null references orgs(id),
  entity_type text not null check (entity_type in (
    'user', 'vendor', 'property', 'lease', 'ticket', 'payment', 'ops_requisition',
    'payment_intent', 'remittance', 'offline_payment_claim', 'tenant_application', 'ledger_entry'
  )),
  entity_id uuid not null,
  note text,
  marked_at timestamptz not null default now(),
  primary key (entity_type, entity_id)
);
create index if not exists test_records_org_type on test_records (org_id, entity_type);

alter table test_records enable row level security;
revoke all on table test_records from public, anon, authenticated;
grant select on table test_records to authenticated;
drop policy if exists test_records_select on test_records;
create policy test_records_select on test_records for select to authenticated
  using (org_id = current_user_org_id());

comment on table test_records is
  'Records marked as test data (walkthroughs, rehearsals) that could not be deleted because money touched them. Activity screens hide them unless asked; the ledger''s arithmetic always includes them. Written only by mark_test_records. 0321.';

create or replace function mark_test_records(
  p_org_id uuid,
  p_user_ids uuid[] default '{}',
  p_vendor_ids uuid[] default '{}',
  p_property_ids uuid[] default '{}',
  p_note text default 'Walkthrough test record'
) returns table (entity_type text, marked bigint)
language plpgsql security definer set search_path = public
as $$
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
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and table_name = 'test_records'
                and (grantee in ('anon', 'PUBLIC') or (grantee = 'authenticated' and privilege_type <> 'SELECT'))) then
    raise exception 'test_records is writable or readable beyond what 0321 states';
  end if;
end $$;
