-- Fixes two defects in 0029 that made reconciliation unusable.
--
-- 1. auto_match_statement_lines used `min(e.id)` to pick a candidate entry.
--    Postgres has no min(uuid), so the function raised
--      function min(uuid) does not exist
--    on every call. The aggregate was also malformed: it mixed a grouped
--    HAVING with an outer aggregate over the same query. Rewritten as a CTE
--    that collects candidates first, then counts them — which expresses the
--    actual intent (match only when exactly one entry fits) far more clearly.
--
-- 2. run_reconciliation built its status with a CASE returning text and
--    inserted it into a reconciliation_status column, which Postgres refuses
--    without an explicit cast.
--
-- Both surfaced only when the functions were called against real data — a
-- reminder that a migration applying cleanly says nothing about whether its
-- functions run.

create or replace function auto_match_statement_lines(
  p_bank_account_id uuid,
  p_day_window integer default 3
)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_ledger_account uuid;
  v_org uuid;
  line record;
  v_ids uuid[];
  v_matched integer := 0;
begin
  select ledger_account_id, org_id into v_ledger_account, v_org
  from bank_accounts where id = p_bank_account_id;

  if v_ledger_account is null then
    raise exception 'this bank account is not linked to a ledger account';
  end if;
  if v_org is distinct from current_user_org_id() and auth.uid() is not null then
    raise exception 'that bank account belongs to another organisation';
  end if;
  if auth.uid() is not null
     and current_user_role() not in ('admin','finance_approver') then
    raise exception 'only finance or an administrator may reconcile';
  end if;

  for line in
    select * from bank_statement_lines
    where bank_account_id = p_bank_account_id and status = 'unmatched'
    order by value_date
  loop
    -- Entries whose NET movement on this bank account equals the line, within
    -- the date window, and not already claimed by another statement line.
    with candidates as (
      select e.id
      from ledger_entries e
      join ledger_postings p on p.entry_id = e.id and p.account_id = v_ledger_account
      where e.org_id = v_org
        and e.entry_date between line.value_date - p_day_window
                             and line.value_date + p_day_window
        and not exists (
          select 1 from bank_statement_lines m
          where m.matched_entry_id = e.id and m.status = 'matched'
        )
      group by e.id
      having sum(p.amount) = line.amount
      limit 2                       -- two is enough to know it is ambiguous
    )
    select array_agg(id) into v_ids from candidates;

    -- Exactly one candidate, or leave it for a person. A wrong auto-match is
    -- worse than no match: it makes the books look reconciled when they are not.
    if v_ids is not null and array_length(v_ids, 1) = 1 then
      update bank_statement_lines
      set status = 'matched', matched_entry_id = v_ids[1],
          matched_at = now(), matched_by = auth.uid()
      where id = line.id;
      v_matched := v_matched + 1;
    end if;
  end loop;

  return v_matched;
end;
$$;

create or replace function run_reconciliation(
  p_bank_account_id uuid,
  p_as_of_date date default current_date
)
returns reconciliations language plpgsql security definer set search_path = public as $$
declare
  bank bank_accounts%rowtype;
  v_ledger numeric(16,2);
  v_statement numeric(16,2);
  v_matched integer;
  v_unmatched integer;
  v_unmatched_value numeric(16,2);
  v_row reconciliations%rowtype;
begin
  select * into bank from bank_accounts where id = p_bank_account_id;
  if bank.id is null then
    raise exception 'bank account not found';
  end if;
  if bank.org_id is distinct from current_user_org_id() and auth.uid() is not null then
    raise exception 'that bank account belongs to another organisation';
  end if;
  if auth.uid() is not null
     and current_user_role() not in ('admin','finance_approver') then
    raise exception 'only finance or an administrator may reconcile';
  end if;
  if bank.ledger_account_id is null then
    raise exception 'this bank account is not linked to a ledger account';
  end if;

  -- Our books, as at the date.
  select coalesce(sum(p.amount), 0) into v_ledger
  from ledger_postings p
  join ledger_entries e on e.id = p.entry_id
  where p.account_id = bank.ledger_account_id
    and e.entry_date <= p_as_of_date;

  -- The bank's evidence. The opening balance is already a ledger entry, so it
  -- is NOT added again here — doing so produces a variance exactly equal to
  -- the opening balance, which is the classic way to make reconciliation look
  -- permanently broken.
  select coalesce(sum(amount), 0) into v_statement
  from bank_statement_lines
  where bank_account_id = p_bank_account_id
    and value_date <= p_as_of_date
    and status <> 'ignored';

  select
    count(*) filter (where status = 'matched'),
    count(*) filter (where status = 'unmatched'),
    coalesce(sum(amount) filter (where status = 'unmatched'), 0)
  into v_matched, v_unmatched, v_unmatched_value
  from bank_statement_lines
  where bank_account_id = p_bank_account_id and value_date <= p_as_of_date;

  insert into reconciliations (
    org_id, bank_account_id, as_of_date, ledger_balance, statement_balance,
    variance, matched_lines, unmatched_lines, unmatched_value, status, run_by
  )
  values (
    bank.org_id, p_bank_account_id, p_as_of_date, v_ledger, v_statement,
    v_ledger - v_statement, v_matched, v_unmatched, v_unmatched_value,
    -- Explicit cast: a bare CASE yields text, which the enum column rejects.
    (case when v_ledger - v_statement = 0 then 'balanced' else 'variance' end)::reconciliation_status,
    auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;
