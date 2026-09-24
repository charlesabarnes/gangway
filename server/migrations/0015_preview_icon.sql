-- 0015: a preview's icon -- a Lucide name and one of a few colours, shown beside its title.
--
-- previews.icon / previews.icon_color: NULL until someone (usually the agent that deployed it)
--   picks one; the UI then draws a grey icon for the source kind. Both are set or neither.
--   The allowed names and colours live in shared/src/preview-icon.ts, not in a CHECK, so the
--   list can grow without a migration.

ALTER TABLE previews ADD COLUMN icon TEXT CHECK (icon IS NULL OR length(icon) BETWEEN 1 AND 40);
ALTER TABLE previews ADD COLUMN icon_color TEXT
  CHECK ((icon IS NULL AND icon_color IS NULL) OR (icon IS NOT NULL AND icon_color IS NOT NULL));
