-- 0033: each org gets its own builtin roles and default template, copied when the org is made.
-- A role's kind says which builtin it is (admin, member, viewer); admin is known by its kind, so
-- every org's admin role holds everything. Role names are unique within an org, not the server.
CREATE TABLE roles_next (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  builtin     INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  kind        TEXT CHECK (kind IN ('admin','member','viewer')),
  created_at  INTEGER NOT NULL,
  UNIQUE (org_id, name),
  UNIQUE (org_id, kind)
);
INSERT INTO roles_next (id, org_id, name, description, builtin, kind, created_at)
  SELECT id, org_id, name, description, builtin,
         CASE WHEN builtin = 1 AND id IN ('admin','member','viewer') THEN id END, created_at
    FROM roles;
DROP TABLE roles;
ALTER TABLE roles_next RENAME TO roles;

-- One builtin template per org: its default.
CREATE UNIQUE INDEX templates_one_builtin ON templates(org_id) WHERE builtin = 1;
