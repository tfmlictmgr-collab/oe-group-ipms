-- A ticket cannot be assigned to someone outside its own organisation.
--
-- Build audit 0806-M2 closed the half of this that LEAKED: `cascadeToUserIds()`
-- now filters recipients by org, so a foreign-org user id no longer produces a
-- real WhatsApp/SMS/Telegram/email send on another org's paid credentials.
--
-- It deliberately did not close the WRITE, and that is what this does.
-- `assignTicket()` pushes its `opsUserId` parameter straight into
-- `tickets.assigned_to_user_id` with no validation, and `tickets_update`
-- (0052) constrains which ticket ROWS a caller may touch -- it has no
-- `WITH CHECK` at all, so nothing has ever validated the VALUE being written.
--
-- What that leaves, now that both notification paths correctly no-op for a
-- foreign-org recipient, is a silently dead assignment. Checked rather than
-- assumed: `tickets_select` gates its assignee clause INSIDE
-- `org_id = current_user_org_id()`, so the foreign assignee genuinely cannot
-- read the ticket -- B1 isolation holds and this is not a data leak. But the
-- ticket now records an assignee who structurally can never see it, the
-- dispatcher is told "Request dispatched", nobody is notified, and the job
-- sits there. A queue that lies about who is handling the work is its own
-- kind of failure.
--
-- The same gap exists for `assigned_vendor_id`. `assignTicket()`'s vendor
-- branch happens to be safe today because it resolves the vendor through the
-- caller's own session (`vendors_select` is org-scoped, so a foreign id
-- returns no row) -- but that is the application being careful, not the
-- database being correct, and the next caller to write that column gets no
-- such protection. Both columns are checked here, for the same reason 0107
-- generalised its media-RLS fix to `invoice-attachments` rather than patching
-- the one bucket that had been reported.

-- ── Refuse to install over data that already violates it ──────────────────
--
-- The precedent is 0108's `logo_url` CHECK, where the existing production
-- values were verified against the constraint shape BEFORE it was added
-- rather than after. The same care applies to a trigger: it only governs
-- future writes, so silently leaving pre-existing violations in place would
-- mean the invariant reads as enforced while the table already disagrees.
-- This migration is transactional, so a raise here rolls back cleanly and
-- costs nothing but the information it surfaces.
do $$
declare
  v_bad text;
begin
  select string_agg(t.id::text, ', ')
    into v_bad
    from tickets t
   where (
           t.assigned_to_user_id is not null
           and not exists (
             select 1 from users u
              where u.id = t.assigned_to_user_id and u.org_id = t.org_id
           )
         )
      or (
           t.assigned_vendor_id is not null
           and not exists (
             select 1 from vendors v
              where v.id = t.assigned_vendor_id and v.org_id = t.org_id
           )
         );

  if v_bad is not null then
    raise exception
      'Refusing to add the assignee-org check: these tickets are already assigned outside their organisation: %. Investigate before enforcing -- they are real records and this migration will not guess what should happen to them.', v_bad;
  end if;
end;
$$;

-- ── The check itself ──────────────────────────────────────────────────────
--
-- ⚠️ SECURITY DEFINER, and that is load-bearing rather than habitual. A plain
-- trigger function executes as the INVOKING user, so `users_select` (0072a:
-- own row, or an oversight/FM role) would decide what this `exists` can see.
-- `tickets.assign` is an UNLOCKED capability (0050) -- the platform operator
-- can grant it to a role outside `oversight_roles_with_fm()`, e.g.
-- `fm_ops_staff`. Such a dispatcher cannot read their colleague's `users` row,
-- the `exists` would find nothing, and the trigger would refuse a perfectly
-- legitimate same-org assignment. A validity check must see the truth, not the
-- caller's view of it. This function reads two columns to answer one yes/no
-- question and returns no data to the caller, so widening its read is not
-- widening anyone's visibility.
create or replace function tickets_assignee_is_in_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to_user_id is not null and not exists (
    select 1 from users u
     where u.id = new.assigned_to_user_id
       and u.org_id = new.org_id
  ) then
    raise exception 'that person is not a member of this organisation, so they could never see this request';
  end if;

  if new.assigned_vendor_id is not null and not exists (
    select 1 from vendors v
     where v.id = new.assigned_vendor_id
       and v.org_id = new.org_id
  ) then
    raise exception 'that vendor does not belong to this organisation';
  end if;

  return new;
end;
$$;

-- ⚠️ Explicitly revoked from `anon`, not merely from `public`. This is the
-- 0806-L1 lesson written down: `create or replace function` re-triggers
-- Supabase's default grant to `anon`/`authenticated` even on an unchanged
-- signature, which is how 10 already-hardened functions were quietly reopened
-- in 0122-0125 and had to be closed again in 0126. A trigger function is not
-- meaningfully callable by hand, but the habit is the point -- the migration
-- that skips this is the one that reopens something that matters.
revoke all on function tickets_assignee_is_in_org() from public, anon;

drop trigger if exists tickets_assignee_in_org on tickets;
create trigger tickets_assignee_in_org
  before insert or update of assigned_to_user_id, assigned_vendor_id on tickets
  for each row execute function tickets_assignee_is_in_org();

comment on function tickets_assignee_is_in_org is
  'Refuses a ticket assignment to a user or vendor outside the ticket''s own organisation. The application layer never validated the value it wrote (build audit 0806-M2); this is the boundary. SECURITY DEFINER deliberately: the check must see the truth rather than the dispatcher''s RLS-filtered view of it.';
