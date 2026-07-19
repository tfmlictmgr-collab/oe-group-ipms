-- Enable Postgres realtime for tickets so the portal receives INSERT/UPDATE
-- events live (Day 6). RLS still governs which rows each subscriber sees.
alter publication supabase_realtime add table tickets;
