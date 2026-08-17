-- Ops requisitions draw against the SAME service-charge fund a vendor
-- invoice already does. There is no separate "operating account" anywhere in
-- this chart — every account here is either client-funds itself or a
-- liability against it — and inventing one is a materially larger, separate
-- piece of work than a requisition asked for. So this is 'vendor_payable's
-- sibling, not a new kind of money.
--
-- ⚠️ Rewritten from the LIVE definition (`pg_get_functiondef`), per the 0136
-- lesson — only the new row is added.

create or replace function ensure_default_ledger_accounts(p_org_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  if current_user_role() is distinct from 'admin'
     or current_user_org_id() is distinct from p_org_id then
    if auth.uid() is not null then
      raise exception 'only an administrator of this organisation may set up the chart of accounts';
    end if;
  end if;

  insert into ledger_accounts (org_id, code, name, class, purpose)
  values
    (p_org_id, '1000', 'Client funds (bank)',        'asset',     'client_funds'),
    (p_org_id, '2000', 'Service charge funds held',  'liability', 'service_charge_fund'),
    (p_org_id, '2100', 'Landlord rent payable',      'liability', 'landlord_payable'),
    (p_org_id, '2200', 'Vendor payable',             'liability', 'vendor_payable'),
    (p_org_id, '2300', 'Tenant deposits held',       'liability', 'tenant_deposit'),
    (p_org_id, '2400', 'Ops requisitions payable',   'liability', 'requisition_payable'),
    (p_org_id, '4000', 'Management & admin fees',    'income',    'fee_income'),
    (p_org_id, '5000', 'Bank charges',               'expense',   'bank_charges'),
    (p_org_id, '9000', 'Suspense (unidentified)',    'liability', 'suspense')
  on conflict do nothing;
end;
$function$;

comment on function ensure_default_ledger_accounts is
  'The standard chart of accounts for an org. 2400 (requisition_payable) added for FM/PM ops requisitions (0169) -- the same fund a vendor payable draws against, not a new one.';

-- Backfill: every org that already ran this function is missing 2400, since
-- the function only inserts what is asked for and nothing re-invokes it on its
-- own. The unique index on (org_id, code) makes this idempotent — a second
-- run of this migration inserts nothing new.
do $$
declare o record;
begin
  for o in select id from orgs where deleted_at is null loop
    insert into ledger_accounts (org_id, code, name, class, purpose)
    values (o.id, '2400', 'Ops requisitions payable', 'liability', 'requisition_payable')
    on conflict (org_id, code) do nothing;
  end loop;
end;
$$;
