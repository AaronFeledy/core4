# wordpress

Use this recipe for WordPress with PHP, MariaDB, and an optional Redis cache.
It writes a Landofile but does not download WordPress. Add WordPress through
the generated tooling or place the application files in the app yourself.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Generated services

- `appserver`: `php:8.4` by default (prompt: `php`), `framework: wordpress`,
  with mysqli and pinned, checksum-verified WP-CLI on stock images,
  plus `conf.d/50-lando-wordpress.ini` (`memory_limit = 512M`) for CLI and web PHP.
- `database`: `mariadb`.
- `cache`: `redis` (only when prompt `redis` answers `true`).

## Generated tooling

- `lando wp …`: WP-CLI inside `appserver`, with root tooling enabled.
- `lando composer …`: Composer inside `appserver`.

## Alpha limitations

- No WordPress source bootstrap. The recipe writes a Landofile only; users
  install WordPress through the generated tooling or by adding files manually.
  Built-in source/template fetch (`postInit: bun install`, git clone) is
  deferred to Beta.
- The recipe does not configure WordPress multisite or install WP-CLI plugins for you. Its default route supports HTTP and HTTPS through Lando's proxy; complete local CA trust setup for browser-trusted HTTPS.
