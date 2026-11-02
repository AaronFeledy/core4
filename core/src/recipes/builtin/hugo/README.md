# hugo

Use this recipe to start a Hugo site with a Node-based build helper and an
nginx frontend for static files. Initialization writes `.lando.yml` and a starter
site with Hugo configuration, an archetype, and layouts for the home page and
new content. The first `lando start` serves a page.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

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
