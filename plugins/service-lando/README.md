# @lando/service-lando

This package supplies the `lando` service base and the bundled language-runtime
and data-store `ServiceType` implementations. Use this reference when extending
the service catalog or checking which defaults a service type contributes.

The `lando` binary includes this package. Library consumers do not receive the
catalog by default: enable bundled discovery or contribute your own service-type
Layers. See [Embedding Lando](../../docs/embedding.md) for runtime configuration.

## Framework presets

Language-runtime `ServiceType`s accept an optional `framework:` field that
selects port, environment, and supported root-context defaults. It does not
start an application server. Framework presets are pure config:
they supply defaults you can change in the Landofile. Port-bearing listener
variables are derived from `port:` and must not disagree with it; ordinary
host and framework environment defaults remain overridable.

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

Explicit `webroot:` requires a final feature whose `validateEffective` callback returns `webroot` in `handledServiceFields`. A `config.webroot` property alone does not claim support. The feature must use the root for its supported context or generated server configuration; the claim does not promise HTTP serving. If no active feature handles the field, planning rejects the authored root before cache lookup.

Ruby, Python, and Go retain the direct-argv keep-alive command `tail -f /dev/null` until you author `command:`; authored `entrypoint:` is preserved too. Every type composing the `lando` base, including `type: lando` with a custom `image:`, enables native container init by default. The runtime's init is PID 1 and forwards stop signals to its direct child. Only `type: compose` (the `l337` base) leaves `init` to the provider default. Set `init: false` when the image supplies its own init or its process must own PID 1 signal handling and child reaping; an authored value always wins over the base default and over feature contributions.

Apache serves the app root by default. Set `webroot:` to a path relative to it, such as `public`, or to an absolute container path to change the generated httpd document root. `APACHE_DOCUMENT_ROOT` and `LANDO_WEBROOT` get the resolved absolute path. An authored `APACHE_DOCUMENT_ROOT` environment value wins; an authored `command:` or `entrypoint:` owns its own Apache startup config.

With `appMount: false`, PHP, nginx, Apache, and static still accept an absolute document root for image-provided content, but suppress `LANDO_WEBROOT` app context. Their relative roots require an active mount. Tomcat's image-owned root configuration requires the Lando catalog image. With a custom Tomcat image and no app mount, omit `webroot:` or compose another feature that handles it.

A generated start command runs as the service's planned `user:`. [Default start commands and the planned service user](./DEFAULT_COMMAND_AUDIT.md) records what each bundled default writes and which ones still assume root.

