# waitlist

The Cloudflare Worker behind the "Join the waitlist" form on `site/cloud.html`, and the site's
visit counter. It takes a POST at
`/waitlist` (JSON from the page's script, or a plain form post without JavaScript) and upserts
one row per email into a D1 database. Only origins in `ALLOWED_ORIGINS` may post.

## First deploy

```sh
cd waitlist
bunx wrangler login
bunx wrangler d1 create gangway-waitlist        # copy the database_id into wrangler.toml
bunx wrangler d1 execute gangway-waitlist --remote --file schema.sql
bunx wrangler deploy                            # prints https://gangway-waitlist.<you>.workers.dev
```

Put `<that URL>/waitlist` in the form's `action` in `site/cloud.html`. If the site moves to a
custom domain, update `ALLOWED_ORIGINS` and `SITE_URL` in `wrangler.toml` and deploy again.

## Reading signups

```sh
bunx wrangler d1 execute gangway-waitlist --remote \
  --command "SELECT created_at, email, name, company, team_size, previews, preview_domain, would_deploy FROM waitlist ORDER BY created_at DESC"
```

Add `--json > signups.json` to export them.

## Visits

`site/js/visit.js` posts each page load's path to `/hit`, and the Worker adds one to that page's
count for the day in the `visits` table. It stores no cookies, IPs or user agents, and only
counts loads on gangway.sh from an allowed origin.

```sh
bunx wrangler d1 execute gangway-waitlist --remote \
  --command "SELECT day, path, count FROM visits ORDER BY day DESC, path"
```

## Local

```sh
bunx wrangler d1 execute gangway-waitlist --local --file schema.sql
bunx wrangler dev --port 8787
```

`localhost:4173` is an allowed origin, for serving `site/` with `python3 -m http.server 4173 -d site`.
The tests (`bun test waitlist/test`) run the handler against the real schema in `bun:sqlite`.
