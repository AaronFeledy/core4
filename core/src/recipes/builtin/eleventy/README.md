# eleventy

Use this recipe for an Eleventy site with a Node-based development server and
an nginx frontend for the generated static files. Keep site sources in the
app root, or configure their location in `.eleventy.js`.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Generated services

- `builder`: `node:lts` with `command: [":node-install-run", "start"]`. Each
  time its process starts, it installs the project's dependencies with the
  project's package manager, then runs the `start` script
  (`eleventy --serve --port 8080`) for iterative development. A failed install
  means the server does not start.
- `web`: `static:nginx`, serves the build output directory `/app/_site` as its document root.

## Generated files

- `.lando.yml`
- `package.json`: private, with `@11ty/eleventy` as a dev dependency, `start`
  set to `eleventy --serve --port 8080`, and `build` set to `eleventy`.

## Generated tooling

- `lando eleventy …`: the project's installed Eleventy CLI, run through the
  project's package manager. It never downloads Eleventy.
- `lando npm …`: npm inside the builder service.

## Limitations

- The recipe assumes site sources live at the app root. Custom input/output
  directory configuration runs through `.eleventy.js` (authored by the user).
  If you change the output directory, point `webroot` on `web` at it.
- The static frontend serves files only. The `static:nginx` service type has
  no rewrite or asset-hashing options; handle those in your Eleventy build.
