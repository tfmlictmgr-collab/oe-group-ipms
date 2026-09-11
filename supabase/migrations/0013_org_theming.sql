-- Per-org theming. An org admin can override the brand colours and monogram
-- for their own org; NULL columns fall back to the delivery_brand defaults
-- (lib/brands.ts). Kept as plain columns on orgs — one row per org, read on
-- every dashboard load.

alter table orgs add column if not exists theme_primary   text;
alter table orgs add column if not exists theme_accent    text;
alter table orgs add column if not exists theme_logo_text text;

-- Admins may update their own org's row (name + theme). RLS already restricts
-- visibility to the caller's org; this adds the write path for the settings UI.
-- Column-level restriction isn't expressed in RLS, so the server action only
-- ever sets these theme columns + name.
drop policy if exists orgs_admin_update on orgs;
create policy orgs_admin_update on orgs for update
  using (id = current_user_org_id() and current_user_role() = 'admin')
  with check (id = current_user_org_id() and current_user_role() = 'admin');

-- Governance: theme/name changes are auditable.
drop trigger if exists audit_org_update on orgs;
create trigger audit_org_update
  after update on orgs
  for each row execute function log_audit('org.updated');
