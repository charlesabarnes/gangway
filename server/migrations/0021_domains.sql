-- 0021: more than one preview domain, and custom domains claimed per level (ADR-0036).
--
-- domains: a name gangway answers for beyond the ones pinned in its environment.
--   kind 'wildcard': previews are named `<label>.<name>`. At the org (project_id and preview_id
--     NULL) any project or preview may choose it; claimed by a project, only that project's.
--   kind 'exact': one hostname that answers for one preview. Claimed by a preview, it is that
--     preview; claimed by a project, it follows projects.production_preview_id.
--   status: 'pending' until `_acme-challenge.<name>` is a CNAME to `<claim_id>.acme.<control>`
--     (proof of control, and where gangway answers the certificate challenge), then 'active';
--     'failed' when that never happened in time. routing_ok: the name resolves to this server.
-- projects.domain, previews.domain: the wildcard domain chosen; NULL = follow the project, then
--   the setting previewDomain. Takes effect on the next deploy.
-- projects.production_preview_id: the preview a project's exact hostnames answer for.
--
-- New permissions, granted as defaults so nothing changes until the owner re-maps them:
--   previews.domain (choose a preview's domain, claim hostnames for it) to roles that can change
--   a preview; repos.domains (the same for a repository) to roles that can tune one;
--   domains.manage (the server's own domains) to roles that can change settings.

CREATE TABLE domains (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('wildcard','exact')),
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  preview_id    TEXT REFERENCES previews(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','failed')),
  claim_id      TEXT NOT NULL UNIQUE,
  routing_ok    INTEGER NOT NULL DEFAULT 0 CHECK (routing_ok IN (0,1)),
  last_error    TEXT,
  checked_at    INTEGER,
  verified_at   INTEGER,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (project_id IS NULL OR preview_id IS NULL),
  CHECK (kind = 'exact' OR preview_id IS NULL)
);
CREATE INDEX domains_project_idx ON domains(project_id);
CREATE INDEX domains_preview_idx ON domains(preview_id);

ALTER TABLE projects ADD COLUMN domain TEXT;
ALTER TABLE previews ADD COLUMN domain TEXT;
ALTER TABLE projects ADD COLUMN production_preview_id TEXT REFERENCES previews(id) ON DELETE SET NULL;

INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('previews.domain', 'previews', 'Choose the domain of a preview you may change, and claim hostnames for it'),
  ('repos.domains', 'repos', 'Choose a repository''s domain, claim domains for it and pick its production preview'),
  ('domains.manage', 'settings', 'Add and remove the server''s preview domains');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.domain' FROM role_permissions
  WHERE permission_id IN ('previews.update', 'previews.update_own');
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'repos.domains' FROM role_permissions
  WHERE permission_id = 'repos.manage' OR role_id = 'admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'domains.manage' FROM role_permissions WHERE permission_id = 'settings.write';
