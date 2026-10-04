-- 0029: organisations. Every existing row belongs to the one home org this creates; later
-- migrations give tables an org_id. The home org alone may hold instance-wide permissions, and
-- its previews never take an org suffix, so a single-org install keeps every URL it had.
CREATE TABLE orgs (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE
             CHECK (length(slug) BETWEEN 1 AND 32 AND slug NOT GLOB '*[^a-z0-9]*'),
  name       TEXT NOT NULL,
  home       INTEGER NOT NULL DEFAULT 0 CHECK (home IN (0,1)),
  state      TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX orgs_one_home ON orgs(home) WHERE home = 1;

INSERT INTO orgs (id, slug, name, home, created_at, updated_at) VALUES
  ('00000000000000000000000000', 'default', 'Default', 1,
   CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- What an org may use. No row, or a key left out, means no limit: a self-hosted org has none.
CREATE TABLE org_limits (
  org_id      TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  plan_label  TEXT,
  limits_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(limits_json)),
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);
