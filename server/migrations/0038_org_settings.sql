-- 0038: each org's own value for the settings that are its to choose (default templates, preview
-- passwords, the watermark, the artifact theme, share links, previews per person). An org with no
-- row follows the server's value. The home org never has rows: its settings are the server's, in
-- the settings table, as before orgs existed, so nothing is copied here.
CREATE TABLE org_settings (
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, key)
);

-- settings.read/write stay home-only. These two let any org's roles see and change that org's own
-- settings; granted as a default to roles that hold the server-wide ones. The owner re-maps them.
INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('settings.org_read', 'settings', 'See this org''s own settings: default templates, preview passwords, the watermark'),
  ('settings.org_write', 'settings', 'Change this org''s own settings: default templates, preview passwords, the watermark');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'settings.org_read' FROM role_permissions
  WHERE permission_id = 'settings.read';
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'settings.org_write' FROM role_permissions
  WHERE permission_id = 'settings.write';
