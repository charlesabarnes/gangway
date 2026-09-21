-- 0003: roles and per-feature permissions (ADR-0009).
--
-- ADR-0005 said later phases add columns, not tables: its premise was a table set fixed by
-- the design document. Editable, per-feature permissions are a requirement the document
-- never had, so this is the recorded exception.
--
-- A PERMISSION is the unit of enforcement; a ROLE is a named set of them, and the set is
-- the operator's data. The catalogue itself is code (shared/src/permissions.ts): this file
-- seeds it as it stood at 0003 and is then frozen by its checksum. Later permissions
-- arrive through the boot-time catalogue sync, never by editing this file.
--
-- Builtin role ids are their names, so `/v1/roles/member` reads as what it is. `admin`
-- is granted everything here for the benefit of anyone querying the table, but the server
-- never consults these rows for it: admin holds every permission in code, so no edit to
-- this matrix can lock the operator out.

CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  builtin     INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  created_at  INTEGER NOT NULL
);

CREATE TABLE permissions (
  id          TEXT PRIMARY KEY,
  feature     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
CREATE INDEX permissions_feature_idx ON permissions(feature);

CREATE TABLE role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
) WITHOUT ROWID;
CREATE INDEX role_permissions_permission_idx ON role_permissions(permission_id);

INSERT INTO roles (id, name, description, builtin, created_at) VALUES
  ('admin',  'admin',  'Everything: users, roles, hosts, settings, tokens, deploys. Cannot be edited.', 1, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('member', 'member', 'Deploy, view and destroy previews; manage own tokens.',                         1, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('viewer', 'viewer', 'View previews and logs. No mutations.',                                         1, CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT INTO permissions (id, feature, description) VALUES
  ('previews.read',         'previews',  'List previews and see their detail, URLs and builds'),
  ('previews.deploy',       'previews',  'Deploy a new preview'),
  ('previews.destroy',      'previews',  'Destroy any preview'),
  ('previews.view_private', 'previews',  'Open previews whose visibility is private'),
  ('logs.read',             'logs',      'Read and follow preview build and runtime logs'),
  ('events.read',           'events',    'Follow the global state stream'),
  ('hosts.read',            'hosts',     'See registered Docker hosts and their state'),
  ('hosts.manage',          'hosts',     'Register, edit and remove Docker hosts'),
  ('tokens.manage_own',     'tokens',    'Create and revoke your own API tokens'),
  ('tokens.manage_all',     'tokens',    'See and revoke every user''s API tokens'),
  ('users.read',            'users',     'See accounts and their roles'),
  ('users.manage',          'users',     'Create, disable and re-role accounts; reset passwords'),
  ('roles.read',            'roles',     'See roles and the permissions each one grants'),
  ('roles.manage',          'roles',     'Change which permissions a role grants'),
  ('audit.read',            'audit',     'Read the audit log'),
  ('settings.read',         'settings',  'See server settings'),
  ('settings.write',        'settings',  'Change server settings'),
  ('surfaces.manage',       'settings',  'Enable and disable the UI and MCP surfaces'),
  ('github.manage',         'github',    'Connect and configure the GitHub App'),
  ('apps.read',             'apps',      'See the system app catalog and what is installed'),
  ('apps.install',          'apps',      'Install and uninstall system apps'),
  ('jobs.claim',            'jobs',      'Create and claim ephemeral jobs');

INSERT INTO role_permissions (role_id, permission_id) SELECT 'admin', id FROM permissions;

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('member', 'previews.read'),
  ('member', 'logs.read'),
  ('member', 'events.read'),
  ('member', 'hosts.read'),
  ('member', 'previews.deploy'),
  ('member', 'previews.destroy'),
  ('member', 'previews.view_private'),
  ('member', 'tokens.manage_own');

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('viewer', 'previews.read'),
  ('viewer', 'logs.read'),
  ('viewer', 'events.read'),
  ('viewer', 'hosts.read'),
  ('viewer', 'previews.view_private');

-- users.role was a CHECK-constrained name; it becomes a reference. SQLite cannot drop a
-- column that a CHECK mentions, so the table is rebuilt (the runner has foreign_keys OFF
-- and verifies foreign_key_check afterwards). sessions and api_tokens reference `users`
-- by name and follow the rename untouched. RESTRICT: a role that still has users cannot
-- be deleted out from under them.
CREATE TABLE users_new (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at    INTEGER NOT NULL
);
INSERT INTO users_new (id, email, password_hash, password_salt, role_id, disabled, created_at)
  SELECT id, email, password_hash, password_salt, role, disabled, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX users_role_idx ON users(role_id);
