-- Fix: nobody could ever submit a vendor application.
--
-- 0021's INSERT policy gated on:
--     exists (select 1 from orgs o where o.id = org_id and o.vendor_applications_open)
-- but a WITH CHECK subquery executes as the CALLER, and `orgs` has RLS
--     using (id = current_user_org_id())
-- For anon, current_user_org_id() is NULL, so the subquery returned no rows, the
-- EXISTS was false, and every public submission was rejected — including from an
-- org that had explicitly opened applications.
--
-- The check must consult the flag without granting the caller read access to
-- `orgs`. A SECURITY DEFINER predicate does exactly that: it answers one
-- boolean question and reveals nothing else — not the org's name, not whether
-- an unknown id exists (an unknown id and a closed org both return false).

create or replace function org_accepts_vendor_applications(p_org_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce(
    (select vendor_applications_open from orgs where id = p_org_id),
    false
  );
$$;

revoke all on function org_accepts_vendor_applications(uuid) from public;
grant execute on function org_accepts_vendor_applications(uuid) to anon, authenticated;

drop policy if exists vendor_applications_public_insert on vendor_applications;
create policy vendor_applications_public_insert on vendor_applications
  for insert to anon, authenticated
  with check (
    status = 'submitted'
    and org_accepts_vendor_applications(org_id)
  );
