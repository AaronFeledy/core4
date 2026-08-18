# @lando/service-lando

The opinionated `lando` service base plus the canonical language-runtime and
data-store `ServiceType` implementations for the Beta cut of the v4 service
catalog.

This package is bundled into the `lando` binary; library consumers opt in via
`bundled discovery` — they do not receive the canonical catalog by default and
must explicitly opt in or contribute their own service-type Layers.

## Framework presets

Language-runtime `ServiceType`s accept an optional `framework:` field that
selects opinionated defaults (webserver config, URL rewrites, env defaults,
common build steps, tooling additions). Framework presets are pure config —
they emit the same fields a user would write by hand and any value can be
overridden in the Landofile.

The Beta scope is intentionally narrower than the canonical GA-target catalog
(full version sets and framework coverage for every service type). New
framework presets ship post-GA; the table below tracks what
`@lando/service-lando` ships today.

| Type       | Versions     | Supported `framework:` values                                | Notes                                                                                                                       |
| ---------- | ------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `php`      | 8.1, 8.2, 8.3, 8.4 | n/a                                                    | Uses explicit `webroot:` (default `/app`) and `allowOverride:` (default `false`); recipes own framework-specific choices.     |
| `node`     | lts, 22      | `none`                                                       | No framework presets; users select their own dev-server `command:`. The `framework:` field is accepted for schema compatibility and ignored by the ServiceType. |
| `python`   | 3.12         | `django`, `fastapi`, `flask`, `none`                         | Framework presets drive default port (django/fastapi 8000, flask 5000) and server `command:` hints.                         |
| `ruby`     | 3.3          | `rails`, `none`                                              | `rails` preset emits `public/` webroot and a `rails server -b 0.0.0.0 -p 3000` default command.                             |
| `go`       | 1.22, 1.23   | `none`                                                       | Beta defers Echo, Fiber, Gin, Chi, and other Go web frameworks to post-GA; only `framework: none` is accepted today.    |

The data-store, search-engine, and webserver `ServiceType`s (`mariadb`,
`mysql`, `postgres`, `mongodb`, `redis`, `valkey`, `memcached`, `rabbitmq`,
`minio`, `localstack`, `solr`, `elasticsearch`, `opensearch`, `meilisearch`,
`nginx`, `apache`, `static`, `compose`) do not accept a `framework:` field.

## Beta scope vs. the GA-target catalog

The canonical catalog target for v4.0 GA is fixed: adding or removing a
canonical `type:` requires a spec amendment, though versions inside an
existing entry (e.g. adding PHP 8.5) can follow upstream releases without one.
`@lando/service-lando` ships a subset of that target catalog through Beta:

- PHP ships the complete GA-target version set (8.1-8.4) and uses explicit
  `webroot:` and `allowOverride:` parameters rather than framework-name
  presets.
- Go framework presets (Echo, Fiber, Gin, Chi) are deferred to post-GA —
  `go:<version>` accepts only `framework: none` today.
- New canonical service types (Drupal/Laravel/Symfony framework presets
  outside `php:*`) are not added in Beta beyond what Alpha already shipped.

Plugins can still contribute additional `ServiceType` implementations that
compose with these presets through the feature priority list; a name collision
with a canonical type is rejected at plugin load with
`ServiceTypeCollisionError`.
