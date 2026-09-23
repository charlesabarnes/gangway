# gangway: one image, one process.
#
# The docker CLI is here because gangway drives hosts by shelling out to `docker compose`
# against DOCKER_HOST. The compose plugin is a separate package and the one people forget;
# git is for git sources, openssh-client for `ssh://` docker hosts.
FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM oven/bun:1.4.2-alpine

RUN apk add --no-cache docker-cli docker-cli-compose git openssh-client tini

WORKDIR /app

# Dependencies first, so editing source does not reinstall them.
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY server/package.json server/
COPY shared/package.json shared/
RUN bun install --frozen-lockfile --production

COPY shared/ shared/
COPY server/ server/
COPY scripts/healthcheck.ts scripts/

# The Angular app: boot.ts serves web/dist/browser on the `app` surface when it exists.
COPY --from=web /web/dist/browser web/dist/browser

ENV GANGWAY_STATE_DIR=/state \
    GANGWAY_ENV=prod \
    NODE_ENV=production
VOLUME /state
EXPOSE 8443 8080

# Through the real listener, TLS and dispatch -- a process that is up but not serving is not healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "scripts/healthcheck.ts"]

# tini forwards SIGTERM and reaps the compose/git children gangway spawns.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "server/src/main.ts"]
