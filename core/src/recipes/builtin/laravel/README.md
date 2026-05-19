# laravel

Laravel scaffold with PHP, a database (MariaDB or PostgreSQL), Redis, and an
optional queue worker.

## Generated services

- `appserver` — `php:<8.2|8.3>`, `framework: laravel`.
- `database` — `mariadb` or `postgres` (prompt: `database`).
- `cache` — `redis`.
- `worker` — additional `php:<version>` running `php artisan queue:work` when
  prompt `worker` answers `true`.

## Generated tooling

- `lando artisan …` — Laravel Artisan.
- `lando composer …` — Composer.
- `lando npm …` — npm inside the appserver.

## Alpha limitations

- No automatic Laravel source bootstrap; the recipe writes a Landofile only.
  Users run `composer create-project laravel/laravel .` (or similar) through
  the generated tooling once the app starts.
- Horizon, Telescope, and additional queue connectors are deferred to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
