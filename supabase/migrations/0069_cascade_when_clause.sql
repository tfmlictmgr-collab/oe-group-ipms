-- The cascade still did not fire, and this time the fix was the cause.
--
-- `0068` correctly removed the `UPDATE OF path` column list, then added
-- `WHEN (pg_trigger_depth() = 1)` as a recursion guard. That guard is never true.
--
-- **For an AFTER trigger, the WHEN condition is evaluated immediately after the
-- row change — inside the main statement, before any trigger function runs — and
-- it decides whether the event is even QUEUED.** At that moment nothing is nested
-- inside a trigger, so `pg_trigger_depth()` is 0, the condition is false, and the
-- trigger is never queued at all.
--
-- Confirmed by instrumentation rather than reasoning: a `raise notice` as the very
-- first statement of the function produced no output, while the audit trigger on
-- the same table (which has no WHEN clause) fired normally.
--
-- The lesson generalises past this trigger: **a WHEN clause runs in a different
-- context from the function body it gates.** Row values are available to both;
-- execution state like trigger depth is not. Recursion guards belong in the body.

create or replace function org_nodes_cascade_path()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Here, inside the body, we genuinely are inside a trigger: depth is 1 for the
  -- statement a person ran, and 2+ for the updates this function itself makes.
  -- The descendants' own triggers therefore return immediately instead of making
  -- a second pass over rows this statement has already corrected.
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  -- One statement moves the entire subtree at any depth: every descendant's path
  -- begins with the old path, so whatever follows that prefix is unchanged.
  -- `_%` rather than `%` so the moved row cannot match itself.
  update org_nodes
     set path = new.path || right(path, length(path) - length(old.path))
   where path like old.path || '_%'
     and org_id = new.org_id;

  return null;
end;
$$;

drop trigger if exists org_nodes_path_cascade on org_nodes;

-- The WHEN clause now asks only about row values, which is all it can reliably
-- see. Keeping it means the common case — any update that does not move a node —
-- queues no event at all.
create trigger org_nodes_path_cascade after update on org_nodes
  for each row when (new.path is distinct from old.path)
  execute function org_nodes_cascade_path();

-- Repair anything re-parented while the cascade was inert, a generation at a time.
do $$
declare
  v_fixed integer;
  v_pass  integer := 0;
begin
  loop
    v_pass := v_pass + 1;
    with corrected as (
      update org_nodes c
         set path = p.path || c.id::text || '/'
        from org_nodes p
       where c.parent_id = p.id
         and c.org_id = p.org_id
         and c.path is distinct from p.path || c.id::text || '/'
      returning c.id
    )
    select count(*) into v_fixed from corrected;

    exit when v_fixed = 0 or v_pass > 10;
  end loop;
  raise notice 'path repair finished after % pass(es)', v_pass;
end $$;
