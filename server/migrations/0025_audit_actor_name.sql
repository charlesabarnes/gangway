-- 0025: the name of the credential behind an audit entry (an agent's client name, an API token's
-- name), kept on the row so the log stays readable after the credential is revoked and purged.
ALTER TABLE audit ADD COLUMN actor_name TEXT;

UPDATE audit SET actor_name = (SELECT client_name FROM oauth_grants WHERE 'oauth:' || id = audit.actor_id)
 WHERE actor_type = 'token' AND actor_id LIKE 'oauth:%';
UPDATE audit SET actor_name = (SELECT name FROM api_tokens WHERE id = audit.actor_id)
 WHERE actor_type = 'token' AND actor_name IS NULL;
