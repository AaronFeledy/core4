# Default start commands and the planned service user

Most bundled service types install a default container `command` when the author
declared neither `command:` nor `entrypoint:`. Several of those defaults are
shell scripts that write a configuration file before exec'ing the daemon. Every
service feature also applies the author's `user:` through `setUser`, which
becomes the container `User`, so a generated launcher runs as the planned
identity rather than as root.

A launcher that writes into a root-owned path therefore fails whenever the
author sets a non-root `user:`. The container exits on its own start command,
and the next operation against it — a rebuild, an exec, a healthcheck — fails
against a container that is already gone, which hides the real cause.

This file records every bundled default command, what it writes, and whether it
survives a non-root `user:`. Keep it current when a service type gains, loses,
or changes a default command.

## Reproducing a failure

Each row below marked `needs-fix` reproduces the same way. Put the listed
service in a Landofile with a non-root `user:` that exists in the image, then
start it:

```yaml
name: nonroot-repro
services:
  web:
    type: <type>
    user: <non-root user from the image>
```

```bash
lando start
lando logs -s web
```

The container exits during start. The logs carry the launcher's own error — a
permission denial on the write target in the table — rather than a daemon error.

## Audit

| Service type / mode | Source | Runtime write targets | Non-root `user:` | Status |
| --- | --- | --- | --- | --- |
| `apache` | `src/services/apache.ts` `apacheStartCommand` | none | works | **fixed** |
| `php:*` via `apache` (default) | `src/services/php-via.ts` `apacheStartCommand` | none | works | **fixed** |
| `php:*` via `fpm` | `src/services/php-via.ts` `fpmStartCommand` | `/usr/local/etc/php-fpm.d/zz-lando-listen.conf` | fails | needs-fix |
| `nginx` with `backend:` | `src/services/nginx.ts` `phpFastcgiCommand` | `/etc/nginx/conf.d/default.conf` | fails | needs-fix |
| `static` / `static:nginx` | `src/services/static.ts` `defaultStaticCommand` | `/etc/nginx/conf.d/default.conf` | fails | needs-fix |
| `solr` with `cores:` | `src/services/solr.ts` | `/var/solr/data/<core>/conf` | fails unless the user owns the Solr data tree | needs-fix |
| `minio` | `src/services/minio.ts` | `mkdir` under `/data` | depends on volume ownership | needs-fix |
| `varnish` without a VCL bind | `src/services/varnish.ts` | `/tmp/lando-backend.vcl` | write works; the daemon still needs root for its default `:80` | safe write, privileged port |
| `redis` with `password:` | `src/services/redis.ts` | `/tmp/lando-redis.conf` | works | safe |
| `php:*` via `cli` | `src/services/php-via.ts` `PHP_CLI_KEEP_ALIVE` | none | works | safe |
| `node`, `go`, `python`, `ruby`, `dotnet` | respective `src/services/*.ts` | none | works | safe |
| `memcached`, `valkey`, `redis` without `password:` | respective `src/services/*.ts` | none | works | safe |
| `static:caddy` | `src/services/static.ts` | none | write-free; default `:80` is still privileged | safe write, privileged port |
| `postgres`, `mongodb` with `config.server` | `src/services/postgres.ts`, `src/services/mongodb.ts` | none — the command only names a config path | works | safe |
| `nginx` without `backend:` | `src/services/nginx.ts` | none — the image entrypoint starts the daemon | n/a | safe |

Service types with no Lando-emitted default command (`compose`, `lando`,
`mariadb`, `mysql`, `mssql`, `mailhog`, `mailpit`, `phpmyadmin`, `tomcat`,
`rabbitmq`, `localstack`, `elasticsearch`, `opensearch`, `meilisearch`) are out
of scope here: their images own startup, and Lando adds no write.

Build steps are also out of scope. They declare `user: "root"` and run during
the image build, not as container PID 1, so a non-root service user cannot
starve them.

## How Apache was fixed

Apache's launcher no longer writes anything. The same directives it used to
write into `/usr/local/apache2/conf/extra/lando-webroot.conf` are passed to
`httpd-foreground` as repeated `-c` arguments. Apache reads those arguments as
consecutive lines of one synthetic configuration stream at the stage that
previously processed `-c 'Include ...'`, so a `<Directory>` section spans the
arguments exactly as it spanned the file's lines and the resulting configuration
is unchanged.

The launcher also overrides `PidFile` to `/tmp/lando-httpd.pid`. Apache's
compiled default resolves under the root-owned `/usr/local/apache2/logs`, and
`httpd` exits when it cannot create its pid file, so the override is the second
half of removing root from the start path.

The same two moves do not transfer verbatim to the other rows. Nginx and
php-fpm read a configuration directory rather than accepting arbitrary
command-line directives, and Solr and MinIO write into data trees whose
ownership is a storage question. Each needs its own decision, which is why they
are recorded here rather than batched into one change.

## How the Apache-served PHP launcher was fixed

The PHP image is Debian's Apache, not the Alpine `httpd` layout, so the same
directives needed one extra move. `apache2.conf` reads
`IncludeOptional sites-enabled/*.conf` and the package ships `000-default.conf`
enabled, whose `<VirtualHost *:80>` pins `DocumentRoot /var/www/html`. A `-c`
directive is applied after the whole configuration tree is read, but it lands on
the main server, and a virtual host keeps its own `DocumentRoot` through the
merge — so a directive alone cannot move the document root while that site is
enabled. A build step retires the enabled site, which leaves the main server
answering every request and makes the launcher's directives the whole
configuration.

No `PidFile` override is needed here, unlike the `apache` row. The PHP image
already creates `APACHE_RUN_DIR` and `APACHE_LOCK_DIR` mode `1777` and hands
`APACHE_LOG_DIR` to `www-data`, so the paths `apache2-foreground` touches before
`exec` are writable by any identity.

## Where the shared error pages live

`/usr/share/lando/errors/403.html` and `404.html` are served by three Lando-owned
web servers. They are produced once, by `landoErrorPagesBuildStep()` in
`src/services/http-errors.ts`, as a build step that runs as root during the
image build. Nothing writes them as PID 1, so a non-root service user never
needs permission on that tree. Each page travels base64-encoded because a
derived build renders the step as a Dockerfile `RUN` and refuses a build-step
token carrying CR or LF; the decoded bytes are byte-identical to the page the
module defines. A launcher that needs the pages installs that one step and then
only references the paths.

## Residual: privileged ports under a non-root user

Removing the writes does not grant a non-root process the right to bind a port
below 1024. Apache still listens on `80` by default, `static:caddy` and
`varnish` do the same, and `net.ipv4.ip_unprivileged_port_start` defaults to
`1024` in a fresh container network namespace. Docker sets that sysctl to `0`
for its containers; Podman does not, so a non-root service that keeps a
privileged port can still fail to bind on a Podman-backed provider even with a
write-free launcher. Apache's image still has `Listen 80`; `port:` only updates
Lando endpoints and the healthcheck. An authored `command:` or `entrypoint:` is
what owns `Listen`.

Two mechanisms were considered and rejected for the service type itself:

- Requesting `cap_add: ["NET_BIND_SERVICE"]` through the Compose extension.
  `findUnsupportedComposeKnob` fails closed when the active provider declares no
  `composeKnobs`, and `@lando/provider-docker` declares none — so this would
  break non-root services on the one provider that does not need the capability.
- Reading provider capabilities inside the feature. `ServiceFeatureContext`
  deliberately exposes no provider or capability accessor; a feature may only
  emit intent.

That leaves the bind to the provider's runtime policy or to an authored
`command:`/`entrypoint:`, not to `port:`.
