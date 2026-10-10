-- A tenancy that was ever live, and an invoice with money on it, cannot be
-- hidden by a direct write (requested 10 Oct 2026: "resolve all found
-- problems, no data leaks").
--
-- 📌 Numbered 0332, not 0331: 0331 is reserved for the storage and
-- applications fix being written in a parallel session.
--
-- Two findings of the same shape, one per table:
--
--   1. LEASES. `authenticated` holds UPDATE on every `leases` column and
--      `leases_write` admits the letting desk, so a property manager could
--      PATCH `deleted_at` on a LIVE tenancy (measured on staging by the 0330
--      session: one row updated). Every reader filters `deleted_at is null`,
--      so the tenancy vanished from Leases & Rent, the schedule, the
--      statements and the directory while its unit kept its occupant and its
--      demands stayed unpaid — decision 52's four-tenancies defect reached from
--      the lease side instead of the unit side. Clearing `deleted_at` was the
--      same door the other way: a deleted tenancy revived with no check that
--      its unit is still free. 0329 guarded a live lease's terms and 0330 its
--      status; its existence was the third column nobody guarded.
--      Nothing in the product soft-deletes a lease (checked: no app code, no
--      function writes `leases.deleted_at`). So a signed-in caller may delete or
--      restore a DRAFT — a tenancy that was never live and billed nothing — and
--      nothing else. A live one is ended with End tenancy; an ended one is a
--      record and stays one.
--
--   2. SERVICE CHARGES. `service_charges_update` admits `sc.manage` on the
--      caller's own properties, so a PATCH to `deleted_at` retired an invoice
--      directly — including a PAID one, which then disappeared from the
--      tenant's statement, the property statement and the budget, with the
--      money still in the fund. The three legitimate ways to withdraw invoices
--      (`void_sc_budget`, `reopen_sc_budget_for_correction`,
--      `retire_service_charges_for_regenerate`) each refuse money first and
--      withdraw a budget's invoices together, which keeps them adding up to
--      the budget (0227). A direct write did neither. Now: an invoice with
--      money attached is never withdrawn by a signed-in caller, by any path;
--      and outside those three functions it is not withdrawn or revived at
--      all. Each function names the budget it is acting for in a
--      transaction-local flag (0315/0329/0330's pattern), so the permission
--      cannot be borrowed for another budget.
--
-- With no signed-in caller (the service role, a scheduled job) both guards
-- stand aside, as 0329's and 0330's do: every such caller is a function or a
-- script stating its own rules.

set local lock_timeout = '5s';

-- ── 1. A tenancy's existence ───────────────────────────────────────────────
create or replace function guard_lease_soft_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null or new.deleted_at is not distinct from old.deleted_at then
    return new;
  end if;
  if old.status <> 'draft' then
    if new.deleted_at is not null then
      raise exception 'A tenancy that has been live is a record and cannot be deleted. End it with End tenancy instead.';
    end if;
    raise exception 'A deleted tenancy cannot be restored. Record the tenancy again if it is real.';
  end if;
  return new;
end $$;

revoke all on function guard_lease_soft_delete() from public, anon, authenticated, service_role;

drop trigger if exists leases_guard_soft_delete on leases;
create trigger leases_guard_soft_delete
  before update of deleted_at on leases
  for each row execute function guard_lease_soft_delete();

-- ── 2. An invoice's existence ──────────────────────────────────────────────
create or replace function guard_service_charge_retirement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_budget text := new.budget_id::text;
begin
  if auth.uid() is null or new.deleted_at is not distinct from old.deleted_at then
    return new;
  end if;

  if old.deleted_at is not null then
    raise exception 'A withdrawn invoice cannot be revived. Generate the budget''s invoices again instead.';
  end if;

  -- Money attached, seen in full rather than through the caller's own read
  -- scope (0292's reasoning) — hence SECURITY DEFINER.
  if coalesce(old.amount_paid, 0) > 0
     or old.status in ('paid', 'part_paid')
     or exists (select 1 from payment_intents pi
                 where pi.service_charge_id = old.id
                   and pi.status in ('pending', 'part_paid', 'paid'))
     or exists (select 1 from offline_payment_allocations a
                  join offline_payment_claims c on c.id = a.claim_id
                 where a.service_charge_id = old.id and c.status <> 'rejected') then
    raise exception 'This invoice has money attached, so it cannot be withdrawn. Deal with the payment first.';
  end if;

  if v_budget is distinct from coalesce(nullif(current_setting('app.sc_budget_void', true), ''), '-')
     and v_budget is distinct from coalesce(nullif(current_setting('app.sc_budget_correction', true), ''), '-')
     and v_budget is distinct from coalesce(nullif(current_setting('app.sc_invoice_retire', true), ''), '-') then
    raise exception 'An invoice is withdrawn with Regenerate, Correct and re-issue, or Void budget, which keep a budget''s invoices adding up to it.';
  end if;

  return new;
end $$;

revoke all on function guard_service_charge_retirement() from public, anon, authenticated, service_role;

drop trigger if exists service_charges_guard_retirement on service_charges;
create trigger service_charges_guard_retirement
  before update of deleted_at on service_charges
  for each row execute function guard_service_charge_retirement();

-- Regenerate names the budget it withdraws invoices for. Rebuilt from the live
-- catalogue through an exactly-once swap (0183), CR-free (0317), grants
-- asserted unchanged. `void_sc_budget` and `reopen_sc_budget_for_correction`
-- already set theirs.
do $$
declare
  d text;
  acl_before text;
  o text := $o$  update service_charges
     set deleted_at = now()
   where budget_id = p_budget_id and deleted_at is null;
end;$o$;
  n text := $n$  -- 0332. The invoice guard admits a withdrawal only for the budget named here.
  perform set_config('app.sc_invoice_retire', p_budget_id::text, true);
  update service_charges
     set deleted_at = now()
   where budget_id = p_budget_id and deleted_at is null;
  perform set_config('app.sc_invoice_retire', '', true);
end;$n$;
  fn regprocedure := 'public.retire_service_charges_for_regenerate(uuid)'::regprocedure;
begin
  select replace(pg_get_functiondef(p.oid), E'\r', ''), p.proacl::text into d, acl_before
    from pg_proc p where p.oid = fn;
  if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then
    raise exception '0332: retire_service_charges_for_regenerate — expected its update exactly once';
  end if;
  execute replace(d, o, n);
  if (select p.proacl::text from pg_proc p where p.oid = fn) is distinct from acl_before then
    raise exception '0332: retire_service_charges_for_regenerate — grants changed by the rebuild';
  end if;
end $$;

-- ── 3. Assertions ──────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name in ('guard_lease_soft_delete', 'guard_service_charge_retirement')
                and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) then
    raise exception '0332: a guard function is executable by a client role';
  end if;
  -- Every function that withdraws invoices names its budget, or the guard
  -- would refuse it.
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.prosrc ~* 'update\s+service_charges\s+set\s+deleted_at'
                and p.prosrc !~ 'app\.sc_(budget_void|budget_correction|invoice_retire)') then
    raise exception '0332: a function withdraws invoices without naming its budget';
  end if;
  -- And nothing writes a lease's deleted_at, which is what makes the lease
  -- guard safe to be strict.
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.prosrc ~* 'update\s+leases\s+set[^;]*deleted_at\s*=') then
    raise exception '0332: a function now writes leases.deleted_at — the lease guard needs a flag for it';
  end if;
end $$;
