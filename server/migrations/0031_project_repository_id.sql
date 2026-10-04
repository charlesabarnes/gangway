-- 0031: the immutable id of a project's GitHub repository, kept from its first verified workflow
-- run. A name can pass to a new repository once the old one is gone; the id cannot, so a later
-- run from a different repository of the same name is refused. Changing the repository clears it.
ALTER TABLE projects ADD COLUMN repository_id TEXT;
