# laravel

Laravel scaffold with PHP 8.1-8.6, Composer, Node 22 for Vite, MariaDB or
PostgreSQL, Redis, and an optional `via: cli` queue worker.

## Generated services

- `appserver`: `php:<8.1-8.6>`, `framework: laravel`, webroot `/app/public`.
- `database`: `mariadb:11.4` or `postgres:16` (prompt: `database`).
- `cache`: `redis`.
- `node`: `node:22`, `primary: false`, no `command`, so it idles until
  `lando npm` runs. It shares the app root at `/app` (sources, lockfiles,
  `public/build`) with the PHP services; the planner's default excludes put its
  `node_modules` in a service-private named volume.
- `worker`: additional `php:<version>` with `via: cli` running
  `php artisan queue:work` when prompt `worker` answers `true`.

## Generated tooling

- `lando artisan`: Laravel Artisan.
- `lando composer`: Composer.
- `lando npm`: npm inside the `node` service.

## Bootstrapping the codebase

The recipe writes a Landofile only. After `lando start`, create Laravel in
`tmp-app` with `lando composer create-project laravel/laravel tmp-app`, then copy
the application into the root while keeping `.lando.yml`. Run `lando composer
install` to check and install the application's dependencies, then build the
frontend with `lando npm install` and `lando npm run build`. `node_modules`
stays in the `node` service's volume; `public/build` lands in the shared `/app`.

When `worker` is true, both PHP services author
`appMount: { target: "/app", includes: ["vendor"] }`, sharing host dependencies
instead of creating separate vendor shadows. The default keeps its vendor shadow.
The queue worker needs the application and dependencies first. Run `lando restart`
after installation if the worker was started before they existed.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
