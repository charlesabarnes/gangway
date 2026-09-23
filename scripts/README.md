# scripts

## acme-pebble-check.ts

`scripts/acme-pebble-check.ts` runs `tls/acme.ts` against a real ACME server: Pebble (Let's
Encrypt's test CA) and its challenge DNS server, both on a Docker host reachable over SSH as
`$DOCKER_HOST_SSH`.

The unit tests cover the sequencing against a fake. This check covers the protocol (nonces,
JWS, order finalization, a real chain) and the part no unit test can: gangway boots on the dev
CA, the `cert-renew` job obtains the certificate, and the listener presents it without a
restart.

### Running it

```sh
ssh $DOCKER_HOST_SSH 'docker run --rm -d --name gw-acme-challtestsrv \
    -p 127.0.0.1:31900:14000 -p 127.0.0.1:31901:8055 ghcr.io/letsencrypt/pebble-challtestsrv:latest \
    -http01 "" -https01 "" -tlsalpn01 "" -doh "" -dnsserver ":8053" -management ":8055"'
ssh $DOCKER_HOST_SSH 'docker run --rm -d --name gw-acme-pebble --network container:gw-acme-challtestsrv \
    -e PEBBLE_VA_NOSLEEP=1 ghcr.io/letsencrypt/pebble:latest \
    -config test/config/pebble-config.json -dnsserver 127.0.0.1:8053 -strict'
ssh -N -L 31900:127.0.0.1:31900 -L 31901:127.0.0.1:31901 $DOCKER_HOST_SSH &
NODE_TLS_REJECT_UNAUTHORIZED=0 bun scripts/acme-pebble-check.ts
ssh $DOCKER_HOST_SSH 'docker stop gw-acme-pebble gw-acme-challtestsrv'
```

### Notes

- Pebble's own API certificate comes from a throwaway CA, so `NODE_TLS_REJECT_UNAUTHORIZED=0`
  is needed for this script only.
- Pebble rejects about 5% of nonces on purpose, so a passing run also exercises the `badNonce`
  retry path.
