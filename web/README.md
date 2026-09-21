# gangway — web UI

Angular 22, standalone components, signals, **zoneless**; Tailwind 4 (CSS-first, no config
file); hand-rolled components, no component library. **npm**, not bun, in this directory.
Built to static files that the gangway server itself serves on the `app` hostname — no SSR,
no second runtime (spec §10.3).

```bash
npm ci
npm run build                    # -> dist/browser, which server/src/boot.ts serves
npm test -- --watch=false        # vitest, jsdom
```

The spec caps the product at eight screens: *"a dashboard is how this becomes Coolify."*
Today: login, first-run setup, **Previews**, **Preview detail**, and an account page that
stands in for Tokens.

## Running it against a real server

Start gangway (repo root; see `docs/STATUS.md` for the tunnel to tower):

```bash
GANGWAY_CONFIG=scripts/dev.json GANGWAY_ADMIN_TOKEN=gw_dev_$(openssl rand -hex 16) bun server/src/main.ts
```

On first run it prints a one-time **setup URL**. Then either:

**A. `ng serve` (fast reload).** `npm start`, open `http://localhost:4200`, and replace the
origin of the printed URL: `http://localhost:4200/setup?token=gw_setup_…`.
`proxy.conf.json` forwards `/v1` and `/healthz` to `https://app.preview.localhost:8443` and
rewrites `Origin`, because the server refuses a cookie-authenticated mutation whose Origin is
not its own (ADR-0010) and the browser honestly sends `http://localhost:4200`.
Works in Chrome and Firefox, which treat `localhost` as a secure context and so accept the
`Secure`, `__Host-` session cookie over plain http. **Safari does not** — use B.

**B. Served by gangway (what production does).** `npm run watch`, started *before* gangway
(boot checks for `dist/browser` once), then open `https://app.preview.localhost:8443`. The
certificate is from gangway's dev CA (`state/dev-ca/ca.pem`); trust it or click through.

## Things that will bite you

- **Zoneless.** Nothing re-renders unless a signal changed. A countdown needs its own
  interval writing a signal; "3 h ago" re-renders because `Clock.now` is one. A plain field
  mutated in a spec's host component is NOT picked up — use a signal.
- **Gate on permissions, never a role name.** `auth.can('previews.destroy')`. Which role
  holds what is the operator's data (ADR-0009) and can change under an open tab; the account
  page renders a role it has never heard of correctly. `can()` is advice about what to show —
  the server still refuses.
- **`core/api.types.ts` is hand-written** (the wire is JSON: every timestamp is a string).
  It is pinned from both sides by `src/testing/fixtures/contract.json`: the server's
  `web-contract.test.ts` asserts real output matches it, `api.types.spec.ts` asserts it
  satisfies these types. Change a field, a state or a permission on one side alone and a
  test fails.
- **`SseService` never trusts EventSource's own retry.** Native EventSource gives up for good
  on any non-200 — gangway's 503 while draining, a proxy's 502 while it restarts. Every
  error closes the source and reopens it with backoff and `?after=<last id>`. The cursor is
  an OPTION to `open()`, never part of the URL: a reconnect appends its own `after`, and two
  would mean the server reads the stale one.
- **Named SSE events never reach `onmessage`.** Every event gangway sends is named; list the
  types.
- **The log viewer batches per animation frame** (`FRAME` token) into one signal write.
  500 lines a second must not be 500 change-detection passes.
- `viewChild` cannot sit on an ES `#private` member (NG1053); use TypeScript `private`.
- Literal `{`/`}` in a template collide with `@`-block syntax; bind a string instead.
- jsdom has no `EventSource`, no `requestAnimationFrame`, and no `<dialog>` behaviour:
  `src/testing/` has a fake, a token, and a polyfill. Angular collapses whitespace between
  elements, so two adjacent `<span>`s read as one word in `textContent` — the gap is CSS.
- `testing/render.ts`'s `settle()` waits real macrotask turns: a rejected `firstValueFrom`
  reaches its `catch` several turns after the flush. Specs that fake timers fake only
  `setInterval`.
- CI runs the **production** build: budgets are 500 kB warn / 1 MB error on the initial
  bundle (293 kB today). Every screen is a lazy chunk; keep it that way.
