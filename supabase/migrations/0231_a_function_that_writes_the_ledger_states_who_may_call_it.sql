-- A definer function that writes the ledger states who may call it — and one
-- that only reads still states who may not.
--
-- 📌 FOURTH INSTANCE. `0204` was written to record `revoke all … from public`,
-- `0209` was written because it happened again, and `0210`'s note records it
-- happening a third time four files after `0209`. This is the fourth, and it is
-- the worst of them, because it is the only one that WRITES THE LEDGER —
-- a control decision 7 names non-delegable and never a toggle.
--
-- Supabase grants EXECUTE to PUBLIC by default on every new function. Neither
-- of the two functions below was ever revoked, in any of the 249 migrations.
--
--   1. **`recognise_requisition_payable(uuid)`** (`0173`) is `security definer`
--      and inserts into `ledger_entries` and `ledger_postings`. Its only guards
--      are about the REQUISITION's state — approved, not already recognised —
--      and it makes no statement whatever about the CALLER: no
--      `current_user_org_id()`, no role, no `has_permission`. Given a
--      requisition id it posts to that requisition's org, whoever asked. That
--      is reachable by `anon` and by any authenticated user of any other
--      organisation, which is B1's isolation rule broken from the inside.
--
--      ⚠️ It has **no caller** — not in a migration, not in `app/`, not in
--      `lib/`, not in `scripts/`. It is locked to `service_role` rather than
--      dropped, because an out-of-band caller (n8n) cannot be ruled out from
--      the repository alone, and a function nobody can reach is harmless where
--      a dropped one that something did call is an outage. If it is still
--      unreferenced at the next audit, drop it.
--
--   2. **`resolve_payable(text, uuid)`** (`0151`) only reads — it answers the
--      org and amount of a payment or remittance — but it answered it to
--      `anon`. It keeps `authenticated`, because `lib/approvals/chain.ts` calls
--      it as the signed-in user and `enforce_approval_rules`, `0175` and
--      `0211`'s chain all call it from inside definer functions that must keep
--      working. An org predicate is deliberately NOT added: this function is
--      how the chain LEARNS which org a payable belongs to, so a caller-scoped
--      filter would make the trigger that validates a cross-org payable unable
--      to see the thing it is refusing.
--
-- And one authorisation gap that is not about a grant:
--
--   3. **`assign_application_unit`** (`0082`) is the only function in the
--      two-tier review set that gates on scope alone. Its four siblings —
--      `record_application_recommendation`, `_info_request`, `_approval`,
--      `_rejection` — all check `has_permission('applications.recommend')` or
--      `.approve` FIRST and then check scope. This one checks only
--      `applications.review_all or property_id in current_user_property_ids()`.
--      Decision 19 is explicit that the resolver does not filter on `relation`,
--      so a `property_owner` resolves through it exactly as a manager does —
--      and a landlord could therefore assign a unit on their own building to a
--      pending tenant application, acting inside the human review that decision
--      10 reserves to people holding the capability. B7's Service-requests cell
--      for `property_owner` reads "—" for the same reason.

-- ---------------------------------------------------------------------------
-- 1. The ledger write
-- ---------------------------------------------------------------------------

revoke all on function recognise_requisition_payable(uuid) from public;
revoke execute on function recognise_requisition_payable(uuid) from anon, authenticated;
grant execute on function recognise_requisition_payable(uuid) to service_role;

