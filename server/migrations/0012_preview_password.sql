-- 0012: password-protected previews (ADR-0023).
--
-- previews.password_mode:
--   inherit    follow the server-wide default (Settings -> Preview passwords) at request time
--   none       open, whatever the default says
--   set        its own password, chosen by a person
--   generated  its own password, made by gangway and printed once, in the preview's log
-- password_hash / password_salt: scrypt, as auth/password.ts writes them; NULL unless the
-- mode is `set` or `generated`. The plain text is never stored.
-- previews.password_login: does being signed in to gangway (with `previews.skip_password`)
--   let you past the password? `inherit` follows the server-wide switch; `on` / `off` decide
--   for this preview -- a password for everyone (sharing) or only for strangers (personal).
-- Rows from before this migration inherit, which with no default configured means open:
-- nothing that serves today stops serving.

ALTER TABLE previews ADD COLUMN password_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (password_mode IN ('inherit','none','set','generated'));
ALTER TABLE previews ADD COLUMN password_hash TEXT;
ALTER TABLE previews ADD COLUMN password_salt TEXT;
ALTER TABLE previews ADD COLUMN password_login TEXT NOT NULL DEFAULT 'inherit'
  CHECK (password_login IN ('inherit','on','off'));

-- Open a password-protected preview by being signed in. A default like any grant: every
-- role that can see previews gets it, and the owner may take it away from a role.
INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('previews.skip_password', 'previews', 'Open password-protected previews by being signed in, without the password');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.skip_password' FROM role_permissions WHERE permission_id = 'previews.read';
