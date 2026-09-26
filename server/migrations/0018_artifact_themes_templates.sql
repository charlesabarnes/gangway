-- 0018: themes and templates for artifacts, made by the people who run gangway (ADR-0033).
--
-- artifact_themes: a theme is the kit's tokens for light and dark, three font choices, a title
--   style and an optional logo. gangway's own theme, "chart", is not a row: it is the kit as
--   shipped. The setting artifacts.theme names the default.
-- artifact_templates: a starter artifact of one kind, its files as a JSON object of path to
--   text. The built-in templates live in code; these sit beside them in the catalog. Ids are
--   "<kind>/<slug>" like the built-ins', and may not take a built-in's.
--
-- A fourth table beyond ADR-0005's one-per-concept rule, like `templates` before it: a theme and
-- a template are things people make, name, edit and delete, not settings.
--
-- New permission artifacts.manage: create, edit and delete themes and templates. Granted to the
-- roles that manage preview policies today.

CREATE TABLE artifact_themes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tokens_json TEXT NOT NULL CHECK (json_valid(tokens_json)),
  fonts_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fonts_json)),
  logo_svg    TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE artifact_templates (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('document','deck','canvas')),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  theme_id    TEXT REFERENCES artifact_themes(id) ON DELETE SET NULL,
  files_json  TEXT NOT NULL CHECK (json_valid(files_json)),
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('artifacts.manage', 'artifacts', 'Create, edit and delete artifact themes and templates');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'artifacts.manage' FROM role_permissions WHERE permission_id = 'templates.manage';
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES ('admin', 'artifacts.manage');
