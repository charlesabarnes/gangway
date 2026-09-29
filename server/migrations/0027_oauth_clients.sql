-- 0027: OAuth clients that registered themselves (RFC 7591 dynamic client registration).
--
-- MCP clients that cannot publish a Client ID Metadata Document (many desktop and terminal
-- agents) register at /oauth/register instead and get a `gwc_` client_id. They are public
-- clients only: no secret is issued, and PKCE is still required at /oauth/authorize. Their name
-- is self-asserted, so the consent page marks them unverified.
--
-- A registration nobody ever authorized with is dropped after a day, so the open endpoint
-- cannot fill the table.
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris)),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX oauth_clients_created_idx ON oauth_clients(created_at);
