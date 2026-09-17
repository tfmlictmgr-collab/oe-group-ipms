-- Bank statement import + daily reconciliation.
--
-- Reconciliation answers one question: does what the ledger says we hold agree
-- with what the bank says we hold? A variance means either a movement we have
-- not recorded, or a recorded movement that never happened — and in a
-- client-funds account both are serious.
--
-- Statement lines are kept SEPARATE from ledger postings on purpose. The
-- statement is evidence from a third party; the ledger is our own record.
-- Merging them would let an import silently rewrite our books, and would leave
-- nothing independent to reconcile against.

create type statement_line_status as enum ('unmatched', 'matched', 'ignored');

create table bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bank_account_id uuid not null references bank_accounts(id) on delete cascade,

  value_date date not null,
  description text,
  reference text,
  -- Signed from the account's point of view: money in positive, money out
  -- negative. Same convention as the ledger's asset side, so a matched pair
  -- compares directly without sign juggling.
  amount numeric(16,2) not null check (amount <> 0),

  -- The bank's own unique reference where one exists. This is what makes
  -- re-importing an overlapping statement safe.
  external_id text,

  status statement_line_status not null default 'unmatched',
  matched_entry_id uuid references ledger_entries(id),
  matched_at timestamptz,
  matched_by uuid references users(id),

  import_batch_id uuid,
  imported_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index bank_statement_lines_acct_date_idx
  on bank_statement_lines (bank_account_id, value_date desc);
create index bank_statement_lines_status_idx
  on bank_statement_lines (org_id, status);
create index bank_statement_lines_batch_idx on bank_statement_lines (import_batch_id);

-- Dedupe on the bank's own reference. Deliberately NOT on
-- (date, amount, description): two genuinely separate ₦5,000 charges on the
-- same day are normal, and silently dropping the second would understate the
-- account. Lines without an external_id are flagged as possible duplicates in
-- the import preview instead, and a human decides.
create unique index bank_statement_lines_external_uidx
  on bank_statement_lines (bank_account_id, external_id)
  where external_id is not null;

alter table bank_statement_lines enable row level security;

create policy bank_statement_lines_select on bank_statement_lines for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));

create policy bank_statement_lines_write on bank_statement_lines for all
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]))
  with check (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));

create trigger audit_statement_line after insert or update on bank_statement_lines
  for each row execute function log_audit('bank_statement.line');

-- ── Reconciliation runs ────────────────────────────────────────────────────
create type reconciliation_status as enum ('balanced', 'variance');

create table reconciliations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bank_account_id uuid not null references bank_accounts(id) on delete cascade,
  as_of_date date not null,

  ledger_balance numeric(16,2) not null,
  statement_balance numeric(16,2) not null,
  variance numeric(16,2) not null,

  matched_lines integer not null default 0,
  unmatched_lines integer not null default 0,
  unmatched_value numeric(16,2) not null default 0,

  status reconciliation_status not null,
  notes text,
  run_by uuid references users(id),
  run_at timestamptz not null default now()
);

create index reconciliations_acct_date_idx
  on reconciliations (bank_account_id, as_of_date desc);

alter table reconciliations enable row level security;

create policy reconciliations_select on reconciliations for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));

create policy reconciliations_write on reconciliations for all
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]))
  with check (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));

create trigger audit_reconciliation after insert on reconciliations
  for each row execute function log_audit('reconciliation.run');

/**
 * Suggests matches between unmatched statement lines and ledger entries.
 *
 * Conservative by design: it only auto-matches where exactly ONE ledger entry
 * moves the bank's ledger account by exactly the line's amount within a few
 * days. If two candidates fit, it matches neither and leaves both for a person
 * — a wrong auto-match is worse than no match, because it makes the books look
 * reconciled when they are not.
 */
create or replace function auto_match_statement_lines(
  p_bank_account_id uuid,
  p_day_window integer default 3
)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_ledger_account uuid;
  v_org uuid;
  line record;
  v_entry uuid;
  v_candidates integer;
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
    -- Candidate entries: net movement on the bank account equals the line.
    select count(*), min(e.id) into v_candidates, v_entry
    from ledger_entries e
    join ledger_postings p on p.entry_id = e.id and p.account_id = v_ledger_account
    where e.org_id = v_org
      and e.entry_date between line.value_date - p_day_window and line.value_date + p_day_window
      and not exists (
        select 1 from bank_statement_lines m
        where m.matched_entry_id = e.id and m.status = 'matched'
      )
    group by e.id
    having sum(p.amount) = line.amount
    limit 2;

    -- Exactly one candidate, or leave it for a human.
    if v_candidates = 1 and v_entry is not null then
      update bank_statement_lines
      set status = 'matched', matched_entry_id = v_entry,
          matched_at = now(), matched_by = auth.uid()
      where id = line.id;
      v_matched := v_matched + 1;
    end if;
  end loop;

  return v_matched;
end;
$$;

/**
 * Runs a reconciliation as at a date and records the result.
 *
 * ledger_balance    — what our books say the bank holds
 * statement_balance — opening balance plus every statement line up to the date
 * variance          — the difference; anything non-zero needs explaining
 *
 * The run is always recorded, balanced or not. A reconciliation that is only
 * saved when it succeeds is a reconciliation nobody can audit.
 */
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

  -- The bank's evidence. The opening balance is already represented as a ledger
  -- entry, so it is NOT added again here — doing so is the classic way to
  -- produce a variance exactly equal to the opening balance.
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
    case when v_ledger - v_statement = 0 then 'balanced' else 'variance' end,
    auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function auto_match_statement_lines(uuid, integer) from public;
revoke all on function run_reconciliation(uuid, date) from public;
grant execute on function auto_match_statement_lines(uuid, integer) to authenticated;
grant execute on function run_reconciliation(uuid, date) to authenticated;
