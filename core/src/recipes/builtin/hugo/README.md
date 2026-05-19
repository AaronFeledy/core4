# hugo

Hugo static-site scaffold with a Node-based build helper plus an nginx
static frontend.

## Generated services

- `builder` — `node:lts` running `npx hugo server` on port 1313 for iterative
  development.
- `web` — `static:nginx`, mounts the app root for serving the built site.

## Generated tooling

- `lando hugo …` — Hugo CLI through `npx hugo`.
- `lando npm …` — npm inside the builder service.

## Alpha limitations

- The recipe uses `npx hugo` (Node-distributed Hugo) rather than a dedicated
  Hugo service type. A first-class `hugo` service type is deferred to Beta.
- The static frontend serves files only; advanced routing/rewrites are
  deferred.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
