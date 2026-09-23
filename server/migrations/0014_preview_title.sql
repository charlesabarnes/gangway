-- 0014: a preview's title -- any string a person chooses to call it, shown in the UI.
--
-- previews.title: NULL until someone names it; the UI then falls back to the slug. It is
--   not the hostname: the slug (the first label, from `name`) stays DNS-safe and fixed at
--   deploy, while the title can say anything and be changed on a running preview.

ALTER TABLE previews ADD COLUMN title TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 100);
