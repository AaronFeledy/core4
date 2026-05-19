# eleventy

Eleventy static-site scaffold with a Node-based build helper plus an nginx
static frontend.

## Generated services

- `builder` — `node:lts` running `npx @11ty/eleventy --serve` on port 8080
  for iterative development.
- `web` — `static:nginx`, mounts the app root for serving the built site.

## Generated tooling

- `lando eleventy …` — Eleventy CLI through `npx @11ty/eleventy`.
- `lando npm …` — npm inside the builder service.

## Alpha limitations

- The recipe assumes site sources live at the app root. Custom input/output
  directory configuration runs through `.eleventy.js` (authored by the user).
- The static frontend serves files only; rewrites and asset hashing are
  deferred.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
