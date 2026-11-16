# symfony

Use this recipe for Symfony with PHP 8.1-8.6, Composer, PostgreSQL or MariaDB,
and Redis. The recipe configures the services; create the Symfony application
through Composer after starting the stack.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Bootstrapping the codebase

The recipe writes a Landofile only. After `lando start`, run
`lando create-project symfony/skeleton`. It stages the skeleton outside the app
root, promotes it without overwriting `.lando.yml`, installs `vendor` in place,
and runs the project's Composer hooks. Pass a version or constraint as the second
argument, and `--no-scripts` to skip the hooks and install scripts.

## Generated services

- `appserver`: `php:<8.1-8.6>`, `framework: symfony`, app-relative webroot `public`.
- `database`: `postgres:16` or `mariadb:11.4` (prompt: `database`).
- `cache`: `redis`.

The `appserver` service receives `DATABASE_URL` for the selected PostgreSQL or
MariaDB version and `REDIS_URL` for Redis. Database credentials resolve from
the database service at plan time.

## Generated tooling

- `lando console …`: Symfony console.
- `lando composer …`: Composer.
- `lando create-project <package> [<version>]`: Stage a Composer project (for example `symfony/skeleton`) outside the app root, promote it into `/app` without overwriting `.lando.yml`, install `vendor` in place, then run the root package's Composer hooks. `--no-scripts` skips both hooks and install scripts.

The container helper mounts `lando-create-project` on the service PATH, so this recipe declares the task rather than the program; disabling Composer removes the tool entry.
