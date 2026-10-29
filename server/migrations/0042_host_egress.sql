-- 0042: what a host's previews may reach. restricted: gangway keeps an nftables table on the host
-- that drops private, link-local and metadata addresses, the host itself and outbound mail, for
-- hosts that run strangers' code; open leaves the host's network as it is.
ALTER TABLE hosts ADD COLUMN egress TEXT NOT NULL DEFAULT 'open'
  CHECK (egress IN ('open','restricted'));
