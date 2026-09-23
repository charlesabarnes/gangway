-- 0009: OAuth grants (ADR-0020). The FOURTH recorded exception to ADR-0005's "no new
-- tables": the six-phase schema had no place for an OAuth 2.1 authorization server,
-- because spec §15.1 left MCP's OAuth an open question until the owner chose it.
--
-- One row per consent: a user let one client (a Client ID Metadata Document URL, e.g.
-- claude.ai's) act as them, with these scopes, against this resource (the MCP URL). The
-- row carries the CURRENT access token and refresh token, as sha256 hashes: there is one
-- live access token per grant, and a refresh rotates both. `prev_refresh_hash` is the
-- refresh token that was just rotated away; presenting it again is replay, and revokes
-- the grant (OAuth 2.1 §4.3.1).
--
-- Authorization codes and pending consent requests are NOT here: they live 60 s and 10
-- min, in memory. A restart only means authorizing again.
CREATE TABLE oauth_grants (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id           TEXT NOT NULL,
  client_name         TEXT NOT NULL,
  redirect_uri        TEXT NOT NULL,
  scopes              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  resource            TEXT NOT NULL,
  access_hash         TEXT NOT NULL UNIQUE,
  access_expires_at   INTEGER NOT NULL,
  refresh_hash        TEXT NOT NULL UNIQUE,
  prev_refresh_hash   TEXT,
  refresh_expires_at  INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER,
  revoked_at          INTEGER
);
CREATE INDEX oauth_grants_user_idx ON oauth_grants(user_id);
CREATE INDEX oauth_grants_prev_refresh_idx ON oauth_grants(prev_refresh_hash);
