-- `review_vendor_registration` could never approve anything.
--
-- 0164 wrote the decision as:
--
--     set status = case when p_approve then 'approved' else 'changes_requested' end
--
-- Both branches are untyped literals, so the CASE resolves to `text`, and the
-- assignment fails at RUNTIME with:
--
--     column "status" is of type vendor_registration_status
--     but expression is of type text
--
-- Not at migration time — a plpgsql body is only parsed when it runs, which is
-- why 0164 applied cleanly and the function was still broken. Every other
-- status write in this schema assigns a literal directly, where Postgres infers
-- the column's type; a CASE is the one shape where it does not, and it is
-- exactly the shape a two-way decision reaches for.
--
-- Found by verify-vendor-self-service.mjs section D10 — the check that an
-- administrator can actually approve a submitted pack. Worth noting that D1–D9
-- all passed: every refusal worked perfectly and the only broken path was the
-- one that says yes. A suite that only tested the refusals would have shipped
-- this.
--
-- Rewritten from the LIVE definition, per the 0136 lesson. The only change is
-- the cast.

create or replace function review_vendor_registration(
  p_vendor_id uuid,
  p_approve boolean,
  p_notes text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  r vendor_registrations%rowtype;
begin
  select * into r from vendor_registrations where vendor_id = p_vendor_id for update;
  if r.id is null then raise exception 'that registration could not be found'; end if;
  if r.org_id is distinct from current_user_org_id() then
    raise exception 'that registration belongs to another organisation';
  end if;
  if not coalesce((select has_permission('vendors.write')), false) then
    raise exception 'you are not able to review vendor registrations';
  end if;
  if r.status <> 'submitted' then
    raise exception 'that registration is not currently with you for review';
  end if;
  if length(trim(coalesce(p_notes, ''))) < 10 then
    raise exception 'record your reason — at least 10 characters — so the decision can be explained later';
  end if;

  update vendor_registrations
     set status = (case when p_approve then 'approved' else 'changes_requested' end)::vendor_registration_status,
         reviewed_at = now(), reviewed_by = auth.uid(), review_notes = trim(p_notes),
         updated_at = now()
   where id = r.id;

  perform notify_user(
    u.user_id, 'application',
    case when p_approve then 'Your registration was approved'
         else 'Your registration needs a change' end,
    trim(p_notes),
    '/dashboard/profile/registration'
  )
  from vendor_users u
  where u.vendor_id = p_vendor_id;
end;
$$;

comment on function review_vendor_registration is
  'A person decides a vendor registration and states why, both on approval and on refusal. Machine findings on the documents inform this; they never make it (CLAUDE.md decision 10).';
