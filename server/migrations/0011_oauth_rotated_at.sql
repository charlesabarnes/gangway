-- 0011: when a grant's refresh token last rotated (ADR-0020, amended).
--
-- A rotated-away refresh token that comes back within a short grace window of its rotation
-- is refused WITHOUT revoking the grant: that is a client racing itself (two refreshes in
-- flight with one token), not a thief. Outside the window it is replay, and revokes the grant
-- as before (OAuth 2.1 §4.3.1). `last_used_at` cannot serve: every access-token use touches it.
-- NULL on grants that have never rotated, and on rows from before this migration.

ALTER TABLE oauth_grants ADD COLUMN rotated_at INTEGER;
