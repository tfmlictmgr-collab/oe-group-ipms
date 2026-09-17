-- The subtree cascade never ran.
--
-- `0066` attached it as `after update of path on org_nodes`. **`UPDATE OF column`
-- fires on the columns NAMED IN THE STATEMENT, not on the columns whose values
-- changed.** Re-parenting is `update org_nodes set parent_id = …`, which does not
-- name `path` — so although the BEFORE trigger correctly recomputed the row's own
-- path, the AFTER trigger that carries the change down to its descendants was
-- never invoked.
--
-- Caught by verify-hierarchy: a site four levels down kept a path beginning with
-- the region it had just been moved out of. The consequence is not cosmetic. Every
-- place-scoped read matches on the path prefix, so a stale descendant path means a
-- manager assigned to the NEW parent reaches nothing, while a manager assigned to
-- the OLD parent still reaches a subtree that no longer belongs to them. The suite
-- measured both: zero properties reachable from the new parent, and the old parent
-- still reaching the moved subtree.
--
-- **A column-scoped trigger tests the statement's shape, not the data's.** When the
-- value is produced by another trigger, the column list is exactly wrong.

create or replace function org_nodes_cascade_path()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.path is distinct from old.path then
    -- One statement moves the entire subtree at any depth: every descendant's
    -- path begins with the old path, so the tail after that prefix is what stays
    -- the same. `_%` rather than `%` so the moved row does not match itself.
    update org_nodes
       set path = new.path || right(path, length(path) - length(old.path))
     where path like old.path || '_%'
       and org_id = new.org_id;
  end if;
  return null;
end;
$$;

drop trigger if exists org_nodes_path_cascade on org_nodes;

-- No column list. The guard above compares the values, which is the actual
-- question — and the recursion guard stops the descendants' own triggers from
-- making a second, redundant pass over rows this statement has already fixed.
create trigger org_nodes_path_cascade after update on org_nodes
  for each row when (pg_trigger_depth() = 1)
  execute function org_nodes_cascade_path();

-- Repair anything already re-parented while the cascade was inert. Walks down a
-- level at a time so each generation is corrected before its children read it.
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

    exit when v_fixed = 0 or v_pass > 10;   -- four levels; 10 is generous
  end loop;
  raise notice 'path repair finished after % pass(es)', v_pass;
end $$;
