-- 0019: secrets on a preview, and where an agent's credential may set them (ADR-0034).
--
-- previews.env_ciphertext: the preview's own secrets, one sealed JSON map like
--   projects.env_ciphertext. Merged over the org's and the project's, and not subject to the
--   preview's clearance: someone set them for this preview on purpose.
-- api_tokens.secret_targets, oauth_grants.secret_targets: JSON
--   {previews: "own"|"all", projects: "all"|[project ids], org: boolean}, or NULL for no
--   narrowing. Only a credential with the `secrets` scope has one.
--
-- New permission previews.secrets: set secrets on previews you may rebuild. Values are never
-- shown. Granted to every role that can deploy, as a default.

ALTER TABLE previews ADD COLUMN env_ciphertext TEXT;
ALTER TABLE api_tokens ADD COLUMN secret_targets TEXT CHECK (secret_targets IS NULL OR json_valid(secret_targets));
ALTER TABLE oauth_grants ADD COLUMN secret_targets TEXT CHECK (secret_targets IS NULL OR json_valid(secret_targets));

INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('previews.secrets', 'previews', 'Set secrets on previews you may rebuild (values are never shown)');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.secrets' FROM role_permissions WHERE permission_id = 'previews.deploy';
