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

Every row in the table has been checked the same way, and a newly added default
command should be checked the same way before its row is written. Put the
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

A launcher that still assumes root exits during start. The logs carry the
launcher's own error, a permission denial on the write target in the table,
rather than a daemon error. A launcher that survives goes in the table as
`works`; one that does not gets a row describing the write target and a fix
section below.

## Audit

| Service type / mode | Source | Runtime write targets | Non-root `user:` | Status |
| --- | --- | --- | --- | --- |
| `apache` | `src/services/apache.ts` `apacheStartCommand` | none | works | **fixed** |
| `php:*` via `apache` (default) | `src/services/php-via.ts` `apacheStartCommand` | none | works | **fixed** |
| `php:*` via `fpm` | `src/services/php-via.ts` `fpmStartCommand` | `/tmp/lando-php-fpm.conf` | works | **fixed** |
| `nginx` with `backend:` | `src/services/nginx.ts` `phpFastcgiCommand` | `/tmp/lando-nginx.conf` | works | **fixed** |
| `static` / `static:nginx` | `src/services/static.ts` `defaultStaticCommand` | `/tmp/lando-nginx.conf` | works | **fixed** |
| `solr` with `cores:` | `src/services/solr.ts` | `/var/solr/data/<core>/conf`, under a `/var/solr` tree prepared in the image for the planned user | works | **fixed** |
| `minio` | `src/services/minio.ts` | `mkdir` under `/data`, a tree prepared in the image for the planned user | works | **fixed** |
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

The same two moves do not transfer verbatim to every row. Nginx and php-fpm
took a different shape, described below: neither accepts arbitrary
command-line directives, so each is pointed at a whole file under `/tmp`
instead. Solr and MinIO write into data trees that live on named volumes, so
moving the write was never an option there; the tree's ownership is set in the
image instead, described in its own section below.

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

## How the nginx-family launchers were fixed

`nginx` with `backend:` and `static` / `static:nginx` used to write a server
block into `/etc/nginx/conf.d/default.conf`, which is root-owned on the image.
Each launcher now writes a complete nginx main configuration to
`/tmp/lando-nginx.conf` and runs `nginx -c /tmp/lando-nginx.conf -g 'daemon off;'`.

The generated file is a whole configuration rather than a `conf.d` snippet
because `-c` replaces the main configuration file; there is no flag that adds
one more include. The file follows the image's own `nginx.conf` with three
deltas:

- `pid /tmp/lando-nginx.pid;`. The compiled default lives under `/var/run`,
  which a non-root master cannot create.
- Five flat temp paths under `/tmp`: `lando-nginx-client-body`, `-proxy`,
  `-fastcgi`, `-uwsgi`, and `-scgi`. They are flat on purpose. nginx creates
  each temp directory with a single `mkdir`, not `mkdir -p`, so a nested path
  such as `/tmp/lando-nginx/client-body` fails at startup when the parent is
  missing.
- The Lando `server { }` block inlined where the image had
  `include /etc/nginx/conf.d/*.conf;`.

`-c` makes the configuration file's own directory the configuration prefix, so
every `include` in the generated file names an absolute path. A bare
`include fastcgi_params;` would resolve to `/tmp/fastcgi_params` and nginx would
refuse to start. The image's `access_log` and `error_log`
targets are symlinks to the container's stdout and stderr, so any identity can
open them and no log path needed to move.

`user nginx;` is emitted only when Lando planned a root service. Under a
non-root master nginx ignores the directive and prints a warning on every
start, so the launcher leaves it out in that case rather than ship a known
warning.

Verified against the real image: as uid `101`, a static site serves `200` with
`Content-Type: text/html` and a missing path serves the Lando 404 page.

## How the FPM launcher was fixed

`php:*` via `fpm` used to write its `listen` override into
`/usr/local/etc/php-fpm.d/zz-lando-listen.conf`, also root-owned. The launcher
now writes `/tmp/lando-php-fpm.conf` and runs
`php-fpm -y /tmp/lando-php-fpm.conf`.

The generated file is two parts: `include=/usr/local/etc/php-fpm.conf`, then a
`[www]` section carrying `listen = <port>`. The image's own `php-fpm.conf` is
only `[global]` plus an absolute `include=/usr/local/etc/php-fpm.d/*.conf`, so
including it pulls the whole stock tree in unchanged. `[www]` is already
declared by three of the bundled files; re-opening the pool merges into the
same pool, and the later `listen` wins.

Under a non-root master php-fpm logs that the pool's `user` and `group`
directives are ignored. That is a notice, not a failure, and the right response
is to leave it alone. Silencing it by writing into `php-fpm.d` would put the
root-owned write back.

