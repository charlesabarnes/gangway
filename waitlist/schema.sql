CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  team_size TEXT NOT NULL DEFAULT '',
  preview_domain TEXT NOT NULL DEFAULT '',
  previews TEXT NOT NULL DEFAULT '',
  would_deploy TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
