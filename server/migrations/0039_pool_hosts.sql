-- 0039: hosts an operator registers through the API, as an autoscaler does with a pool, beside the
-- ones the config file names. A host with an org takes only that org's previews; NULL is shared.
-- The capacity columns are what placement may put on it (NULL is no cap). A draining host takes
-- no new previews; a removed one keeps its row, so the previews it once ran still name it.
ALTER TABLE hosts ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'config'
  CHECK (managed_by IN ('config','api'));
ALTER TABLE hosts ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE hosts ADD COLUMN memory_bytes INTEGER CHECK (memory_bytes IS NULL OR memory_bytes > 0);
ALTER TABLE hosts ADD COLUMN max_previews INTEGER CHECK (max_previews IS NULL OR max_previews > 0);
ALTER TABLE hosts ADD COLUMN draining INTEGER NOT NULL DEFAULT 0 CHECK (draining IN (0,1));
ALTER TABLE hosts ADD COLUMN removed_at INTEGER;