Verified against the real image: as uid `33`, php-fpm listens on the authored
port.

## How the Solr and MinIO data trees were fixed

Both launchers write into a named volume at start: Solr's `precreate-core` and
the `config.dir` overlay copy under `/var/solr`, MinIO's bucket `mkdir` under
`/data`. Those writes cannot move to `/tmp`; the volume is the point. So the
fix changes who owns the tree rather than where the write goes.

When a service plans a `user:` that the image does not already seed ownership
for, the service type adds one root build step that creates the data tree and
chowns it to that user. A container runtime seeds a fresh named volume from the
image directory at the mount path, ownership included, so the planned user
owns the tree from the first start and the launcher's write succeeds.

The step is emitted only when it is needed. Solr's image ships `/var/solr`
owned by `solr` (uid `8983`), so `solr`, `8983`, `root`, `0`, and the default
plan get no build step and no rebuild. MinIO's image runs as root and declares
only `root`; its `/data` is a bare `VOLUME` with nothing behind it, so any
non-root user gets the step and `root` or the default plan gets nothing.

A numeric uid is always accepted, because a uid can always be given ownership.
A user name is accepted only when the service type declares it for its image.
When the planner cannot know the user exists, because the name is undeclared or
because the Landofile supplies its own `image:` or `build:` so the type's
identity no longer describes the container, it refuses during planning with a
`DataTreeOwnershipCapabilityError`. The error names the service, the mounted
data tree (`target`), and the fully qualified Landofile option that has to
change, and it fires before any provider action.

Two limits:

- An existing volume is not repaired. The runtime seeds ownership only when it
  creates the volume, so a volume left by an earlier start keeps whatever
  ownership it already has until it is removed.
- MinIO's `/data` sits under the base image's own `VOLUME` declaration, so the
  fix relies on the builder preserving writes beneath an inherited `VOLUME`.
  Verified preserved on the Lando-managed Podman provider through its `/build`
  endpoint, with byte-identical image ids with and without
  `compatvolumes=false`. Docker's classic builder discards such writes, so a
  derived build there would need BuildKit.

Verified against the real images on Podman 6.0.1: as uid `10001`, Solr
precreates its cores and applies a `config.dir` overlay, and MinIO creates its
bucket and serves. One host-side requirement surfaced for Solr: the
`config.dir` directory is bind-mounted read-only, so it has to be readable by
the planned user. A `0700` host directory is not, and `0755` is.

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
below 1024. `static:caddy` and `varnish` still listen on `80` by default, and
`net.ipv4.ip_unprivileged_port_start` defaults to `1024` in a fresh container
network namespace. Docker sets that sysctl to `0` for its containers; Podman
does not, so a non-root service that keeps a privileged port can still fail to
bind on a Podman-backed provider even with a write-free launcher.

`nginx`, `static`, `apache`, and `php:*` via `apache` derive their listener
from `port:`, so the residual has an author-side answer there: set `port: 8080`
(or any port at or above 1024) and the non-root master binds it. `nginx` and
`static` template `port:` into the generated `listen` directive. `apache` emits
`Listen <port>` as a `-c` directive and deletes the image's `Listen 80` from
`/usr/local/apache2/conf/httpd.conf` during the image build; `php:*` via
`apache` emits `Listen <port>`, wraps the generated document-root, directory,
and error-page directives in `<VirtualHost *:<port>>`, and deletes the image's
`Listen 80` from `/etc/apache2/ports.conf` during the build. Without an
authored `port:` neither type changes its launcher, image, or build steps. An
authored `command:` or `entrypoint:` skips the generated launcher and the image
edit, so that launcher owns `Listen`. A custom `image:` on `php:*` does the same.
A custom `image:` on `apache` still gets the generated start command, but skips
`Listen` and the image edit, because that image may not ship `httpd.conf`.
`php:*` via `fpm` listens on `9000` and never had the problem.

Two mechanisms were considered and rejected for the service type itself:

- Requesting `cap_add: ["NET_BIND_SERVICE"]` through the Compose extension.
  `findUnsupportedComposeKnob` fails closed when the active provider declares no
  `composeKnobs`, and `@lando/provider-docker` declares none — so this would
  break non-root services on the one provider that does not need the capability.
- Reading provider capabilities inside the feature. `ServiceFeatureContext`
  deliberately exposes no provider or capability accessor; a feature may only
  emit intent.

For `static:caddy` and `varnish` that leaves the bind to the provider's
runtime policy or to an authored `command:`/`entrypoint:`, not to `port:`.
