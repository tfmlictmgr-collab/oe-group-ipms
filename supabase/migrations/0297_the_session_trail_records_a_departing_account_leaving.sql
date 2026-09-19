-- `record_session_event` is a declared deactivation exception, and why.
--
-- Found by `verify-deactivation.mjs` section E, which is the rule 0195 and 0267
-- established: every function in `public` reaching `auth.uid()` must either
-- resolve identity through a deactivation-aware path or be NAMED as an
-- exception. `record_session_event` (0290) does neither. It reads
--
--     select org_id into v_org from users where id = v_uid;
--
-- with no `deactivated_at is null`, so a deactivated account can still write
-- its own `session.signed_in` / `session.signed_out` row.
--
-- ⚠️ That is the behaviour we want, and guarding it would be the wrong fix.
--
-- The function writes ONE thing: an audit row saying who signed in or out, from
-- what device and address. It reads nothing a deactivated account should not
-- see, returns nothing to its caller, and grants no reach into any other table
-- — `void`, and the only write is the `insert into audit_log`.
--
-- Add the guard and the trail loses exactly the row a security reviewer most
-- wants: the sign-out of an account somebody has just deactivated. Deactivation
-- does not end a live session's cookie — 0194 makes every policy refuse the
-- account, so the session becomes inert, but the browser still holds it and the
-- sign-out control still fires. A guard here would turn "we can see when their
-- session ended" into silence, for the one account where the question gets
-- asked. The trail is append-only precisely so that what happened stays
-- readable after the actor is gone (`audit_log_actor_id_fkey` blocks the
-- delete); withholding the last row of a departing account's session is the
-- same loss, arrived at from the other end.
--
-- 📌 Recognised as a NAME rather than a rule. The two existing exceptions are
-- named for structural reasons that generalise poorly (`accept_invitation`
-- creates the very row a guard would read; `reject_payment` is not SECURITY
-- DEFINER). This one is a judgement about what the audit trail is FOR, and a
-- regex cannot carry a judgement. A future function that writes only to
-- `audit_log` still arrives here for a decision rather than slipping past a
-- pattern, which is what section E exists to force.
--
-- `scripts/verify-deactivation.mjs` and `scripts/generate-deactivation-guards.mjs`
-- carry the same three names. The migration's copy decides what shipped, the
-- suite's decides what is still believed, and a disagreement is worth the
-- failure it causes (0267).

do $$
declare
  v_bad text[] := '{}';
  r record;
begin
  for r in
    select p.proname, pg_get_functiondef(p.oid) as def,
           pg_get_function_result(p.oid) as ret
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) like '%auth.uid()%'
  loop
    continue when r.ret = 'trigger';

    continue when r.proname = any (array[
      -- creates the users row - a guard reading that row would refuse every new joiner
      'accept_invitation',
      -- not SECURITY DEFINER - runs under RLS as the caller, which already fails closed
      'reject_payment',
      -- 0297. Writes one audit row and nothing else; a guard would delete the
      -- sign-out of the account you just deactivated from the trail
      'record_session_event'
    ]);

    continue when r.def ~* 'if\s+auth\.uid\(\)\s+is\s+not\s+null\s+then\s+raise';

    if r.def !~ '(deactivated_at\s+is\s+null|active_uid\(\)|current_user_is_active\(\)|current_user_org_id\(\)|current_user_role\(\)|current_user_property_ids\(\)|current_user_vendor_ids\(\))'
    then
      v_bad := v_bad || r.proname;
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception
      'These functions reach auth.uid() with no deactivation-aware path and are not declared exceptions: %',
      array_to_string(v_bad, ', ');
  end if;
end;
$$;

-- The exception is only honest while the function stays this narrow. If it ever
-- learns to read or return anything beyond the row it writes, the reasoning
-- above expires and it needs the guard after all.
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_session_event';

  if v_def is null then
    raise exception '0297: record_session_event is missing';
  end if;
  -- Stated as plain counts rather than one clever pattern: a migration that
  -- can fail for a reason nobody intended is worse than a looser check.
  if v_def !~* 'insert[[:space:]]+into[[:space:]]+audit_log' then
    raise exception '0297: record_session_event no longer writes the audit trail';
  end if;

  -- Exactly one INSERT, and it is the one above. Any UPDATE or DELETE at all
  -- means it now changes something other than the trail, and the reasoning
  -- that makes the exemption safe no longer holds.
  if (select count(*) from regexp_matches(v_def, 'insert[[:space:]]+into', 'gi')) <> 1 then
    raise exception '0297: record_session_event has more than one INSERT — the exemption reasoning has expired';
  end if;
  if v_def ~* '\mupdate\M' or v_def ~* 'delete[[:space:]]+from' then
    raise exception '0297: record_session_event now writes beyond audit_log — the exemption reasoning has expired';
  end if;
end;
$$;

comment on function record_session_event(text, text, text) is
  'Records one session.signed_in / session.signed_out audit row with the device and address it came from. A DECLARED deactivation exception (0297): it is deliberately reachable by a deactivated account, because the sign-out of an account somebody has just deactivated is the row a security reviewer most wants and a guard here would delete it from the trail. Writes to audit_log and nothing else; if that ever changes, the exemption expires.';