Stock Apache-served PHP supports `user: www-data` without startup writes into
root-owned configuration or log files. Set `port: 8080`
(or another port at or above 1024) for portable non-root binding. Lando prepares
`www-data`'s `/var/www` home during the image build and persists it by default;
no `home: false` workaround is needed. A fresh home volume inherits the prepared
ownership; an existing populated volume keeps its ownership.
Access and error logs reach container stdout and stderr through piped loggers
and remain available through `lando logs`. See [Run PHP as a non-root user](../../docs/guides/services/php.mdx#run-as-a-non-root-user)
for a complete example.

For PHP, a custom `image:` or normalized Compose `build.context` owns image
setup and startup across Apache, FPM, and CLI modes. Lando skips PHP-managed
prerequisites, extension and Composer binary installs, database clients,
WordPress tools/settings, and generated launchers. This applies even when the
planner carries the stock PHP image reference alongside the contextual build.
Additive `build.artifact` and `build.app` scripts alone keep stock setup.
Custom runtimes also omit PHP's implicit console aliases and file-log redirects; container stdout
and stderr remain available, and authored log sources still apply.
Explicit `composer.packages` still installs packages using the image's Composer;
Xdebug environment and tooling still apply, but the image supplies the extension.
See [Replace the PHP image](../../docs/guides/services/php-customization.mdx#replace-the-image).

PHP computes artifact ownership, process ownership, base-family evidence, and
log mode once during service-type resolution. Its service feature and app
features consume those facts rather than guessing from a later image reference.
Canonical aliases of the catalog Apache reference retain stock ownership;
another namespace does not. An authored `command:` or `entrypoint:` keeps stock
installers but owns startup, so it gets no generated launcher, Apache process
preparation, or implicit aliases.

Generated Apache aliases `access` to stdout and `error` to stderr. Generated FPM
aliases both names to stderr; selecting either includes all writers on that
pipe. `lando logs` reads native console once plus real followed files, and
`--source console` reads both native streams. A same-id authored file source
replaces the alias. Info reports aliases as `console/stdout` or `console/stderr`,
not invented paths. See [service logs](../../docs/guides/cli/service-logs.mdx).

Before start hooks and builds, `LANDO_NONROOT_LOW_PORT_UNVERIFIED` warns when
a declared user other than explicit root/UID 0 has a planned container port
below 1024. The warning is conditional on the identity resolving to non-root;
it neither probes bind permission nor changes ports or fails start. Provider
names and rootless mode are not proof of effective bind permission.

## Language runtime listeners

Set `port:` to change the internal HTTP endpoint and the corresponding process variables together:

| Runtime / framework | Default port | Port variables | Ordinary host defaults |
| --- | --- | --- | --- |
| Node | `3000` | `PORT` | None |
| Python `none` / `django` | `8000` | `PORT` | None |
| Python `fastapi` | `8000` | `PORT`, `UVICORN_PORT` | `UVICORN_HOST=0.0.0.0` |
| Python `flask` | `5000` | `PORT`, `FLASK_RUN_PORT` | `FLASK_RUN_HOST=0.0.0.0` |
| Ruby `none` | `3000` | `PORT` | None |
| Ruby `rails` | `3000` | `PORT` | `BINDING=0.0.0.0` |
| Go | `8080` | `PORT` | None |
| .NET | `5000` | `ASPNETCORE_HTTP_PORTS` | None (ASP.NET Core 8+ binds all interfaces) |

Each runtime exports its `ListenerContract` constants from its service module. The feature validates authored port variables through `validateEffective` before plan-cache lookup. A malformed value or one unequal to the planned port fails at `services.<name>.environment.<VAR>`, including inherited `appEnv` and env-file values. Set `port:` instead. Authored host variables still win over the ordinary defaults above.

Next.js, Nuxt, Remix, Gunicorn, Rails, and Sinatra read `PORT`; Uvicorn CLI reads `UVICORN_*`, and `flask run` reads `FLASK_RUN_*`. FastAPI CLI reads `PORT`, not `UVICORN_*`: `fastapi run` binds all interfaces, while `fastapi dev` still needs `--host 0.0.0.0`. Django `runserver` needs `0.0.0.0:<port>` in argv. Vite needs matching `--port` and `--host` flags or configuration. Sinatra in development still needs `-o 0.0.0.0`. Go applications must read `os.Getenv("PORT")` themselves; net/http, Echo, and Fiber do not do so automatically.

Use `dotnet run --no-launch-profile` so a launch profile's `applicationUrl` does not override `ASPNETCORE_HTTP_PORTS` through `ASPNETCORE_URLS`. Authored `ASPNETCORE_URLS`, `--urls`, and Kestrel code remain author-owned overrides and must match the endpoint.

Presets never start an application server. Python, Ruby, Go, and .NET keep `tail -f /dev/null`; Node keeps its idle process, which exits cleanly on SIGTERM or SIGINT. Author `command:` or use tooling to run the app. These runtimes do not infer healthchecks from ports or authored commands.

## Capture PHP mail

Add a `mailpit` service and run `lando rebuild` to wire PHP's `mail()` to the app inbox. Omitted `mailFrom` selects every resolved PHP service; `false` selects none; a list selects only those PHP services, with duplicates removed in authored order. Unknown and non-PHP targets fail before provider action. Selected services receive `msmtp` plus a PHP `sendmail_path` setting. Other services keep their mail configuration. Run `lando info` to find the inbox URL and verify a message from a selected PHP service there.

A selected PHP service with `build.context` fails with
`MailpitMsmtpBaseFamilyError`, reason `replacement-build`: the Dockerfile
controls the result, so a reference cannot prove its Debian family. Exclude
it with `mailFrom: false` or a list of other PHP services, or use a known image
without a replacement build. Reason `unproven-image-family` instead calls for
a canonical reference or sender exclusion. The error carries `service`, `reason`,
and optional `image`; all selected senders are validated before wiring mutations.
Canonical upstream
`php:` images ending in `-bookworm` or `-bullseye` remain supported without a
contextual build; additive build scripts alone do not change that selection.

## Beta scope vs. the GA-target catalog

The canonical catalog target for v4.0 GA distinguishes new service types from
new versions of existing types. Adding or removing a canonical `type:` changes
that catalog; versions within an existing entry can follow upstream releases.
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
