-- 0001_init: the full six-phase table set (ADR-0005).
--
-- Later phases add COLUMNS and INDEXES, not tables. An unused table costs nothing; the
-- benefit is that the Phase 1 deploy path writes real audit rows from the first commit,
-- and Phase 5's lockout guard can query api_tokens with no schema change.
--
-- Conventions: ids are TEXT ULID, timestamps are INTEGER epoch milliseconds (always
-- < 2^53 so the default number mode is safe), structured fields are TEXT JSON guarded by
-- json_valid(). No STRICT tables and no generated columns -- bun:sqlite links the system
-- SQLite on macOS and a bundled one on Linux, so the floor is the older of the two.

-- ---------------------------------------------------------------- hosts
-- docker_host is how we TALK TO the daemon; upstream_* is how the proxy REACHES its
-- published ports. Conflating these is what makes multi-host a rewrite rather than a
-- config change (§3.2, §9).
CREATE TABLE hosts (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  docker_host      TEXT NOT NULL,
  expect_name      TEXT,
  capabilities     TEXT NOT NULL DEFAULT '["preview"]' CHECK (json_valid(capabilities)),
  publish_bind     TEXT NOT NULL DEFAULT '127.0.0.1',
  upstream_dial    TEXT NOT NULL DEFAULT 'direct' CHECK (upstream_dial IN ('direct','socks5')),
  upstream_address TEXT NOT NULL DEFAULT '127.0.0.1',
  upstream_proxy   TEXT,
  port_range_start INTEGER NOT NULL DEFAULT 31000,
  port_range_end   INTEGER NOT NULL DEFAULT 31499,
  state            TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (state IN ('unknown','ready','unreachable','error')),
  last_error       TEXT,
  last_seen_at     INTEGER,
  created_at       INTEGER NOT NULL,
  CHECK (port_range_end >= port_range_start)
);

-- ---------------------------------------------------------------- previews
-- kind='job' is a preview with no routes (§12.3). Encoding it now means Phase 6's
-- ephemeral job lifecycle reuses this whole pipeline instead of forking it.
CREATE TABLE previews (
  id             TEXT PRIMARY KEY,
  project        TEXT NOT NULL UNIQUE,
  host_id        TEXT NOT NULL REFERENCES hosts(id),
  kind           TEXT NOT NULL DEFAULT 'preview' CHECK (kind IN ('preview','job')),
  state          TEXT NOT NULL CHECK (state IN
                   ('building','starting','awake','asleep','failed','destroying','destroyed')),
  source_kind    TEXT NOT NULL CHECK (source_kind IN ('pr','manual','agent','image','tarball','git')),
  source_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_json)),
  visibility     TEXT NOT NULL DEFAULT 'unlisted'
                   CHECK (visibility IN ('public','unlisted','private')),
  ttl_expires_at INTEGER,
  -- written by the proxy on every request; Phase 4's idle-sleep sweeper reads it
  last_seen_at   INTEGER,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  destroyed_at   INTEGER
);
CREATE INDEX previews_state_idx ON previews(state);
CREATE INDEX previews_ttl_idx ON previews(ttl_expires_at) WHERE ttl_expires_at IS NOT NULL;
CREATE INDEX previews_host_idx ON previews(host_id);

-- ---------------------------------------------------------------- routes
-- hostname is the PRIMARY KEY: the proxy's lookup is a unique-key lookup, a hostname
-- collision is a constraint violation rather than a logic bug, and many-routes-per-preview
-- is the default shape -- which is what makes Phase 4 multi-service routing a loop.
CREATE TABLE routes (
  hostname       TEXT PRIMARY KEY,
  preview_id     TEXT NOT NULL REFERENCES previews(id) ON DELETE CASCADE,
  service        TEXT NOT NULL,
  container_port INTEGER NOT NULL,
  upstream_host  TEXT NOT NULL,
  -- allocated by us BEFORE the container starts (ADR-0004), so the row and the container
  -- label are both complete before `compose up` and §5's ordering rule holds literally
  upstream_port  INTEGER NOT NULL,
  is_primary     INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at     INTEGER NOT NULL
);
CREATE INDEX routes_preview_idx ON routes(preview_id);
-- One preview may not claim the same host port twice; nor may two previews on one host.
CREATE UNIQUE INDEX routes_upstream_idx ON routes(upstream_host, upstream_port);

-- ---------------------------------------------------------------- builds
CREATE TABLE builds (
  id          TEXT PRIMARY KEY,
  preview_id  TEXT NOT NULL REFERENCES previews(id) ON DELETE CASCADE,
  service     TEXT,
  state       TEXT NOT NULL CHECK (state IN ('running','succeeded','failed','cancelled')),
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  exit_code   INTEGER,
  log_path    TEXT
);
CREATE INDEX builds_preview_idx ON builds(preview_id);

-- ---------------------------------------------------------------- events
-- seq is the SSE Last-Event-ID cursor, so a reconnecting client replays exactly.
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_id   TEXT REFERENCES previews(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at   INTEGER NOT NULL
);
CREATE INDEX events_preview_idx ON events(preview_id, seq);

-- ---------------------------------------------------------------- settings
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- certificates
-- Certificate and ACME account key live here so "back up gangway" is "copy one file".
CREATE TABLE certificates (
  domain     TEXT PRIMARY KEY,
  cert_pem   TEXT NOT NULL,
  key_pem    TEXT NOT NULL,
  chain_pem  TEXT,
  issuer     TEXT,
  not_before INTEGER,
  not_after  INTEGER,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------- Phase 2+: created now, used later
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
  disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

-- prefix is stored in clear for display ("gw_abc…"); only the hash is authoritative
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  app_name     TEXT,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX api_tokens_hash_idx ON api_tokens(token_hash);

CREATE TABLE audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','token','app','system','github')),
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  old_json   TEXT CHECK (old_json IS NULL OR json_valid(old_json)),
  new_json   TEXT CHECK (new_json IS NULL OR json_valid(new_json)),
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_action_idx ON audit(action, seq);

-- scoped per token: one agent's retry must not collide with another's key
CREATE TABLE idempotency_keys (
  key           TEXT NOT NULL,
  token_id      TEXT NOT NULL,
  preview_id    TEXT REFERENCES previews(id) ON DELETE SET NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (key, token_id)
);

CREATE TABLE apps (
  name          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('singleton','controller','ephemeral')),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  scopes        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  token_id      TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
  installed_at  INTEGER NOT NULL
);
