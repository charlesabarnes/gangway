-- 0034: the bytes a site gangway serves keeps on disk, counted when it is published, so an org's
-- storage can be held to its plan. Container previews and sites from before this count 0.
ALTER TABLE previews ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0);
