# hugo

Hugo static-site scaffold with a Node-based build helper plus an nginx
static frontend. Init emits `.lando.yml` and a small starter site (Hugo
config, archetype, and layouts for the home page and new content), so the
first `lando start` serves a page.

## Generated services

- `builder`: `node:lts` with a pinned official Hugo extended binary baked
  into the image at build time, running `hugo server` on port 1313 for
  iterative development.
- `web`: `static:nginx`, serves the build output directory `/app/public` as
  its document root.

## Generated tooling

- `lando hugo ...`: the bundled Hugo CLI.
- `lando npm ...`: npm inside the builder service.

## Limitations

- The recipe pins one Hugo extended release in the builder image rather than
  shipping a dedicated `hugo` service type. A first-class `hugo` service type
  is deferred to Beta.
- The recipe assumes Hugo's default `public/` output. If you set `publishDir`
  in your Hugo config, point `webroot` on `web` at the new directory.
- The static frontend serves files only; advanced routing/rewrites are
  deferred.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
