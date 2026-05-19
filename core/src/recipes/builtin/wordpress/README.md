# wordpress

WordPress scaffold with PHP, MariaDB, and an optional Redis cache.

## Generated services

- `appserver` — `php:8.2` or `php:8.3` (prompt: `php`), `framework: wordpress`.
- `database` — `mariadb`.
- `cache` — `redis` (only when prompt `redis` answers `true`).

## Generated tooling

- `lando wp …` — WP-CLI inside `appserver`.
- `lando composer …` — Composer inside `appserver`.

## Alpha limitations

- No WordPress source bootstrap. The recipe writes a Landofile only; users
  install WordPress through the generated tooling or by adding files manually.
  Built-in source/template fetch (`postInit: bun install`, git clone) is
  deferred to Beta.
- Multi-site, WP-CLI plugins, automatic SSL, and PHP-version pinning beyond
  the bundled service catalog (`8.2`, `8.3`) are deferred.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
