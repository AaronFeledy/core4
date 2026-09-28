# jekyll

Jekyll static-site scaffold with a Ruby builder service plus an nginx
static frontend.

## Generated services

- `builder` — `ruby:3.3`, runs `bundle exec jekyll serve` on port 4000 for
  iterative development.
- `web` — `static:nginx`, serves the build output directory `_site/` as its document root.

## Generated tooling

- `lando jekyll …` — Jekyll CLI through `bundle exec jekyll`.
- `lando bundle …` — Bundler inside the builder service.

## Alpha limitations

- The recipe assumes site sources live at the app root and build output goes
  into `_site/`, which the `web` service serves as its document root.
- The static frontend serves files only; rewrites and asset hashing are
  deferred.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
