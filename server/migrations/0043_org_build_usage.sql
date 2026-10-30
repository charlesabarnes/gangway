-- 0043: the build time each org used, by calendar month (UTC), for a plan's build minutes. Kept
-- apart from builds, which go with their preview when it is purged.
CREATE TABLE org_build_usage (
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  month    TEXT NOT NULL,
  build_ms INTEGER NOT NULL DEFAULT 0 CHECK (build_ms >= 0),
  PRIMARY KEY (org_id, month)
);
