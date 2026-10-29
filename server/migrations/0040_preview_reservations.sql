-- 0040: the memory a preview may use on its host, as placement counts it: its per-container limit
-- times its containers, set at deploy and on every rebuild. 0 is a site, or no limit configured.
ALTER TABLE previews ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0;
