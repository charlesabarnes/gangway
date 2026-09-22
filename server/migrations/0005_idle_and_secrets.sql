-- 0005: real stacks (ADR-0012).
--
-- previews.idle_after_ms: how long without a request before the whole project is stopped.
--   NULL = the server default (settings defaults.idleAfter); 0 = never. Set from
--   `x-gangway.idle` at deploy time, so a stack's own choice survives a settings change.
--
-- repos.env_ciphertext: the repository's secrets as ONE encrypted JSON map (AES-256-GCM,
--   key in the state directory). Written to `<checkout>/.env` at deploy time, never read
--   back through the API, never given to a pull request from a fork.

ALTER TABLE previews ADD COLUMN idle_after_ms INTEGER;
ALTER TABLE repos ADD COLUMN env_ciphertext TEXT;
