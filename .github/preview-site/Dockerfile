# PR previews of gangway.sh and its docs (.github/workflows/gangway-preview.yml): the same build as
# pages.yml, served by nginx the way GitHub Pages serves it. Built from the repository root.
FROM oven/bun:1.4.2-alpine AS build
WORKDIR /src
COPY . .
RUN bun scripts/build-site.ts \
 && cd guide && bun install --frozen-lockfile && bun run build && cp -R dist ../dist/site/docs

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY .github/preview-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist/site /usr/share/nginx/html
EXPOSE 8080
