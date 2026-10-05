-- 0035: the branch a project's workflow may deploy from on push, rebuilt in place as the
-- project's production preview. NULL refuses push deploys.
ALTER TABLE projects ADD COLUMN deploy_branch TEXT;
