-- No-code org branding, part 2: logo image + editable portal copy.
--
-- Extends 0013 (colours + monogram) so an org admin can fully brand their portal
-- without a code change: upload a logo, rename the portal, set a tagline and
-- support contacts, and change the login headline.

alter table orgs add column if not exists logo_url        text;
alter table orgs add column if not exists portal_name     text;
alter table orgs add column if not exists tagline         text;
alter table orgs add column if not exists support_email   text;
alter table orgs add column if not exists support_phone   text;
alter table orgs add column if not exists login_headline  text;

-- ── Logo storage ───────────────────────────────────────────────────────────
-- Public bucket: logos render in the sidebar/login for signed-out and
-- cross-origin contexts, so they are not secret. Writes are still restricted to
-- the owning org's admins by the policies below.
insert into storage.buckets (id, name, public)
values ('org-logos', 'org-logos', true)
on conflict (id) do nothing;

-- Objects are namespaced by org: '<org_id>/<filename>'. The first path segment
-- must equal the caller's org, so one org can never write into another's prefix.
drop policy if exists "org logos are publicly readable" on storage.objects;
create policy "org logos are publicly readable" on storage.objects
  for select using (bucket_id = 'org-logos');

drop policy if exists "org admins upload own logo" on storage.objects;
create policy "org admins upload own logo" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'org-logos'
    and current_user_role() = 'admin'
    and (storage.foldername(name))[1] = current_user_org_id()::text
  );

drop policy if exists "org admins update own logo" on storage.objects;
create policy "org admins update own logo" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'org-logos'
    and current_user_role() = 'admin'
    and (storage.foldername(name))[1] = current_user_org_id()::text
  );

drop policy if exists "org admins delete own logo" on storage.objects;
create policy "org admins delete own logo" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'org-logos'
    and current_user_role() = 'admin'
    and (storage.foldername(name))[1] = current_user_org_id()::text
  );
