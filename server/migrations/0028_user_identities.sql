-- 0028: sign-in through an OpenID Connect provider. A person's first sign-in matches an existing
-- account by its verified email and stores the provider's (issuer, subject) here; later sign-ins
-- match by that pair, so a changed email at the provider still finds the same account. Nobody
-- gets an account by signing in: an admin adds them first.
CREATE TABLE user_identities (
  issuer       TEXT NOT NULL,
  subject      TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX user_identities_user_idx ON user_identities(user_id);
