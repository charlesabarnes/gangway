-- 0020: indexes for lists and pruning (ADR-0035).
--
-- previews.owner, previews.credential: a person or credential that may read only its own
--   previews gets them from the index instead of every row.
-- events.created_at, audit.created_at: the daily prune deletes by age.

CREATE INDEX previews_owner_idx ON previews(owner) WHERE owner IS NOT NULL;
CREATE INDEX previews_credential_idx ON previews(credential) WHERE credential IS NOT NULL;
CREATE INDEX events_created_idx ON events(created_at);
CREATE INDEX audit_created_idx ON audit(created_at);
