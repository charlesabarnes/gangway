-- 0016: agents trusted with artifacts but not containers (ADR-0030).
--
-- previews.credential: the API token or OAuth grant that created the preview (`oauth:<grant>`,
--   the token id), NULL for a signed-in person, a system job, a PR or a workflow, and for rows
--   from before this migration. A credential without previews.read -- the `artifacts` scope --
--   counts only these rows as its own, not everything its person deployed.
--
-- New permissions:
--   previews.read_own       list and see your own previews and their logs
--   previews.deploy_static  deploy what gangway serves itself; previews.deploy still covers it
--   previews.destroy_own    destroy your own previews; the `deploy` scope now carries this
--                           instead of previews.destroy
--
-- Minting is strict (ADR-0010): a role must cover a scope's whole bundle. So every role that can
-- deploy today gets deploy_static and destroy_own, and every role that can read gets read_own,
-- or its members could no longer mint a deploy token. Defaults, like any grant.

ALTER TABLE previews ADD COLUMN credential TEXT;

INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('previews.read_own', 'previews', 'List and see previews you deployed, and their logs'),
  ('previews.deploy_static', 'previews', 'Deploy artifacts and static sites that gangway serves itself, with no container'),
  ('previews.destroy_own', 'previews', 'Destroy previews you deployed');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.deploy_static' FROM role_permissions WHERE permission_id = 'previews.deploy';
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.destroy_own' FROM role_permissions WHERE permission_id = 'previews.deploy';
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.read_own' FROM role_permissions WHERE permission_id = 'previews.read';
