-- 0036: the address a project's deploy branch serves at. A bare label names it under the server's
-- domain; a full hostname is claimed as a custom domain for its production. NULL is the slug.
ALTER TABLE projects ADD COLUMN deploy_host TEXT;
