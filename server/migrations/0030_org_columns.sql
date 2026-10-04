-- 0030: what belongs to an org says which. Every existing row joins the home org through the
-- default; a later migration drops the defaults once every write names its org.
ALTER TABLE previews ADD COLUMN org_id TEXT NOT NULL DEFAULT '00000000000000000000000000' REFERENCES orgs(id);
ALTER TABLE projects ADD COLUMN org_id TEXT NOT NULL DEFAULT '00000000000000000000000000' REFERENCES orgs(id);
ALTER TABLE templates ADD COLUMN org_id TEXT NOT NULL DEFAULT '00000000000000000000000000' REFERENCES orgs(id);
ALTER TABLE artifact_themes ADD COLUMN org_id TEXT NOT NULL DEFAULT '00000000000000000000000000' REFERENCES orgs(id);
ALTER TABLE artifact_templates ADD COLUMN org_id TEXT NOT NULL DEFAULT '00000000000000000000000000' REFERENCES orgs(id);
ALTER TABLE domains ADD COLUMN org_id TEXT NOT NULL DEFAULT '00000000000000000000000000' REFERENCES orgs(id);
ALTER TABLE api_tokens ADD COLUMN org_id TEXT NOT NULL DEFAULT '00000000000000000000000000' REFERENCES orgs(id);
ALTER TABLE oauth_grants ADD COLUMN org_id TEXT NOT NULL DEFAULT '00000000000000000000000000' REFERENCES orgs(id);
ALTER TABLE roles ADD COLUMN org_id TEXT NOT NULL DEFAULT '00000000000000000000000000' REFERENCES orgs(id);

-- A session's active org; NULL is the home org. Events and audit entries with no org are the
-- server's own, which only the home org reads.
ALTER TABLE sessions ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE events ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE audit ADD COLUMN org_id TEXT REFERENCES orgs(id);

CREATE INDEX previews_org_idx ON previews(org_id);
CREATE INDEX projects_org_idx ON projects(org_id);
CREATE INDEX events_org_idx ON events(org_id, seq);
CREATE INDEX audit_org_idx ON audit(org_id, seq);
