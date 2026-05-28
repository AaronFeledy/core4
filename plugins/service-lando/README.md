# @lando/service-lando

The opinionated `lando` service base plus the canonical language-runtime and
data-store `ServiceType` implementations for the Beta cut of the v4 service
catalog.

This package is bundled into the `lando` binary; library consumers opt in via
`bundled discovery` per `spec/13-library-api.md`.

## Framework presets

Language-runtime `ServiceType`s accept an optional `framework:` field that
selects opinionated defaults (webserver config, URL rewrites, env defaults,
common build steps, tooling additions). Framework presets are pure config —
they emit the same fields a user would write by hand and any value can be
overridden in the Landofile.

The Beta scope is intentionally narrower than the canonical catalog in
`spec/06-services.md` §6.12.1. New framework presets ship post-GA per Phase 6
of `spec/ROADMAP.md`; the table below tracks what `@lando/service-lando` ships
today.

| Type       | Versions     | Supported `framework:` values                                | Notes                                                                                                                       |
| ---------- | ------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `php`      | 8.2, 8.3     | `drupal`, `wordpress`, `laravel`, `symfony`, `none`          | webroot + framework-aware nginx/apache rewrites and tooling.                                                                |
| `node`     | lts, 22      | `none`                                                       | No framework presets; users select their own dev-server `command:`. The `framework:` field is rejected by the service decoder. |
| `python`   | 3.12         | `django`, `fastapi`, `flask`, `none`                         | Framework presets drive default port (django/fastapi 8000, flask 5000) and server `command:` hints.                         |
| `ruby`     | 3.3          | `rails`, `none`                                              | `rails` preset emits `public/` webroot and a `rails server -b 0.0.0.0 -p 3000` default command.                             |
| `go`       | 1.22, 1.23   | `none`                                                       | Beta defers Echo, Fiber, Gin, Chi, and other Go web frameworks to post-GA; cross-reference `spec/06-services.md` §6.12.1.    |

The data-store, search-engine, and webserver `ServiceType`s (`mariadb`,
`mysql`, `postgres`, `mongodb`, `redis`, `valkey`, `memcached`, `solr`,
`elasticsearch`, `opensearch`, `meilisearch`, `nginx`, `apache`, `static`,
`compose`) do not accept a `framework:` field.

## Beta scope vs. §6.12.1

`spec/06-services.md` §6.12.1 lists the canonical catalog target for v4.0
GA. `@lando/service-lando` ships a subset of that catalog through Beta:

- Language runtimes track the §6.12.1 catalog but pin a smaller version set
  (Beta covers the upstream-supported LTS line; additional minors land in
  v4.x without a spec amendment).
- Go framework presets (Echo, Fiber, Gin, Chi) are deferred to post-GA per
  §6.12.1 Phase 6 — `go:<version>` accepts only `framework: none` today.
- New canonical service types (Drupal/Laravel/Symfony framework presets
  outside `php:*`) are not added in Beta beyond what Alpha already shipped.

Plugins can still contribute additional `ServiceType` implementations that
compose with these presets; see `spec/06-services.md` §6.11 (features) and
§6.12.3 (catalog membership rules).
