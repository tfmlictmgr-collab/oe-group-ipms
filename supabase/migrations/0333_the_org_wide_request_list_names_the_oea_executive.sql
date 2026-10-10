-- The list of who sees every request names the OEA Executive (10 Oct 2026).
--
-- `request_read_all_roles()` (0185) is decision 19's one definition of
-- org-wide request sight: admin, executive, payment_audit_approver. 0307 then
-- gave the OEA Executive `tickets.read_all` at baseline — decision 59: "org-wide
-- sight of operations, dispatch and closure" — and 0309 made them do everything
-- a manager does across the organisation. The grant moved and the definition
-- did not, so `verify-request-visibility` has reported the Executive as holding
-- a capability "expected nowhere" since 3 Oct. The grant is the board's
-- decision; the definition was the stale half. Decision 24's sentence, applied
-- to a list: adding the second case is finished when every reader of the first
-- has been re-read.
--
-- Nothing reads this function but that suite (checked against the live
-- catalogue: no policy, view or function names it), so no one's access moves.
-- The Executive's reach stays switchable on the operator matrix
-- (`tickets.read_all`, `operations.org_wide`) exactly as before.

create or replace function request_read_all_roles()
returns user_role[]
language sql
immutable
set search_path = public
as $$
  select array['admin', 'executive', 'payment_audit_approver', 'operations_executive']::user_role[];
$$;

do $$
begin
  if exists (select 1 from pg_policy where pg_get_expr(polqual, polrelid) ilike '%request_read_all_roles%')
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                 and proname <> 'request_read_all_roles' and prosrc ilike '%request_read_all_roles%') then
    raise exception '0333: something now reads request_read_all_roles — re-read what this widens before applying';
  end if;
end $$;
