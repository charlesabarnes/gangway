-- 0017: the gangway watermark, stamped by gangway on every HTML page it answers (ADR-0032).
--
-- Before this, the artifact kit drew a faint mark itself, switched per preview by `source.brand`
-- in the source JSON and fixed at build time. gangway now adds the mark at the edge -- proxied
-- apps, uploaded sites and artifacts alike -- and decides per request, so a switch needs no rebuild.
--
-- previews.watermark: 'on' | 'off', NULL = follow the repository, then the setting.
-- projects.watermark: 'on' | 'off', NULL = follow the setting `previews.watermark`.
--
-- The setting `artifacts.brand` becomes `previews.watermark`; a preview's `source.brand` moves
-- to the column and leaves the source JSON.
--
-- New permission previews.watermark: switch the mark on a preview or repository. Granted to every
-- role that can change a preview today, so nothing changes until the owner re-maps it.

ALTER TABLE previews ADD COLUMN watermark TEXT CHECK (watermark IS NULL OR watermark IN ('on','off'));
ALTER TABLE projects ADD COLUMN watermark TEXT CHECK (watermark IS NULL OR watermark IN ('on','off'));

UPDATE previews SET watermark = json_extract(source_json, '$.brand')
  WHERE json_extract(source_json, '$.brand') IN ('on','off');
UPDATE previews SET source_json = json_remove(source_json, '$.brand')
  WHERE json_extract(source_json, '$.brand') IS NOT NULL;

UPDATE settings SET key = 'previews.watermark' WHERE key = 'artifacts.brand'
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'previews.watermark');
DELETE FROM settings WHERE key = 'artifacts.brand';

INSERT OR IGNORE INTO permissions (id, feature, description) VALUES
  ('previews.watermark', 'previews', 'Switch the gangway watermark on or off for a preview or repository');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT role_id, 'previews.watermark' FROM role_permissions
  WHERE permission_id IN ('previews.update', 'previews.update_own');
