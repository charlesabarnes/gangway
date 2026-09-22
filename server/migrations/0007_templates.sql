-- 0007: templates -- a named preview policy (ADR-0013).
--
-- The third recorded exception to ADR-0005's "columns, not tables". A template is what
-- the four `defaults.*` settings were, with a name: visibility, TTL, idle window,
-- clearance, and a placement. `default` is seeded from those settings (their values
-- survive; the keys are removed) and can never be deleted. A repository names its
-- template; three settings name one per trigger (pull request, API, manual).

CREATE TABLE templates (
  id          TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND length(id) <= 32),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  builtin     INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  visibility  TEXT NOT NULL CHECK (visibility IN ('public','unlisted','private')),
  -- NULL: never expires
  ttl         TEXT,
  -- a duration, or 'never'
  idle_after  TEXT NOT NULL DEFAULT '30m',
  clearance   TEXT NOT NULL DEFAULT 'standard' CHECK (clearance IN ('none','low','standard','high')),
  -- NULL: the scheduler places it
  host_id     TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

INSERT INTO templates (id, name, description, builtin, visibility, ttl, idle_after, clearance, host_id, created_at, updated_at)
VALUES (
  'default', 'Default', 'Every install starts with this one. Triggers use it until told otherwise.', 1,
  COALESCE((SELECT json_extract(value_json, '$') FROM settings WHERE key = 'defaults.visibility'), 'unlisted'),
  COALESCE((SELECT json_extract(value_json, '$') FROM settings WHERE key = 'defaults.ttl'), '7d'),
  COALESCE((SELECT json_extract(value_json, '$') FROM settings WHERE key = 'defaults.idleAfter'), '30m'),
  COALESCE((SELECT json_extract(value_json, '$') FROM settings WHERE key = 'secrets.defaultClearance'), 'standard'),
  NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
);
DELETE FROM settings WHERE key IN ('defaults.visibility', 'defaults.ttl', 'defaults.idleAfter', 'secrets.defaultClearance');

-- repos: `template_id` names the template; `pr_clearance` becomes an OVERRIDE (NULL = the
-- template's). SQLite cannot relax a NOT NULL, so the table is rebuilt (the runner turns
-- foreign_keys off around this and checks afterwards). Nothing references repos by key.
CREATE TABLE repos_new (
  id              TEXT PRIMARY KEY,
  forge           TEXT NOT NULL CHECK (forge IN ('github')),
  full_name       TEXT NOT NULL,
  installation_id TEXT NOT NULL DEFAULT '',
  slug            TEXT NOT NULL UNIQUE,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  disabled_reason TEXT,
  template_id     TEXT REFERENCES templates(id) ON DELETE SET NULL,
  -- overrides on top of the template; NULL means the template's value
  visibility      TEXT CHECK (visibility IS NULL OR visibility IN ('public','unlisted','private')),
  ttl             TEXT,
  pr_clearance    TEXT CHECK (pr_clearance IS NULL OR pr_clearance IN ('none','low','standard','high')),
  -- the trigger policy: a pull request's, not a preview's
  forks           TEXT NOT NULL DEFAULT 'ask' CHECK (forks IN ('ask','auto','never')),
  drafts          INTEGER NOT NULL DEFAULT 0 CHECK (drafts IN (0,1)),
  fork_clearance  TEXT NOT NULL DEFAULT 'none' CHECK (fork_clearance IN ('none','low','standard','high')),
  env_ciphertext  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (forge, full_name)
);
-- A repository that sat at the old column default ('standard') was never a deliberate
-- override: it follows its template from here on. Anything else was chosen and is kept.
INSERT INTO repos_new (id, forge, full_name, installation_id, slug, enabled, disabled_reason, template_id, visibility, ttl,
                       pr_clearance, forks, drafts, fork_clearance, env_ciphertext, created_at, updated_at)
  SELECT id, forge, full_name, installation_id, slug, enabled, disabled_reason, NULL, visibility, ttl,
         CASE WHEN pr_clearance = 'standard' THEN NULL ELSE pr_clearance END,
         forks, drafts, fork_clearance, env_ciphertext, created_at, updated_at
  FROM repos;
DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;

-- What a preview was deployed with, for its page. NULL on rows from before this migration.
ALTER TABLE previews ADD COLUMN template_id TEXT;
