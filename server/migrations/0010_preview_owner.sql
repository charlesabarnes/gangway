-- 0010: who deployed a preview, and rebuilding your own (ADR-0021).
--
-- previews.owner: the principal that created the preview -- `user:<id>` when a person is
--   behind the credential (a session, an API token or an OAuth grant of theirs), else the
--   token id (the env token, a system job). NULL on rows from before this migration and on
--   PR / workflow previews: nobody "owns" those, so `previews.update_own` never reaches them.
--
-- previews.update_own is a new permission: rebuild a preview you deployed. It joins the
-- `deploy` scope bundle, and minting is strict (ADR-0010) -- a role must cover a scope's
-- whole bundle to mint it. So every role that can deploy today is granted it here, or its
-- members could no longer mint a deploy token. A default, like any grant: the owner may
-- take it away again (and that role then mints read tokens only).

ALTER TABLE previews ADD COLUMN owner TEXT;

INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('previews.update_own', 'previews', 'Rebuild previews you deployed, at the same URL');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.update_own' FROM role_permissions WHERE permission_id = 'previews.deploy';
