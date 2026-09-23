-- 0013: "people signed in to gangway" as a way to open a preview (ADR-0023, amended).
--
-- previews.signed_in_only: 1 when only a gangway login opens it -- the private handshake,
--   and no password is asked for or accepted. Switchable on a running preview, unlike
--   `visibility`, which fixes the hostname at deploy. The password (if any) is kept, so
--   switching back needs no new one. The API reports it as `passwordLogin: "only"`; it is
--   its own column because 0012's CHECK on password_login cannot be widened in SQLite.

ALTER TABLE previews ADD COLUMN signed_in_only INTEGER NOT NULL DEFAULT 0 CHECK (signed_in_only IN (0,1));
