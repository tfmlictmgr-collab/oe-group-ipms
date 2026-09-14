-- Classifier failover, and the conversation memory the router never had.
--
-- Two separate gaps, fixed together because the second is what makes the
-- first worth having.
--
-- ── 1. Which model actually answered ──────────────────────────────────────
--
-- CLAUDE.md B3 specifies a Gemini fallback with "auto-failover", and until
-- now there was none: an Anthropic outage degraded every inbound message to
-- `requires_human_review = true` with category 'general'. That is a safe
-- failure and a silent one — nothing anywhere recorded WHY a day's tickets
-- were all unclassified, and no screen would show it.
--
-- The failover is application code (`lib/llm.ts`). This column is the part
-- that has to be in the database: without it, "are we quietly running on the
-- fallback?" is unanswerable, and a degraded classifier looks exactly like a
-- quiet week. Nullable because every ticket raised before this migration has
-- no honest answer, and backfilling a guess would be worse than a null.
alter table tickets add column if not exists classified_by text;

comment on column tickets.classified_by is
  'Which model produced this ticket''s classification: anthropic, gemini, or none (both providers unreachable, so the safe human-review fallback was used). Null for tickets raised before failover existed -- not backfilled, because a guess is worse than an absence.';

-- Answerable in one query, which is the entire point of the column.
create index if not exists tickets_classified_by_idx
  on tickets (org_id, classified_by, created_at desc)
  where classified_by is not null;

-- ── 2. The conversation the router could not see ──────────────────────────
--
-- `conversation_context` (0075) hands the router `tickets.message_text` — the
-- ORIGINAL message that opened the ticket. But `ticket_messages` has held the
-- actual back-and-forth since that same migration: every reporter follow-up
-- appended by `append_reporter_message`, every staff reply. The router has
-- never seen any of it.
--
-- So the model was being asked "is this a follow-up?" while shown only the
-- first thing the person ever said. "It's worse now" had to be judged against
-- an opening line from three days ago, with the two exchanges in between
-- invisible. That is the whole reason a second message gets misread.
--
-- ⚠️ Deliberately a NEW function rather than extra columns on
-- `conversation_context`. Postgres refuses `create or replace` when a
-- table-returning function's row shape changes, so widening that one means
-- dropping and recreating a function that currently works — and this build
-- has already been bitten twice this week by rewriting a live function from a
-- stale migration file. A separate function touches nothing that works.
create or replace function conversation_transcript(
  p_ticket_id uuid,
  p_limit int default 8
)
returns table (
  author text,
  body text,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  -- Newest `p_limit` messages, handed back oldest-first so the model reads
  -- them in the order they were said. Bounded because a long-running thread
  -- would otherwise grow the prompt without bound, and the recent turns are
  -- what disambiguate a follow-up anyway.
  select author, body, created_at
    from (
      select author, body, created_at
        from ticket_messages
       where ticket_id = p_ticket_id
       order by created_at desc
       limit greatest(1, least(coalesce(p_limit, 8), 20))
    ) recent
   order by created_at asc;
$$;

-- service_role only, exactly like conversation_context: this is called by the
-- webhook handler on behalf of someone who is not signed in, and it is
-- SECURITY DEFINER, so it must not be reachable by a client session that
-- could pass an arbitrary ticket id.
revoke all on function conversation_transcript(uuid, int) from public;
grant execute on function conversation_transcript(uuid, int) to service_role;

comment on function conversation_transcript is
  'The recent back-and-forth on a ticket, oldest-first and bounded, for the inbound router to read a reply IN CONTEXT rather than against the opening message alone. service_role only -- SECURITY DEFINER over a caller-supplied ticket id, so it must never be reachable from a client session.';
