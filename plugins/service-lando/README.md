# @lando/service-lando

The opinionated `lando` service base plus the canonical language-runtime and
data-store `ServiceType` implementations for the Beta cut of the v4 service
catalog.

This package is bundled into the `lando` binary; library consumers opt in via
`bundled discovery`; they do not receive the canonical catalog by default and
must explicitly opt in or contribute their own service-type Layers.

## Framework presets

Language-runtime `ServiceType`s accept an optional `framework:` field that
selects port, environment, and supported root-context defaults. It does not
start an application server. Framework presets are pure config:
they emit the same fields a user would write by hand and any value can be
overridden in the Landofile.

The Beta scope is intentionally narrower than the canonical GA-target catalog
(full version sets and framework coverage for every service type). New
framework presets ship post-GA; the table below tracks what
`@lando/service-lando` ships today. The generated [service type version reference](../../docs/reference/service-types.mdx)
lists the shipped runtime matrix and pinned artifacts directly from ServiceType metadata.

| Type       | Supported `framework:` values        | Notes                                                                                                                       |
| ---------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `php`      | `wordpress`                          | Stock images include mysqli; `wordpress` installs checksum-verified WP-CLI, sets `WP_CLI_ALLOW_ROOT=1`, and writes `conf.d/50-lando-wordpress.ini` (`memory_limit = 512M`, CLI and web). Uses `webroot:` (relative to the app mount, default `.`) and `allowOverride:` (default `false`). Other framework names add no PHP preset. |
| `node`     | `none`                               | Bare `node` uses an inferred version from `.nvmrc` and compatible `package.json` engines under optional `packageRoot`; explicit types stay unchanged. No framework presets; users select their own dev-server `command:`. The ServiceType ignores `framework:`. |
| `python`   | `django`, `fastapi`, `flask`, `none` | Stock images include pinned `uv` across rebuilds; custom images own their toolchain. Framework presets set port (django/fastapi 8000, flask 5000) and environment defaults. |
| `ruby`     | `rails`, `none`                      | `rails` defaults to `webroot: public`; `none` defaults to `.`. Set `webroot:` directly to override either context default. Rails also supplies development environment defaults. |
| `go`       | `none`                               | Beta defers Echo, Fiber, Gin, Chi, and other Go web frameworks to post-GA; only `framework: none` is accepted today.    |
| `dotnet`   | n/a                                  | Uses the .NET SDK image, mounts the app at `/app`, and persists the NuGet package cache. |
| `mssql`    | n/a                                  | Runs SQL Server Developer Edition with persistent database storage and `sqlcmd` tooling. |
| `phpmyadmin` | n/a                                | Serves phpMyAdmin and wires it to app-local MySQL or MariaDB services unless `hosts:` is set. |

The data-store, search-engine, and webserver `ServiceType`s (`mariadb`,
`mysql`, `mssql`, `postgres`, `mongodb`, `redis`, `valkey`, `memcached`, `rabbitmq`,
`minio`, `localstack`, `mailpit`, `mailhog`, `solr`, `elasticsearch`, `opensearch`, `meilisearch`,
`phpmyadmin`, `nginx`, `apache`, `tomcat`, `varnish`, `static`, `compose`) do not accept a `framework:` field.

## Authored web settings

Ruby resolves `webroot:` relative to `appMount.target` (default `/app`) or accepts an absolute container path. For example, `framework: rails` with `webroot: frontend/public` sets `LANDO_WEBROOT` and the Ruby extension webroot to `/app/frontend/public`. This does not change the working directory or start Rails; author `workingDirectory:` and `command:` as needed. With `appMount: false`, Ruby omits implicit context defaults. An explicit relative or absolute `webroot:` then fails planning unless another composed feature declares and handles it. Remove the authored root or enable the mount to use built-in Ruby context.

Explicit `webroot:` requires a final feature with a non-empty string `config.webroot`, declaring that the feature handles the effective root. Plugins own that meaning and path validation; the declaration does not promise HTTP serving. Python, Go, and data stores do not declare built-in root support, so an authored root fails planning unless a supporting feature is composed. Ruby, Python, and Go retain the keep-alive command `sh -c 'tail -f /dev/null'` until you author `command:`; authored `entrypoint:` is preserved too.

Apache serves the app root by default. Set `webroot:` to a path relative to it, such as `public`, or to an absolute container path to change the generated httpd document root. `APACHE_DOCUMENT_ROOT` and `LANDO_WEBROOT` get the resolved absolute path. An authored `APACHE_DOCUMENT_ROOT` environment value wins; an authored `command:` or `entrypoint:` owns its own Apache startup config.

With `appMount: false`, PHP, nginx, Apache, static, and Tomcat still accept an absolute document root for image-provided content, but suppress `LANDO_WEBROOT` app context. Their relative roots require an active mount.

A generated start command runs as the service's planned `user:`. [Default start commands and the planned service user](./DEFAULT_COMMAND_AUDIT.md) records what each bundled default writes and which ones still assume root.

Node exposes port `3000` and sets `PORT=3000` by default. Set `port:` to change the endpoint and default `PORT`. The default idle Node process exits cleanly on SIGTERM or SIGINT and has no healthcheck. When `command:` is authored, Lando generates a TCP healthcheck against the configured service port. An authored `environment.PORT` still wins without changing the endpoint or healthcheck target.

## Capture PHP mail

Add a `mailpit` service and run `lando rebuild` to wire PHP's `mail()` to the app inbox. Omitted `mailFrom` selects every resolved PHP service; `false` selects none; a list selects only those PHP services, with duplicates removed in authored order. Unknown and non-PHP targets fail before provider action. Selected services receive `msmtp` plus a PHP `sendmail_path` setting. Other services keep their mail configuration. Run `lando info` to find the inbox URL and verify a message from a selected PHP service there.

## Beta scope vs. the GA-target catalog

The canonical catalog target for v4.0 GA is fixed: adding or removing a
canonical `type:` requires a spec amendment, though versions inside an
existing entry (e.g. adding PHP 8.5) can follow upstream releases without one.
`@lando/service-lando` ships a subset of that target catalog through Beta:

- PHP ships 8.1-8.6. Official Hub currently publishes 8.6 as RC bookworm tags.
  PHP uses explicit `webroot:` and `allowOverride:` parameters. Its WordPress
  preset installs WP-CLI on stock images without changing the webroot.
- Go framework presets (Echo, Fiber, Gin, Chi) are deferred to post-GA;
  `go:<version>` accepts only `framework: none` today.
- New canonical service types (Drupal/Laravel/Symfony framework presets
  outside `php:*`) are not added in Beta beyond what Alpha already shipped.

Plugins can still contribute additional `ServiceType` implementations that
compose with these presets through the feature priority list; a name collision
with a canonical type is rejected at plugin load with
`ServiceTypeCollisionError`.
