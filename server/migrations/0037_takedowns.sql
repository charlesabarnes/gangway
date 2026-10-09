-- 0037: what the operator took down, and when an org's membership last changed. A taken-down
-- hostname answers 410 until the operator lifts it, whatever is deployed there later. A billing
-- system reads seat counts of the orgs changed since it last asked, so joining or leaving an org
-- moves the org's updated_at.
CREATE TABLE takedowns (
  hostname   TEXT PRIMARY KEY,
  preview_id TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX takedowns_preview_idx ON takedowns(preview_id);
CREATE INDEX orgs_updated_idx ON orgs(updated_at);

CREATE TRIGGER memberships_joined AFTER INSERT ON memberships BEGIN
  UPDATE orgs SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE id = NEW.org_id;
END;

CREATE TRIGGER memberships_left AFTER DELETE ON memberships BEGIN
  UPDATE orgs SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE id = OLD.org_id;
END;
