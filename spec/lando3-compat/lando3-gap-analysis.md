# Lando 3 → Lando 4 gap analysis

Audit date: 2026-09-05. Compares the Lando 3 surface recorded in [`reference/kitchen-sink.lando.yml`](./reference/kitchen-sink.lando.yml) and [`reference/kitchen-sink.config.yml`](./reference/kitchen-sink.config.yml) (561 real Landofiles, core source) against what Lando 4 **implements in code**: schema accepted *and* planner/provider acts on it. Spec intent does not count. Every `spec/lando3-parity` story is marked passing, so these are gaps that wave did not target, not unfinished work from it.

Status vocabulary: **absent** (no schema, no code), **decoded-only** (schema accepts, nothing reads it), **partial** (exists with a narrower shape), **renamed** (same capability, different key; not a gap, listed only where users will trip), **rejected** (recorded design decision with remediation).

Priority is by how many real Landofiles in the corpus depend on it and whether a user can work around it in Lando 4 today.

## 1. Structural gaps (no Lando 4 analog; change how apps are authored)

| # | Lando 3 | Corpus | Lando 4 today | Gap |
|---|---|---|---|---|
| S1 | **Live recipes.** `recipe: drupal11` + `config:` is expanded on every start; `services.appserver:` deltas merge *over* the injected service. 215/561 files are recipe apps and nearly all of them layer deltas (build steps, env, `overrides`). | 38% | Recipes are init-time scaffolds (`core/src/recipes/builtin/**` write `.lando.yml`; `core/src/recipes/expander.ts` is a stub). After init the recipe has no runtime presence. | Closed: conversion emits ordinary authoring files with producer/options provenance. Explicit regeneration or declarative migration changes structure; runtime recipe expansion and recipe includes remain rejected. |
| S2 | **Tooling option surface.** `options:` (yargs flags: `default`, `alias`, `describe`, `passthrough`, `boolean`, `choices`, `interactive` prompts), positionals declared in the key (`"drupal-update [module]"`), `positionals`/`usage`/`examples`, `user:`, `level: engine`, `disabled`/`false` to remove an injected command, multi-service `cmd: [{svc: cmd}, …]`, `service: :service` dynamic dispatch from an option, trailing `&`. | `options` 54x, multi-service `cmd` 34x, `user` 41x, `level` 13x | `ToolingTaskShape` = `service`, `cmd`/`cmds` (strings only), `description`, `dir`, `env`, `vars`. `landofile/src/tooling-unsupported.ts` **rejects** `user`, `disabled`, `passThrough`, `usage`, `examples`, `interactive`, step objects in `cmds`. Flags/args metadata beyond `deprecated` rejected. `:host` works from events only, not plain `lando <tool>`. | Every real project's custom commands beyond "run X in Y" fail to parse. `commandAliases.disabled` covers disabling aliases, not tooling tasks. Multi-service commands (`install:` running composer in appserver then pnpm in node) have no expression at all. |
| S3 | **Tooling-scoped events.** `pre-<tool>`/`post-<tool>` for every tooling name; `post-db-import` is the canonical Drupal pattern (updatedb, cim, cr after import). Also `pre-/post-restart`. | events 45x; `post-db-import` in most Drupal apps | Closed lifecycle set: `pre/post-{init,start,stop,rebuild,destroy}`. `landofile/src/events.ts` rejects unknown names. No restart hooks. | Drupal/WordPress teams lose their import hook. Workaround: wrap `db:import` in a tooling task that calls the SQL command then the steps, i.e. re-encode by hand. |
| S4 | **Proxy string routes + middlewares.** `proxy.web: [host, host:port, host/path, "*-x.lndo.site", "a.*.b.lndo.site:8080/p"]`; object `{hostname, port, pathname, middlewares: [{name,key,value}]}`, `-secured` suffix; middleware merge by name across layers; `pathname` = PathPrefix **plus stripprefix**. | proxy 120x; string form ~90% of entries | `RouteInput` objects only: `{hostname, scheme, endpoint, pathPrefix}`. Traefik render emits `Host()` + `PathPrefix()` with **no** stripprefix and **no** middleware block. `RouteFilter` contract exists as a kit with no bundled implementation. | Path-based routes (`site.lndo.site/mailpit`) behave differently (backend sees the prefix). Every proxy block needs rewriting to objects. |
| S5 | **Build-step user split.** `build_as_root` / `build` / `run_as_root` / `run` (+`_internal`): four phases × two users, executed by `exec` after the container exists, gated by a config-hash lock. | `build` 152x, `build_as_root` 73x, `run_as_root` 12x, `run` 16x | `build.artifact` (image phase) and `build.app` (post-start with app mounted), single user from `user:`. `build-key.ts` provides the lock. | No per-step root/non-root choice. `build_as_root: [apt-get install …]` followed by `build: [composer install]` (the most common pair in the corpus) needs either a Dockerfile or `sudo` in the image. |
| S6 | **Container env contract.** `LANDO_INFO` (JSON of every service's info incl. DB creds, read by every `settings.lando.php`/`wp-config` in the wild), `LANDO_MOUNT`, `LANDO_APP_PROJECT`, `LANDO_DOMAIN`, `LANDO_HOST_IP`, `LANDO_PROXY_*`, `host.lando.internal` alias. | scripts in most PHP apps reference `$LANDO_INFO` or `$LANDO_MOUNT` | `features/env.ts` sets `LANDO`, `LANDO_APP_NAME`, `LANDO_PROJECT`, `LANDO_APP_ROOT`, `LANDO_PROJECT_MOUNT`, `LANDO_SERVICE_*`, `LANDO_WEBROOT`, `LANDO_HOST_{OS,USER,UID,GID,HOME}`, `LANDO_CA_*`, `LANDO_DB_*`, `LANDO_MAIL_*`. `HOST_INTERNAL_ALIAS` is a constant nobody injects; `LANDO_HOST_IP` is documented, not set. | Existing settings files break on first run under Lando 4. `LANDO_DB_*` is a better contract but there is no bridge. `host.lando.internal` matters for Xdebug `client_host` and any "call the host" script. |
| S7 | **Default mounts and home persistence.** `/app` (with `LANDO_MOUNT`), `/user` = `$HOME`, `/lando` = `~/.lando`, `/helpers`, and a per-service `home_<svc>` volume at `/var/www` so Composer/npm/yarn caches, `~/.gitconfig`, `~/.ssh/config` survive rebuilds. | universal | `/app` only. `lando.storage`/`lando.app-mount` features are no-ops; storage is authored per service. No home volume, no `$HOME` bind. | Rebuild wipes Composer cache; scripts referencing `/user/.gitconfig` or `/helpers/*.sh` break. Home persistence is the one users feel immediately. |
| S8 | **`overrides:` escape hatch**: raw Compose merged last on any service type. | 51x on recipe services alone | First-class Compose keys on the service (good), but the disposition matrix **rejects** `tty`, `stdin_open`, `links`, `network_mode`, `container_name`, volume `consistency`; `logging`/`platform`/`restart`/`extra_hosts` preserved capability-gated. | Interactive containers (`minecraft` uses `tty`+`stdin_open`) cannot be expressed. Otherwise a rename. |

## 2. Service-type option gaps (type exists; option does not)

| Type | Lando 3 option | Corpus | Lando 4 | Notes |
|---|---|---|---|---|
| php | versions **5.6–8.0** | 7.4/8.0 pinned in ~20 real apps (Drupal 7, legacy) | `php:8.1`–`8.5` only, fail closed | Drupal 7 / older sites cannot run at all. |
| php | `via: nginx[:ver]`, `via: apache:2.4` | 56x | `via: apache\|fpm\|cli`, no version; nginx = separate `nginx` service with `backend:` | Recipes handle it; hand-written services need restructuring. |
| php | `composer_version`, `composer: {pkg: ver}` global packages | 46x, 1x | `composer: "2"\|"2.7.7"\|false` version only | Rename + loss of global package install. |
| php | `xdebug: {mode, start_with_request, client_port, config}` | 3x object, 23x bool/string | bool or mode string; object rejected; fixed client host/port | |
| php | `config.php`/`vhosts`/`pool`/`server` file mounts | 16x / 9x / 1x / 6x | generic `configs:`/`mounts:`; no well-known targets | Users must know the container path (`/usr/local/etc/php/conf.d/…`). |
| php | `COMPOSER_MEMORY_LIMIT=-1`, `COMPOSER_ALLOW_SUPERUSER` defaults, drush/wp-cli launchers | implicit | not set | Composer OOM on first `composer install` is a predictable support ticket. |
| node | `globals: {pkg: ver}` (npm -g) | 32x | absent | Very common (`gulp-cli`, `yarn`, `pnpm`, `turbo`). |
| node | `port` | 31x | schema field exists; `node.ts` hardcodes 3000 for endpoints | decoded-only. |
| node | versions | 16/18/20/22 pinned | `node:lts`, `node:22` only | 16/18/20 fail closed. |
| mysql/mariadb/postgres/mongo | `portforward: true\|3307` | 44x | `ports:` publishes; no `portforward` key; random assignment via empty published | `portforward: 3307` (stable port for TablePlus etc.) is a rename; `true` works. |
| mysql/mariadb | `authentication: mysql_native_password` | 3x | absent | |
| all DBs | `config.database` (my.cnf / postgresql.conf / mongod.conf) | 10x | generic mounts only | |
| redis | `password`, `persist`, `config.server` | 7x, 1x, 1x | absent; AOF always on | |
| memcached | `mem` | 1x | absent | |
| elasticsearch/opensearch | `mem`, `plugins: [analysis-icu]` | 1x each | heap hardcoded 512m; no plugin install | |
| solr | `core`, `config.dir` (search_api_solr conf), versions 3.x–8 | 6x, 13x | `cores: []`, no conf dir, `solr:9` only | `config.dir` is required by every Drupal Solr site. |
| mailpit / mailhog | `mailFrom`/`sendFrom`/`hogfrom` (rewrite the PHP `sendmail_path` of listed services), `maxMessages` | 9x, 11x, 3x | `LANDO_MAIL_HOST/PORT` env only; no typed target/opt-out field | US-618C adds exact selected-PHP wiring; `maxMessages` lowers to explicit `MP_MAX_MESSAGES`. |
| phpmyadmin | `config.config` | 4x | absent | |
| nginx / apache | `config.server`/`vhosts`/`params`, `build_as_root` | 6x, 9x, 11x | absent; nginx generates conf only when `backend:` set | `apache.ts` hardcodes `webroot: /app` and ignores authored `webroot` (bug). |
| varnish | multiple `backends`, `backend_port` | 1x | single `backend`, port via env | |
| tomcat/python/ruby/go/dotnet | versions | few | one or two pinned versions each | fail closed on others. |
| compose | nested `services:` block (Lando-typed wrapper around a literal Compose service) | 12x (+83x via `type: lando` api 3) | `type: compose` is a single flat service | Shape change; content maps 1:1 after lifting. |
| hoster/derived types | `pantheon-mariadb`, `lamp-php`, `drupal-php`, `*-mysql` | ~10x | absent | Recipe-internal in L3; users pinned them to override. Map to canonical types. |
| api-4 `lando`/`l337` | image object (`imagefile`, `tag`, `buildx`, `buildkit`, `ssh`, `args`, weighted `groups`/`steps`, `context` with owner/perms/URL), `mounts` `contents:`/`group: config`, storage `scope: project`, `type: image`, `packages: {git, ssh-agent, sudo}`, `moreHttpPorts`, `sport`, `sslExpose`, ports `8080/http` | core/plugin tests only; ~5 real apps | `image: string` + Compose `build:` subset (build `ssh` rejected); `mounts` bind/tmpfs/volume; storage service\|app\|global; `certs`; endpoints carry protocol | Low corpus weight. `build.ssh` rejection matters for private git deps at image-build time. |

## 3. Global config and CLI gaps

| Lando 3 | Corpus/usage | Lando 4 | Status |
|---|---|---|---|
| `proxy: "OFF"` | the one key most users have set | `router.enabled` on `RouterConfig` | **decoded-only**; nothing reads it. `lando setup --skip-proxy` is setup-time only. |
| `appEnv:` / `appLabels:` (global env/labels into every container) | CI + team configs | absent | Use per-service `environment`; no global injection point. `agentEnv` is host→tool, not container. |
| `landoFile` / `preLandoFiles` / `postLandoFiles` custom names | rare, but `landofile-custom` is a supported L3 feature | fixed basenames in `landofile/src/layers.ts`; config schema comment says "modeled elsewhere" | absent |
| `.lando.recipe.yml` layer | used by downstream template repos (`drupal-recipe-*`) | layers: base, dist, upstream, canonical, local, user | conversion-only source folded at its real interval; it is not added to native loading |
| `keys: false \| [files]`, `~/.lando/keys`, passphrase-less key warning | 1x explicit; implicit everywhere | ssh-agent sidecar loads `~/.ssh` defaults; `engine/src/subsystems/ssh/api.ts` is a stub | partial |
| `plugins:` / `pluginDirs:` per-app pins | 373x (mostly plugin repos pinning themselves; ~15 real apps pin `@lando/mailpit` etc.) | not on `LandofileShape`; `appPluginsDir` exists on disk | absent as authored key |
| `channel: none` (disable update checks), `edge` | some | `update --channel stable\|next\|dev`; no config key | partial |
| `networkLimit`, `engineConfig`, `orchestrator*`, `dockerSupportedVersions`, `experimental`, `logDir`, `logLevelConsole`, `maxKeyWarning`, `disablePlugins`, `pluginConfig` (registry auth) | rare | absent / deferred (`plugin:login` is 4.1) | Mostly redesigned away (providers replace `engineConfig`; compose pin is internal). `pluginConfig` for private registries is a real 4.1 gap for enterprise users. |
| `LANDO_<ANYKEY>` env override | CI | `LANDO_<UPPER_SNAKE_KEY>`; nested maps as JSON values (§7.6) | renamed |
| `lando rebuild -s <svc>` | common | rebuild all only | absent |
| `lando info --service X`, `--filter`, `--deep` (docker inspect) | scripts | `--deep` = agent-env audit; no service/filter | partial; output shape redesigned (no `internal_connection`/`external_connection`/`hostnames`; creds redacted), so scripts that `lando info --format json \| jq` break |
| `lando logs -t` | some | timestamps only as log-source metadata | absent flag |
| `lando version --all/--component` | scripts | core+bun+platform | absent |
| `lando list` deletes orphans whose Landofile is gone | implicit | no orphan GC for user apps | absent |
| `-v` = verbose | muscle memory | `-v` = `--version` | **hazard**, not a gap |
| `--clear`, `--experimental`, `--secret-toggle`, `LANDO_ENTRYPOINT_NAME` | rare | `app:cache:refresh`; others absent | fine |
| `lando share` | some | API present, no bundled tunnel (4.1) | deferred |
| `lando pull`/`push`, hoster recipes/inits (pantheon 14x, platformsh 55x, acquia 11x, lagoon 3x) | 15% of corpus | `RemoteSource` contract frozen, 4.1 | deferred by decision; noted because it is the single largest cohort that cannot move |
| `lando init --source pantheon\|github`, `--webroot` | common | `--source git\|tarball\|npm\|registry`, `--answer webroot=` | partial |
| Post-start URL scanner ("visit your app at …", `scanner: {okCodes, path, retry}`, 79x `scanner: false`) | universal UX | `UrlScanner` exists, used by doctor; `start` does not call it; no `scanner:` service key | absent from start; the readiness signal users rely on is gone |

## 4. Renamed, not missing (document, do not build)

`env_file` (same), `excludes` → `appMount.excludes`, `app_mount` → `appMount`, `working_dir` → `workingDirectory` (alias accepted), `depends_on` → `dependsOn` (alias accepted), `hostnames` (same), `primary` (same), `certs` (same), `security.ca` (same), `healthcheck` (same, command kind), `creds` (same), `type: php:8.3` (same spelling), top-level `compose:` → `includes: [{kind: compose}]`, `x-*` (same), anchors (same), `!load`/`!import` tags → `{{ load() }}`/`{{ import() }}` expression helpers (§7.3; translator rewrites), Landofile layers (same minus `.lando.recipe`), `domain` → `proxy.defaultDomain`, `bindAddress` → `router.bindAddress`, `stats` → `telemetry.enabled`, `logLevel` (same), `lando config` (same), `db-import/export` → `db:import/export` (`@lando/sql`), `ssh -c` → positional command, proxy fallback ports (same idea, longer list), Landonet `<svc>.<project>.internal` (same), Windows pipe / Intel Mac (handled).

## 5. Closed disposition and owners

The coordinated PRDs close the product calls. No item below is left for an implementation agent to decide.

| Gap | Decision | Owning story |
|---|---|---|
| S1 live recipes | Decompose to ordinary files with inert producer provenance; refresh through declarative snapshot migrations, never runtime expansion. | US-609B, US-609E0, US-609E1..US-609E6, US-609E, US-611B |
| S2 tooling | Normalize one flag/arg schema for CLI, MCP, index, and cache; execute ordered service/host/user/dir steps. | US-613 |
| S3 events | Extend dynamic task names before semantic validation; bound nested recursion and make post-step failure fatal. | US-614 |
| S4 routes | Normalize shorthand and ship explicit provider-neutral filters; never strip prefixes implicitly. | US-615 |
| S5 build users | Resolve users in planning, propagate to build/provider steps, restore final USER, and hash resolved users. | US-616 |
| S6 env | Add host reachability only. Remove aggregate credential-bearing `LANDO_INFO`; add no `LANDO_MOUNT`; provide settings-script migration checks and guidance. | US-617A, US-621C5, US-621C8 |
| S7 home | Add planned-user home persistence with opt-out. Do not restore legacy `/lando`, `/helpers`, or `~/.lando` mounts. | US-617A |
| S8 overrides | Preserve supported first-class fields; continue fail-closed rejection for `tty`, `stdin_open`, `links`, `network_mode`, and `container_name`. | US-621C1, US-621C8 |
| Router/scanner | Honor router disablement and run bounded post-start probes. | US-617B |
| Catalog file options | Add Solr and database config mounts. | US-618A |
| Node/PHP packages | Add Node globals and additive Composer object form. | US-618B |
| Redis/Mailpit | Add password/persistence and PHP sender wiring. | US-618C |
| `rebuild -s`, `info --service` | Add native service-scoped rebuild and info options; do not emulate legacy output filters or raw inspect. | US-618D1 |
| `appEnv`, `appLabels` | Add bounded v4 global maps for user-app services with generated env reservations and `dev.lando.*` label reservation; never import legacy global state. | US-618D3 |
| Apache/Node and versions | Honor webroot/port; publish supported versions and reject unavailable old runtimes. Do not manufacture old images. | US-618E |
| Custom basenames/user state | Remain unsupported; explicitly supplied settings receive diagnostics only. | US-620B, US-622B |
| Layer fidelity | Require final effective equivalence; preserve prefixes where representable and diagnose minimal-unit hoisting where delete semantics make a prefix impossible. | US-621A |
| Hoster/pull/push/share/private registry | Intentional rejection or existing later-wave deferral with remediation; no runtime emulation. | US-621A, US-621C8, US-622B |

## 6. Residual option disposition

Every catalog and command variant not owned by a native IR story has a closed conversion result. `target` means explicit v4 authoring output, `drop` means a `dropped` or `needs-review` diagnostic with remediation, and `unsupported` blocks conversion of the affected service or app.

| Legacy variant | Disposition | Exact result | Owner |
|---|---|---|---|
| PHP 5.6 through 8.0 and any absent service version | unsupported | Reject against generated ServiceType version metadata; do not manufacture images. | US-618E, US-621C1 |
| PHP `via: nginx` | target | Emit separate nginx service with backend reference; preserve supported apache/fpm/cli directly. | US-621C1 |
| PHP xdebug object | target/drop | Map supported mode/start/port fields; diagnose each unknown config key, never retain a residual object. | US-621C8 |
| PHP config.php/vhosts/pool/server | target | Emit read-only generic config mounts at the owning catalog's documented container paths. | US-621C1 |
| Lando 3 implicit Composer environment and launchers | drop | Emit migration guidance; do not add hidden environment or launchers. | US-621C8 |
| MySQL/MariaDB `authentication` | target | Emit the equivalent explicit server option in the generated `99-lando.cnf`. | US-621C1 |
| Memcached `mem` | target | Emit the catalog memory command argument. | US-621C8 |
| Elasticsearch/OpenSearch `mem` and plugins | target/unsupported | Map heap memory; reject plugin installation until a native catalog field exists. | US-621C8 |
| Solr core/config and versions | target/unsupported | Map cores and US-618A config directory; reject versions absent from generated metadata. | US-621C1 |
| Mailpit/MailHog sender fields and `maxMessages` | target | Normalize sender selection to `mailFrom`; emit explicit `MP_MAX_MESSAGES` environment for the Mailpit service. | US-621C1 |
| phpMyAdmin config | target | Emit a read-only generic config mount at `/etc/phpmyadmin/config.user.inc.php`. | US-621C1 |
| nginx/apache server/vhost/params config | target/drop | Emit documented server/vhost mounts; diagnose unsupported params individually. | US-621C1 |
| Varnish multiple backends | unsupported | Reject rather than choose one backend. | US-621C8 |
| API-4 image object/build ssh/context URL or ownership and mount contents/config groups | target/drop/unsupported | Map supported image/build/mount fields, reject remote contexts and build ssh, and diagnose unsupported ownership/content fields individually. | US-621C1, US-621C8 |
| `moreHttpPorts`, plugin pins/dirs, keys, tooling level/usage/examples/interactive/background | drop | Emit one source-span diagnostic per field with the named native/manual alternative. | US-621C3, US-621C8 |
| rejected Compose `tty`, `stdin_open`, `links`, `network_mode`, `container_name`, volume consistency | unsupported | Block the affected service; do not silently drop execution-shaping fields. | US-621C1 |
| `lando info --filter/--deep`, log `-t`, version component flags, orphan GC | drop | Emit command-transition guidance; do not emulate raw inspect or legacy output shapes. | US-621C8 |
| custom basenames, app plugin pins, legacy keys/user state/global CLI history | drop | Diagnose only explicitly supplied input; never read `~/.lando`. | US-620B, US-621C8 |
| pull/push/share/hoster recipes/private registry | unsupported | Reject with the existing later-wave/native replacement guidance; no network or hoster code runs. | US-621A, US-621C8 |

Successful translation fixtures cover only supported versions and representable capabilities. Ambiguous valid-v4-shaped legacy documents are explicit-only inputs. Unsupported versions, hosters, malformed YAML, unsafe tags/aliases, and rejected Compose fields remain intentional rejection fixtures. Corpus presence is evidence for diagnostics and prioritization, not a promise that every fixture converts successfully.
