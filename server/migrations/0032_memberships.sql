-- 0032: who belongs to which org, and with which role there. A credential's role comes from its
-- person's membership in the credential's org; no membership, no access. users.role_id stays as
-- the home org's membership until users are managed per org.
CREATE TABLE memberships (
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    TEXT NOT NULL REFERENCES roles(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

INSERT INTO memberships (org_id, user_id, role_id, created_at)
  SELECT (SELECT id FROM orgs WHERE home = 1), id, role_id, created_at FROM users;
