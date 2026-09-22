-- 0006: secrets have levels; previews have a clearance (ADR-0012, amended).
--
-- A secret is low, standard or high (kept inside the encrypted map, not here). A preview
-- is deployed with a CLEARANCE and receives every secret at or below it. The repository
-- decides the default clearance for its own pull requests and for forks; a person can
-- raise or lower one pull request's. `none` means no .env at all.

ALTER TABLE repos ADD COLUMN pr_clearance   TEXT NOT NULL DEFAULT 'standard'
  CHECK (pr_clearance IN ('none','low','standard','high'));
ALTER TABLE repos ADD COLUMN fork_clearance TEXT NOT NULL DEFAULT 'none'
  CHECK (fork_clearance IN ('none','low','standard','high'));
ALTER TABLE previews ADD COLUMN secret_level TEXT
  CHECK (secret_level IS NULL OR secret_level IN ('none','low','standard','high'));
