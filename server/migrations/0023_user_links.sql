-- 0023: one-use links emailed to a person: an invitation to set a first password, or a password
-- reset. Only a hash of the link's secret is stored. An invited account has no usable password
-- until its link is used.
ALTER TABLE users ADD COLUMN invited INTEGER NOT NULL DEFAULT 0 CHECK (invited IN (0,1));

CREATE TABLE user_links (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite','reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX user_links_user_idx ON user_links(user_id);
