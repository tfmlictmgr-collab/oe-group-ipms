-- The rejection message still taught the order `0087` replaced.
--
-- `0087` moved LOCATION above PROJECT and re-levelled the tree accordingly, but
-- it changed `hierarchy_depth()` only. The guard that *uses* that depth —
-- `org_nodes_maintain_path()`, written in `0066` — carries the order in its
-- exception text, and that string was left at the pre-amendment wording:
--
--     a project cannot sit directly under a region — the order is
--     region, project, location, site
--
-- Every clause of that sentence is now false in the same breath: it correctly
-- refuses the insert, then names as correct the very arrangement it refused.
-- A reader who trusts it retries with the same parentage and is refused again.
-- This is worse than no message — a wrong instruction costs more than silence,
-- because it is acted on.
--
-- 📌 **An error message is part of the interface, not commentary on it.** When a
-- rule moves, the sentence that explains the rule moves with it. `0087` audited
-- the behaviour it was changing and not the text that described it; the two live
-- in different functions, so nothing forced them to be read together.
--
-- Nothing but the string changes. The function is reproduced verbatim from
-- `0066` — the project never edits an applied migration in place, so the whole
-- body is restated here rather than patched there.

create or replace function org_nodes_maintain_path()
returns trigger language plpgsql set search_path = public as $$
declare
  v_parent org_nodes%rowtype;
begin
  if new.parent_id is null then
    if new.level <> 'region' then
      raise exception 'a % must sit under a parent — only a region is a root', new.level;
    end if;
    new.path := '/' || new.id::text || '/';
  else
    select * into v_parent from org_nodes where id = new.parent_id;
    if v_parent.id is null then
      raise exception 'that parent does not exist';
    end if;
    if v_parent.deleted_at is not null then
      raise exception 'cannot file something under a retired %', v_parent.level;
    end if;
    if hierarchy_depth(new.level) <> hierarchy_depth(v_parent.level) + 1 then
      raise exception 'a % cannot sit directly under a % — the order is region, location, project, site',
        new.level, v_parent.level;
    end if;
    new.path := v_parent.path || new.id::text || '/';
  end if;

  return new;
end;
$$;

comment on function org_nodes_maintain_path is
  'Materialises org_nodes.path and enforces REGION → LOCATION → PROJECT → SITE (the 0087 amendment). The rejection text states that order — keep the two in step.';
