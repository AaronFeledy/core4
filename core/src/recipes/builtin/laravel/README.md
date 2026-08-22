# laravel

Laravel scaffold with PHP 8.1-8.5, Composer, MariaDB or PostgreSQL, Redis, and
an optional `via: cli` queue worker.

## Generated services

- `appserver` — `php:<8.1-8.5>`, `framework: laravel`, webroot `/app/public`.
- `database` — `mariadb:11.4` or `postgres:16` (prompt: `database`).
- `cache` — `redis`.
- `worker` — additional `php:<version>` with `via: cli` running
  `php artisan queue:work` when prompt `worker` answers `true`.

## Generated tooling

- `lando artisan …` — Laravel Artisan.
- `lando composer …` — Composer.
- `lando npm …` — npm inside the appserver.

## Bootstrapping the codebase

The recipe writes a Landofile only. After `lando start`, create the Laravel
project with the generated Composer tooling if the app root is empty.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
