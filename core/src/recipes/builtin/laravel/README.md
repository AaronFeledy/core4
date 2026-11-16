# laravel

Use this recipe for Laravel with PHP 8.1-8.6, Composer, Node 22 for Vite,
MariaDB, PostgreSQL or SQLite, and Redis. You can also add a PHP CLI queue worker.
The recipe configures the stack; create the Laravel application afterward.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Bootstrapping the codebase

The recipe writes a Landofile only. After `lando start`, run
`lando create-project laravel/laravel`. It stages the skeleton outside the app
root, promotes it without overwriting `.lando.yml`, installs `vendor` in place,
and runs Laravel's own `post-root-package-install` and
`post-create-project-cmd` hooks in Composer's order. Pass `--no-scripts` to
skip those hooks and install scripts. Then build the frontend with
`lando npm install` and `lando npm run build`. `node_modules`
stays in the `node` service's volume; `public/build` lands in the shared `/app`.

When `worker` is true, both PHP services author
`appMount: { target: "/app", includes: ["vendor"] }`, sharing host dependencies
instead of creating separate vendor shadows. The default keeps its vendor shadow.
The queue worker needs the application and dependencies first. Start warns about a
`restarting` worker while they are missing. The engine retries the worker automatically
and it starts on its own once installation finishes. Check `lando logs --service=worker`.

## Generated services

- `appserver`: `php:<8.1-8.6>`, `framework: laravel`, app-relative webroot `public`.
- `database`: `mariadb:11.4` or `postgres:16` (prompt: `database`).
- With `database=sqlite`, no database service is generated. `appserver` declares
  `sqlite.path: database/database.sqlite` beneath its `/app` mount. Composer
  creates and migrates this file when it creates the Laravel project.
- `cache`: `redis`.
- `node`: `node:22`, `primary: false`, no `command`, so it idles until
  `lando npm` runs. It shares the app root at `/app` (sources, lockfiles,
  `public/build`) with the PHP services; the planner's default excludes put its
  `node_modules` in a service-private named volume.
- `worker`: additional `php:<version>` with `via: cli` running
  `php artisan queue:work` with `restart: unless-stopped` when prompt `worker` answers `true`.

## Generated tooling

The appserver and worker receive `DB_CONNECTION` (`mysql`, `pgsql`, or `sqlite`).
MariaDB and PostgreSQL also supply `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`,
and `DB_PASSWORD` from the database service's planned port and credentials.
Laravel's immutable dotenv repository gives these environment values precedence
over `.env`. SQLite sets only `DB_CONNECTION` and has no database dependency.

- `lando artisan`: Laravel Artisan.
- `lando composer`: Composer.
- `lando create-project <package> [<version>]`: Stage a Composer project (for example `laravel/laravel`) outside the app root, promote it into `/app` without overwriting `.lando.yml`, install `vendor` in place, then run the root package's `post-root-package-install` and `post-create-project-cmd` hooks. `--no-scripts` skips both hooks and install scripts.
- `lando npm`: npm inside the `node` service.

The PHP service image installs `lando-create-project` when Composer is enabled, so this recipe declares the task rather than the program; disabling Composer removes both.
