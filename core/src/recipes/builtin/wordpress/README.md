# wordpress

WordPress scaffold with PHP, MariaDB, and an optional Redis cache.

## Generated services

- `appserver` — `php:8.4` by default (prompt: `php`), `framework: wordpress`,
  with mysqli and pinned, checksum-verified WP-CLI on stock images,
  plus `conf.d/50-lando-wordpress.ini` (`memory_limit = 512M`) for CLI and web PHP.
- `database` — `mariadb`.
- `cache` — `redis` (only when prompt `redis` answers `true`).

## Generated tooling

- `lando wp …` — WP-CLI inside `appserver`, with root tooling enabled.
- `lando composer …` — Composer inside `appserver`.

## Alpha limitations

- No WordPress source bootstrap. The recipe writes a Landofile only; users
  install WordPress through the generated tooling or by adding files manually.
  Built-in source/template fetch (`postInit: bun install`, git clone) is
  deferred to Beta.
- Multi-site, WP-CLI plugins, and automatic SSL are deferred.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
