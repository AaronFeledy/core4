# symfony

Symfony scaffold with PHP 8.1-8.5, Composer, PostgreSQL or MariaDB, and Redis.

## Generated services

- `appserver` — `php:<8.1-8.5>`, `framework: symfony`, webroot `/app/public`.
- `database` — `postgres:16` or `mariadb:11.4` (prompt: `database`).
- `cache` — `redis`.

## Generated tooling

- `lando console …` — Symfony console.
- `lando composer …` — Composer.

## Bootstrapping the codebase

The recipe writes a Landofile only. After `lando start`, create the Symfony
project with the generated Composer tooling if the app root is empty.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
