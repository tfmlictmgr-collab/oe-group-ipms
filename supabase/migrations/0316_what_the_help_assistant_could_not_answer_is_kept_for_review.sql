-- 📌 8 Oct 2026. The role help assistant learns from people, not from itself.
--
-- The assistant (PR #87) answers from each role's own guide. Its misses were
-- invisible: "how do I onboard a landlord" returned the wrong chapter and the
-- only record was the person's memory of having been disappointed. Asked for:
-- a way for it to improve as it is used.
--
-- ⚠️ What this deliberately is NOT: the model rewriting its own answers. On a
-- system that moves money and lets homes, a wrong "learned" answer is worse than
-- a slow correct one, and nobody could say where it had come from. What is safe
-- is a loop with a person in it — the question is kept, an administrator reads
-- the ones that failed, and the GUIDE or the assistant's vocabulary is fixed, so
-- the improvement is written down, reviewable and the same for everyone.
--
-- What is kept, and what is not:
--   • The question (trimmed to 400 characters, with e-mail addresses and long
--     digit runs masked — a person typing a phone number into a help box must
--     not leave it in a table), the ROLE, which sections answered, how it was
--     answered, and an optional thumbs up/down.
--   • NO user id. The review is about what the guide is missing, never about who
--     asked, and it means a purge of test accounts (scripts/purge-test-records)
--     has nothing here to trip over.
--   • Deleted after 90 days (`purge_help_bot_feedback`, daily job).
--
-- Reads: an administrator of the SAME organisation, nobody else — the policy and
-- the function both say so. Writes: only through `log_help_question` and
-- `rate_help_answer`, so the organisation and role are taken from the session
-- and never from the caller (the 0216 shape: a client that names its own org).
--
-- Grants are stated in full and then ASSERTED at the bottom. `revoke … from
-- public, anon` is not the list (0204/0209/0210/0264/0281: the role left
-- standing is `authenticated`, and after 0281 `service_role` too).

create table if not exists help_bot_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  role text not null,
  question text not null check (char_length(question) between 1 and 400),
  outcome text not null check (outcome in ('model', 'guide', 'referral')),
  sections text[] not null default '{}',
  rating smallint check (rating in (-1, 1)),
  created_at timestamptz not null default now()
);

create index if not exists help_bot_feedback_org_created
  on help_bot_feedback (org_id, created_at desc);

alter table help_bot_feedback enable row level security;

revoke all on table help_bot_feedback from public, anon, authenticated;
grant select on table help_bot_feedback to authenticated;

drop policy if exists help_bot_feedback_select on help_bot_feedback;
create policy help_bot_feedback_select on help_bot_feedback
  for select to authenticated
  using (org_id = current_user_org_id() and current_user_role() = 'admin');

-- ── Writing ──────────────────────────────────────────────────────────────────

create or replace function log_help_question(
  p_question text,
  p_outcome text,
  p_sections text[]
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_q text;
begin
  -- Not a signed-in, still-active person: nothing is recorded, and nothing says so.
  if active_uid() is null or current_user_org_id() is null then
    return null;
  end if;

  v_q := left(btrim(coalesce(p_question, '')), 400);
  v_q := regexp_replace(v_q, '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '[email]', 'g');
  v_q := regexp_replace(v_q, '[0-9][0-9 ()+-]{5,}[0-9]', '[number]', 'g');
  if v_q = '' then return null; end if;

  insert into help_bot_feedback (org_id, role, question, outcome, sections)
  values (
    current_user_org_id(),
    current_user_role()::text,
    v_q,
    case when p_outcome in ('model', 'guide', 'referral') then p_outcome else 'guide' end,
    coalesce((select array_agg(left(s, 120)) from (select s from unnest(p_sections) s limit 4) t), '{}')
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- One rating per answer, by whoever holds the (unguessable) id, within a day.
create or replace function rate_help_answer(p_id uuid, p_rating smallint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if active_uid() is null or p_rating not in (-1, 1) then return; end if;
  update help_bot_feedback
     set rating = p_rating
   where id = p_id
     and org_id = current_user_org_id()
     and rating is null
     and created_at > now() - interval '1 day';
end;
$$;

-- ── Reading: what failed, most-asked first ───────────────────────────────────
-- A non-administrator receives an EMPTY SET, not a refusal (decision 12: a
-- refusal confirms there is something worth refusing).
create or replace function help_bot_gaps(p_days integer default 30)
returns table (
  question text,
  role text,
  asked bigint,
  thumbs_down bigint,
  no_answer bigint,
  last_asked timestamptz
)
language sql stable security definer set search_path = public
as $$
  select lower(f.question) as question,
         f.role,
         count(*) as asked,
         count(*) filter (where f.rating = -1) as thumbs_down,
         count(*) filter (where f.outcome = 'referral') as no_answer,
         max(f.created_at) as last_asked
    from help_bot_feedback f
   where active_uid() is not null
     and current_user_role() = 'admin'
     and f.org_id = current_user_org_id()
     and f.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
   group by lower(f.question), f.role
  having count(*) filter (where f.rating = -1) > 0
      or count(*) filter (where f.outcome = 'referral') > 0
   order by count(*) desc, max(f.created_at) desc
   limit 100;
$$;

create or replace function purge_help_bot_feedback(p_days integer default 90)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  delete from help_bot_feedback where created_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ── Grants, stated in full ───────────────────────────────────────────────────
revoke all on function log_help_question(text, text, text[]) from public, anon, authenticated, service_role;
revoke all on function rate_help_answer(uuid, smallint) from public, anon, authenticated, service_role;
revoke all on function help_bot_gaps(integer) from public, anon, authenticated, service_role;
revoke all on function purge_help_bot_feedback(integer) from public, anon, authenticated, service_role;

grant execute on function log_help_question(text, text, text[]) to authenticated;
grant execute on function rate_help_answer(uuid, smallint) to authenticated;
grant execute on function help_bot_gaps(integer) to authenticated;
grant execute on function purge_help_bot_feedback(integer) to service_role;

-- ── Assertions: a wrong revoke fails the migration instead of shipping ──────
do $$
declare
  bad text;
begin
  select string_agg(routine_name || '→' || grantee, ', ') into bad
    from information_schema.routine_privileges
   where routine_schema = 'public'
     and routine_name in ('log_help_question', 'rate_help_answer', 'help_bot_gaps', 'purge_help_bot_feedback')
     and (
       grantee in ('PUBLIC', 'anon')
       or (grantee = 'authenticated' and routine_name = 'purge_help_bot_feedback')
       or (grantee = 'service_role' and routine_name <> 'purge_help_bot_feedback')
     );
  if bad is not null then
    raise exception 'help-bot functions over-granted: %', bad;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_name = 'help_bot_feedback' and table_schema = 'public'
       and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'help_bot_feedback is readable by anon';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_name = 'help_bot_feedback' and table_schema = 'public'
       and grantee = 'authenticated' and privilege_type <> 'SELECT'
  ) then
    raise exception 'authenticated may write help_bot_feedback directly; it must go through the functions';
  end if;
end $$;
