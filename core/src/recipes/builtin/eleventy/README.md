# eleventy

Use this recipe for an Eleventy site with a Node-based development server and
an nginx frontend for the generated static files. Keep site sources in the
app root, or configure their location in `.eleventy.js`.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Generated services

- `builder`: `node:lts` running `npx @11ty/eleventy --serve` on port 8080
  for iterative development.
- `web`: `static:nginx`, serves the build output directory `/app/_site` as its document root.

## Generated tooling

- `lando eleventy …`: Eleventy CLI through `npx @11ty/eleventy`.
- `lando npm …`: npm inside the builder service.

## Alpha limitations

- The recipe assumes site sources live at the app root. Custom input/output
  directory configuration runs through `.eleventy.js` (authored by the user).
  If you change the output directory, point `webroot` on `web` at it.
- The static frontend serves files only; rewrites and asset hashing are
  deferred.