-- Defence in depth: the grant above is the boundary, and this is what holds if
-- a later `create or replace` re-applies Supabase's default grants — which is
-- exactly how `0114`'s correctly-closed `remember_conversation` was silently
-- reopened, per decision 24's note.
create or replace function recognise_requisition_payable(p_requisition_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  req ops_requisitions%rowtype;
  v_fund uuid;
  v_payable uuid;
  v_entry uuid;
begin
  select * into req from ops_requisitions where id = p_requisition_id for update;
  if req.id is null then
    raise exception 'requisition not found';
  end if;

  -- The caller, not merely the requisition. A signed-in caller must belong to
  -- the requisition's own organisation; a service-role caller has no
  -- auth.uid() and is trusted, exactly as create_rent_remittance is.
  if auth.uid() is not null and req.org_id is distinct from current_user_org_id() then
    raise exception 'that requisition belongs to another organisation';
  end if;

  if req.payable_entry_id is not null then
    return req.payable_entry_id;
  end if;

  if req.approved_at is null or req.status <> 'approved' then
    raise exception 'an unapproved requisition is not yet a liability';
  end if;

  v_fund := canonical_ledger_account(req.org_id, 'service_charge_fund');
  v_payable := canonical_ledger_account(req.org_id, 'requisition_payable');
  if v_fund is null or v_payable is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    req.org_id, coalesce(req.approved_at::date, current_date),
    'Requisition approved', req.reference, 'adjustment',
    'ops_requisition', req.id, req.approved_by
  )
  returning id into v_entry;

  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (req.org_id, v_entry, v_fund,     req.total_amount, 'Committed from the service charge fund'),
         (req.org_id, v_entry, v_payable, -req.total_amount, 'Owed against the requisition');

  update ops_requisitions set payable_entry_id = v_entry where id = req.id;
  return v_entry;
end;
$$;

-- Re-applied AFTER the replace, because create or replace re-grants (0210).
revoke all on function recognise_requisition_payable(uuid) from public;
revoke execute on function recognise_requisition_payable(uuid) from anon, authenticated;
grant execute on function recognise_requisition_payable(uuid) to service_role;

comment on function recognise_requisition_payable is
  'Posts an approved requisition into the ledger as a liability, once. Locked to service_role and, for a signed-in caller, to their own organisation -- it writes ledger_entries and ledger_postings, and until 0231 it was callable by anon with no statement about the caller at all.';

-- ---------------------------------------------------------------------------
-- 2. The payable read
-- ---------------------------------------------------------------------------

revoke all on function resolve_payable(text, uuid) from public;
revoke execute on function resolve_payable(text, uuid) from anon;
grant execute on function resolve_payable(text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The unit assignment
-- ---------------------------------------------------------------------------

create or replace function assign_application_unit(p_application_id uuid, p_unit_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
  u units%rowtype;
begin
  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null;
  if a.id is null then
    raise exception 'no such application';
  end if;

  -- The capability first, then the scope -- the order every sibling in 0082
  -- uses, and the half that was missing. Scope alone admits a property_owner,
  -- because current_user_property_ids() does not filter on relation and must
  -- not start to (decision 19: the resolver was right, the consumer was wrong).
  if not (select has_permission('applications.recommend')) then
    raise exception 'you do not hold applications.recommend';
  end if;
  if not (
    (select has_permission('applications.review_all'))
    or a.property_id in (select current_user_property_ids())
  ) then
    raise exception 'you may not act on this application';
  end if;

  if a.status not in ('submitted', 'under_review', 'info_requested') then
    raise exception 'this application is no longer open for review';
  end if;

  select * into u from units where id = p_unit_id and org_id = a.org_id;
  if u.id is null then
    raise exception 'no such unit';
  end if;
  if u.property_id is distinct from a.property_id then
    raise exception 'that unit does not belong to the property this application is for';
  end if;
  if u.occupant_user_id is not null then
    raise exception 'that unit already has an occupant';
  end if;

  update tenant_applications set unit_id = p_unit_id where id = a.id;
end;
$$;

revoke all on function assign_application_unit(uuid, uuid) from public;
revoke execute on function assign_application_unit(uuid, uuid) from anon;
grant execute on function assign_application_unit(uuid, uuid) to authenticated, service_role;

comment on function assign_application_unit is
  'Names the unit a pending application is for. Requires applications.recommend AND scope, in that order -- the same gate its four siblings in 0082 have always used, and which this one alone was missing (0231).';
