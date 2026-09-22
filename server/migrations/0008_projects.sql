-- 0008: projects (ADR-0014).
--
-- A PROJECT is the thing you preview: a name, a hostname stem, where its code comes from
-- (a GitHub repository, or none for images and tarballs), the template it follows with
-- overrides on top, its own secrets, and its previews. It replaces `repos`, which stood in
-- for it without a name and was created by the first webhook. A project is made on
-- purpose now; a pull request from a repository that is no project's is ignored.
--
-- `pr_trigger`: how pull requests reach it -- `workflow` (a GitHub Actions workflow in the
-- repository builds the image and calls gangway with an OIDC token) or `webhook` (the
-- GitHub App; tower clones and builds). Never both: that would be two previews per PR.
-- The repository migrated from 0004 keeps `webhook`, which is how it works today.
--
-- Not `apps`: that word is the system app catalog's (spec §12). Not to be confused with a
-- preview's `project` column, which is its compose project name.

CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  forge           TEXT CHECK (forge IS NULL OR forge IN ('github')),
  full_name       TEXT,
  installation_id TEXT NOT NULL DEFAULT '',
  pr_trigger      TEXT NOT NULL DEFAULT 'workflow' CHECK (pr_trigger IN ('workflow','webhook')),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  disabled_reason TEXT,
  template_id     TEXT REFERENCES templates(id) ON DELETE SET NULL,
  visibility      TEXT CHECK (visibility IS NULL OR visibility IN ('public','unlisted','private')),
  ttl             TEXT,
  pr_clearance    TEXT CHECK (pr_clearance IS NULL OR pr_clearance IN ('none','low','standard','high')),
  forks           TEXT NOT NULL DEFAULT 'ask' CHECK (forks IN ('ask','auto','never')),
  drafts          INTEGER NOT NULL DEFAULT 0 CHECK (drafts IN (0,1)),
  fork_clearance  TEXT NOT NULL DEFAULT 'none' CHECK (fork_clearance IN ('none','low','standard','high')),
  env_ciphertext  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK ((forge IS NULL) = (full_name IS NULL)),
  UNIQUE (forge, full_name)
);

INSERT INTO projects (id, name, slug, forge, full_name, installation_id, pr_trigger, enabled, disabled_reason, template_id,
                      visibility, ttl, pr_clearance, forks, drafts, fork_clearance, env_ciphertext, created_at, updated_at)
  SELECT id, substr(full_name, instr(full_name, '/') + 1), slug, forge, full_name, installation_id, 'webhook', enabled, disabled_reason, template_id,
         visibility, ttl, pr_clearance, forks, drafts, fork_clearance, env_ciphertext, created_at, updated_at
  FROM repos;
DROP TABLE repos;

-- Which project a preview belongs to; NULL for one deployed outside any. A deleted project
-- leaves its previews running and unowned.
ALTER TABLE previews ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
UPDATE previews SET project_id = (SELECT p.id FROM projects p WHERE p.full_name = json_extract(previews.source_json, '$.repo'))
  WHERE source_kind = 'pr';
CREATE INDEX previews_project_idx ON previews(project_id);
