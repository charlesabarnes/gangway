-- 0004: repositories a forge sends pull requests from (ADR-0011).
--
-- The second recorded exception to ADR-0005's "columns, not tables". A `repos` row is the
-- per-repository configuration §15.5 asked for -- the hostname slug, the fork policy, a
-- visibility and TTL of its own -- and it is created by the FIRST webhook from that
-- repository, never by hand. The reconciler never reads it: a PR preview is an ordinary
-- preview once it exists, recoverable from labels like any other.
--
-- `slug` is the hostname stem: previews are `<slug>-pr-<n>`. It is unique across all
-- repositories, so two repos named `api` in two organizations cannot both claim
-- `api-pr-1`; the second is registered disabled with the reason, and the operator gives
-- it a slug.

CREATE TABLE repos (
  id              TEXT PRIMARY KEY,
  forge           TEXT NOT NULL CHECK (forge IN ('github')),
  full_name       TEXT NOT NULL,
  installation_id TEXT NOT NULL DEFAULT '',
  slug            TEXT NOT NULL UNIQUE,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  disabled_reason TEXT,
  -- NULL means the server default (settings.defaults.*)
  visibility      TEXT CHECK (visibility IS NULL OR visibility IN ('public','unlisted','private')),
  ttl             TEXT,
  -- ask: a fork PR builds only after `/preview deploy` from someone with a say (§9).
  forks           TEXT NOT NULL DEFAULT 'ask' CHECK (forks IN ('ask','auto','never')),
  drafts          INTEGER NOT NULL DEFAULT 0 CHECK (drafts IN (0,1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (forge, full_name)
);

-- The forge-side objects a PR preview keeps current: its one status comment and its
-- deployment. Ids only; both are looked up by id, never searched for, on the hot path.
ALTER TABLE previews ADD COLUMN forge_comment_id INTEGER;
ALTER TABLE previews ADD COLUMN forge_deployment_id INTEGER;
