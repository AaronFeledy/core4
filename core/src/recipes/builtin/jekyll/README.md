# jekyll

Jekyll static-site scaffold with a Ruby builder service plus an nginx
static frontend.

## Generated services

- `builder` — `ruby:3.3`, runs `bundle exec jekyll serve` on port 4000 for
  iterative development.
- `web` — `static:nginx`, mounts the app root for serving the built site.

## Generated tooling

- `lando jekyll …` — Jekyll CLI through `bundle exec jekyll`.
- `lando bundle …` — Bundler inside the builder service.

## Alpha limitations

- The recipe assumes site sources live at the app root. Output-directory
  remapping (`_site` → CDN-style hosting) is deferred to Beta.
- The static frontend serves files only; rewrites and asset hashing are
  deferred.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
