-- The notification bell rings without a refresh.
--
-- `components/shell/notification-bell.tsx` subscribes to INSERTs on
-- `user_notifications` over Supabase Realtime, and has since the notification
-- centre shipped (0025). Realtime only streams tables that are members of the
-- `supabase_realtime` publication — and the ONLY table any migration ever added
-- to it is `tickets` (0002). So on a project built from the migrations alone,
-- the bell's subscription succeeds, reports SUBSCRIBED, and never receives a
-- single event: a new notification appears only when the page is reloaded.
--
-- Found 25 Sept 2026 on production, the first project built purely from the
-- migrations: a WhatsApp request arrived and nobody saw it until they refreshed.
-- Dev and staging behaved, because somebody had ticked the table in the
-- dashboard's Replication screen by hand — a setting no migration recorded,
-- which is exactly how a world drifts from the one it is meant to rehearse.
--
-- Adding a table to the publication grants nothing. Realtime evaluates the
-- subscriber's RLS on every row it streams, and `user_notifications` is readable
-- only by its own recipient (0025), so each person receives their own
-- notifications and no one else's.
--
-- Idempotent: `alter publication … add table` fails if the table is already a
-- member, which it will be on the worlds where it was ticked by hand.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'user_notifications'
  ) then
    execute 'alter publication supabase_realtime add table public.user_notifications';
  end if;

  -- 0002 added `tickets` unconditionally; re-assert it the same safe way so a
  -- world where it was removed by hand is put back rather than silently skipped.
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'tickets'
  ) then
    execute 'alter publication supabase_realtime add table public.tickets';
  end if;
end $$;
