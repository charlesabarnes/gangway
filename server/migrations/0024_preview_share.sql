-- previews.share: give a preview a public link through a Cloudflare quick tunnel (ADR-0038).
-- Shares themselves live in memory, so there is no table: a restart ends them.
--
-- Granted as a default to roles that can choose a preview's domain, which is the nearest thing
-- it replaces on an install with no public domain; the owner re-maps it from there.

INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('previews.share', 'previews', 'Give a preview a public link through a Cloudflare quick tunnel, and end it');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.share' FROM role_permissions
  WHERE permission_id = 'previews.domain';
