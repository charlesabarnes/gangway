-- 0041: the OCI runtime every container on a host must use. runsc is gVisor, for hosts that run
-- strangers' code; NULL leaves the daemon's default. A host naming a runtime its daemon lacks is
-- refused like a daemon with the wrong name.
ALTER TABLE hosts ADD COLUMN runtime TEXT CHECK (runtime IS NULL OR runtime IN ('runsc'));
