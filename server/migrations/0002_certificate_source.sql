-- Which authority a stored certificate came from: the ACME directory URL. Without it a
-- certificate from Let's Encrypt STAGING looks perfectly valid after the operator switches
-- to production, and is served -- untrusted -- for the 60 days until it is due.
ALTER TABLE certificates ADD COLUMN source TEXT;
