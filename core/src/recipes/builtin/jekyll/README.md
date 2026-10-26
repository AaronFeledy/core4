# jekyll

Use this recipe for a Jekyll site with a Ruby development server and an nginx
frontend for generated static files. It expects site sources in the app root
and Jekyll's default `_site/` output directory.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Generated services

- `builder`: `ruby:3.3`, runs `bundle exec jekyll serve` on port 4000 for
  iterative development. Its `build.artifact` step installs `build-essential`,
  `libssl-dev`, and `zlib1g-dev` so native gems compile.
- `web`: `static:nginx`, serves the build output directory `/app/_site` as its document root.

## Generated tooling

- `lando jekyll …`: Jekyll CLI through `bundle exec jekyll`.
- `lando bundle …`: Bundler inside the builder service.

## Alpha limitations

- The recipe assumes site sources live at the app root and Jekyll's default
  `_site/` destination. If you set `destination` in `_config.yml`, point
  `webroot` on `web` at the new directory.
- The static frontend serves files only; rewrites and asset hashing are
  deferred.
