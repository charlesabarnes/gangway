-- previews.extend: push back when a preview's TTL tears it down, or make it never expire.
--
-- Granted as a default to roles that can rebuild a preview, since keeping one around is the same
-- kind of change; the owner re-maps it from there.

INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('previews.extend', 'previews', 'Extend how long a preview you may change lives, or keep it forever');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.extend' FROM role_permissions
  WHERE permission_id IN ('previews.update', 'previews.update_own');
