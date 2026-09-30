# gangway: one image, one process.
#
# The docker CLI is here because gangway drives hosts by shelling out to `docker compose`
# against DOCKER_HOST. The compose plugin is a separate package and the one people forget;
# git is for git sources, openssh-client for `ssh://` docker hosts. cloudflared gives a preview a
# public share link through a Cloudflare quick tunnel; it is a static binary, pinned and checked.

# The web and render stages emit only JS, CSS and fonts, so they run on the build machine
# rather than under emulation for each target platform.
FROM --platform=$BUILDPLATFORM node:26-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# The artifact renderer (render/): one JS bundle, its CSS and fonts, copied into artifact previews.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-alpine AS render
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY render/package.json render/
RUN bun install --frozen-lockfile
COPY shared/ shared/
COPY render/ render/
COPY web/public/favicon-preview.svg web/public/logo.svg web/public/logo-light.svg web/public/
RUN bun render/build.ts

# .br and .gz beside each text asset, so the server sends them without compressing per request.
FROM render AS assets
COPY server/src/net/encode.ts server/src/net/
COPY scripts/precompress.ts scripts/
COPY --from=web /web/dist/browser web/dist/browser
RUN bun scripts/precompress.ts web/dist/browser render/dist

FROM oven/bun:1.4.2-alpine

RUN apk add --no-cache docker-cli docker-cli-compose git openssh-client tini

ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.9.3
# TARGETARCH is BuildKit's; the classic builder leaves it empty and builds for the machine it is on.
RUN set -eu; \
    arch=${TARGETARCH:-$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')}; \
    case "$arch" in \
      amd64) sum=77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2 ;; \
      arm64) sum=aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d ;; \
      *) echo "no cloudflared for $arch" >&2; exit 1 ;; \
    esac; \
    wget -qO /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-$arch"; \
    echo "$sum  /usr/local/bin/cloudflared" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/cloudflared

WORKDIR /app

# Dependencies first, so editing source does not reinstall them.
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY render/package.json render/
RUN bun install --frozen-lockfile --production

COPY shared/ shared/
COPY server/ server/
COPY scripts/healthcheck.ts scripts/
# The logo files and the preview favicon, inlined into the pages gangway serves for previews (server/src/net).
COPY web/public/logo.svg web/public/logo-light.svg web/public/favicon-preview.svg web/public/

COPY --from=assets /src/render/dist render/dist

# The Angular app: boot.ts serves web/dist/browser on the `app` surface when it exists.
COPY --from=assets /src/web/dist/browser web/dist/browser

# Set by the release workflow (a version like 0.1.0, or edge); a local build reports dev.
ARG GANGWAY_VERSION=dev
ENV GANGWAY_VERSION=$GANGWAY_VERSION \
    GANGWAY_STATE_DIR=/state \
    GANGWAY_ENV=prod \
    NODE_ENV=production
VOLUME /state
EXPOSE 8443 8080

# Through the real listener, TLS and dispatch -- a process that is up but not serving is not healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "scripts/healthcheck.ts"]

# tini forwards SIGTERM and reaps the compose/git children gangway spawns.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "server/src/main.ts"]
