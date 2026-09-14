-- Two regressions from 0122–0125, both caught by the standing guards rather
-- than by review. Fixed together because neither is worth a file of its own.

-- ── 1. The reporter's correction lost its audit entry ─────────────────────
--
-- ⚠️ `verify-conversational-triage` section F: "NO AUDIT ENTRY FOR A REPORTER
-- PRIORITY CHANGE".
--
-- 0124 moved the body of `set_ticket_urgency_by_reporter` down into
-- `apply_reporter_urgency` so the portal and the chat channels could share one
-- rule. The move dropped the `audit_log` insert at the end of it, and softened
-- the thread message from "Priority corrected by the reporter: normal →
-- critical" to a line that named only the new value.
--
-- The audit entry is the one that matters. A priority is how work is ordered
-- and how an SLA is measured against, and the trail has to say who moved it and
-- from what — "the reporter escalated this" and "an operator escalated this"
-- are different facts about the same row. A refactor that keeps the behaviour
-- and loses the record has not kept the behaviour.
--
-- Restored verbatim, with one change: `actor_id` is `auth.uid()` rather than a
-- hardcoded null. For the chat caller that evaluates to null exactly as before
-- — a webhook has no session — and for the portal caller it names the person
-- who did it, which is the whole point of the column.
create or replace function apply_reporter_urgency(
  p_ticket_id uuid,
  p_urgency   text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  t tickets%rowtype;
begin
  if p_urgency not in ('critical', 'high', 'normal', 'low') then
    return false;
  end if;

  select * into t from tickets
   where id = p_ticket_id
     and status not in ('resolved', 'closed')
   for update;

  if t.id is null then
    return false;
  end if;

  -- A human has since judged this. The reporter's opinion is recorded as a
  -- message but does not overwrite a decision an operator made deliberately.
  if t.urgency_source = 'staff' then
    insert into ticket_messages (org_id, ticket_id, author, channel, body)
    values (t.org_id, t.id, 'reporter', t.channel::text,
            format('Asked for priority %s (not applied — an operator had already set it).', p_urgency));
    return false;
  end if;

  update tickets
     set urgency = p_urgency::ticket_urgency,
         urgency_source = 'reporter',
         urgency_changed_at = now(),
         -- Someone telling us it is worse than we thought is exactly the case a
         -- person should look at, so the review flag is raised, never cleared.
         requires_human_review = case
           when p_urgency in ('critical', 'high') then true
           else requires_human_review
         end
   where id = t.id;

  -- `t` still holds the row as it was read above, so both messages below
  -- report the BEFORE value correctly.
  insert into ticket_messages (org_id, ticket_id, author, channel, body)
  values (t.org_id, t.id, 'reporter', t.channel::text,
          format('Priority corrected by the reporter: %s → %s.', t.urgency, p_urgency));

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (t.org_id, auth.uid(), 'ticket.urgency_corrected_by_reporter', 'ticket', t.id,
          jsonb_build_object('urgency', t.urgency, 'source', t.urgency_source),
          jsonb_build_object('urgency', p_urgency, 'source', 'reporter'));

  return true;
end;
$$;

revoke all on function apply_reporter_urgency(uuid, text) from public;

-- ── 2. Four new functions were anonymous-callable ─────────────────────────
--
-- ⚠️ `verify-function-grants`: "4 over-granted: create_service_charge_payment_intent
-- → anon, my_payment_history → anon, my_service_charges → anon,
-- set_my_ticket_urgency → anon".
--
-- This is the trap 0114 and 0115 were written for, arriving on schedule. The
-- Supabase project carries `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON
-- FUNCTIONS TO anon, authenticated, service_role`, so every new function is
-- born with an EXPLICIT grant to `anon` — and `revoke all ... from public`,
-- which each of 0123 and 0124 dutifully wrote, does not touch an explicit
-- per-role grant. The revoke looks like it did the job and does not.
--
-- What that meant concretely, until this file: an anonymous caller could ask
-- `my_service_charges()` or `my_payment_history()` for their invoices — those
-- filter on `auth.uid()`, which is null for anon, so they return nothing and
-- are merely reachable — but `create_service_charge_payment_intent` is the
-- sharp one. Its standing check is skipped entirely when `auth.uid()` is null,
-- because that is how the scheduled jobs are trusted. An anonymous caller who
-- learned an invoice id could therefore have opened a checkout against it, and
-- the one-live-intent guard would then have locked the real payer out.
--
-- Named individually rather than swept, so this file records exactly which
-- functions were exposed and what each one was for.
revoke execute on function create_service_charge_payment_intent(uuid, payment_gateway) from anon;
revoke execute on function my_service_charges() from anon;
revoke execute on function my_payment_history() from anon;
revoke execute on function set_my_ticket_urgency(uuid, text) from anon;

-- 0125 replaced this one too, which re-ran the same default-privilege grant on
-- a function 0114 had already cleaned once. A `create or replace` re-grants;
-- that is the part worth remembering.
revoke execute on function create_rent_payment_intent(uuid, payment_gateway) from anon;

-- And the two rewritten in 0122. They were already granted to `authenticated`
-- before that file, so the grant is not new — but a replace re-applies the
-- default, and an anonymous caller of `notify_user` skips the org check for the
-- same reason as above.
revoke execute on function notify_user(uuid, text, text, text, text, text, uuid) from anon;
revoke execute on function notify_role(uuid, user_role[], text, text, text, text, text, uuid) from anon;
revoke execute on function record_collection(uuid, numeric, timestamptz) from anon, authenticated;
revoke execute on function apply_reporter_urgency(uuid, text) from anon, authenticated;
revoke execute on function set_ticket_urgency_by_reporter(uuid, uuid, text, text) from anon, authenticated;
