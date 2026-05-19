# symfony

Symfony scaffold with PHP, a database (PostgreSQL or MariaDB), and Redis.

## Generated services

- `appserver` — `php:<8.2|8.3>`, `framework: symfony`.
- `database` — `postgres` or `mariadb` (prompt: `database`).
- `cache` — `redis`.

## Generated tooling

- `lando console …` — Symfony console.
- `lando composer …` — Composer.

## Alpha limitations

- No automatic Symfony source bootstrap; users run
  `composer create-project symfony/skeleton .` through the generated tooling
  after `lando start`.
- Messenger transports beyond Redis and built-in mailer routing are deferred.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
