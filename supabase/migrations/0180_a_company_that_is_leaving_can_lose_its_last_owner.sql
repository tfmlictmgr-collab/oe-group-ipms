-- `vendor_users_keep_an_owner` (0163) exists to stop a living vendor company
-- being left unadministrable — the last person who can invite, invoice and
-- manage contracts must not be removed while the company still trades. That
-- rule is right, and it is unchanged here.
--
-- What it also did, unintentionally, is make a vendor company **impossible to
-- delete at all**. `vendor_users.vendor_id` cascades from `vendors`, so
-- deleting the company deletes its members — and the trigger, seeing the last
-- owner row go, refuses. The company survives every attempt, and the refusal
-- names a remedy ("appoint another owner") that cannot help, because the next
-- owner would block the delete just the same.
--
-- ── How it surfaced ───────────────────────────────────────────────────────
-- `sweepProbeVendors` in `scripts/lib/probe-cleanup.mjs` has been unable to
-- delete a single vendor since 0163 landed, and never said so: it counts
-- successes and discards the error, so it reports `0` whether it removed
-- nothing because there was nothing to remove, or because every delete was
-- refused. A probe contractor was consequently still sitting in the analytics
-- contractor filter — the exact defect that helper was written to prevent —
-- with its own cleanup silently failing.
--
-- 📌 Fifth appearance of the same class of finding in this build: a routine
-- that reports a count it never verified. The helper is fixed alongside this
-- migration to surface refusals rather than absorb them.
--
-- ── The fix ───────────────────────────────────────────────────────────────
-- A cascade deletes the parent BEFORE its children, so by the time this
-- trigger runs on behalf of a company that is being deleted, `vendors` no
-- longer holds that row. That distinction is exact, needs no flag, and cannot
-- be reached from the application path this rule actually guards: removing a
-- member from a company that still exists is refused exactly as before.
create or replace function vendor_users_keep_an_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (TG_OP = 'DELETE' and old.is_owner)
     or (TG_OP = 'UPDATE' and old.is_owner and not new.is_owner) then

    -- The company itself is going. There is no company left to leave
    -- unadministrable, so there is nothing to protect.
    if not exists (select 1 from vendors where id = old.vendor_id) then
      return coalesce(new, old);
    end if;

    if not exists (
      select 1 from vendor_users
       where vendor_id = old.vendor_id and is_owner and id <> old.id
    ) then
      raise exception 'a vendor company must keep at least one owner — appoint another before removing this one';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

comment on function vendor_users_keep_an_owner is
  'Keeps a LIVING vendor company administrable: its last owner cannot be removed or demoted. Silent when the company itself is being deleted — the cascade removes the parent first, so an absent vendors row is the reliable signal that there is no company left to protect.';
