# Lando v4 — Service Specification

> **Part 6 of 18** · [Index](./README.md)
> **Read next:** [07 Landofile and Configuration](./07-landofile-and-config.md)

This part defines what a v4 service is and how it is composed. A v4 service is a planned runtime component built from a **base** plus a sequence of composable **features**. Two bases ship with core: `l337` (raw artifact, the escape hatch) and `lando` (opinionated dev service with boot scaffolding, env layer, packages, app mounts, healthchecks, certs, SSH agent, and run hooks).

Covered here: the model and `api: 4` policy, the common service schema with supported Compose service keys, the provider-neutral artifact build with the group-weighted instruction model, app mounts and mounts (including excludes/includes semantics), storage scopes and auto-naming, endpoints/hostnames/routes with provider-neutral route filters, healthchecks, certificates and additional CA injection via `security.ca:`, the standard `LANDO_*` environment variable contract, the `ServiceInfo` schema returned by `lando info`, the `ServiceType` + `ServiceFeature` contracts (with the built-in feature priority list from `@lando/service-lando`), and the canonical service-type catalog that ships in core (PHP, Node, Python, Ruby, Go runtimes; nginx/apache; MariaDB/MySQL/PostgreSQL; Redis/Memcached/Valkey; Solr/Elasticsearch/OpenSearch/Meilisearch; Mailpit/Mailhog; RabbitMQ; MinIO/LocalStack; static; raw Compose passthrough).

---

## 6. v4 Service Specification

### 6.1 Model

A v4 service is a planned runtime component built from a **base** plus a sequence of composable **features**. Two bases ship with core. Plugins compose features onto a base to produce service types like `php`, `node`, `postgres`, etc.

**Built-in service bases:**

| Base | Purpose |
|---|---|
| `l337` | Low-level artifact-oriented service. Provides artifact-build plumbing and nothing else. No `/etc/lando/*` scaffolding, no opinionated env, no packages. The escape hatch. |
| `lando` | Opinionated dev service. Adds boot scaffolding, an env layer, packages, container-time build steps, app mounts, healthcheck integration, certs, SSH agent, and run hooks. Default when `type:` is omitted. |

`api: 4` is the only service API in this spec. Core defaults `api` to `4` when omitted, *after* the Landofile has confirmed it targets v4. There is no `api: 3` compatibility path.

**Provider selection.** A service inherits the app's provider. Per-service provider selection is non-portable; plugins may consume it via `services.<name>.providers.<id>` extensions. `ServicePlan.provider` is the resolved app provider, copied onto each planned service for adapter convenience.

### 6.2 Common service schema

`ServiceConfig` accepts the documented Compose service-key subset (§7.4) at the same level as Lando's additional keys. Lando-specific keys are conveniences or higher-level intent; they do not make supported Compose keys invalid. Unsupported Compose service keys fail validation unless they are moved under a provider extension that explicitly owns them.

Core normalizes Compose service keys with portable equivalents before creating a `ServicePlan`:

- `image:` / Compose `build:` map into the service artifact model when the selected provider can build or pull artifacts.
- `command:`, `entrypoint:`, `user:`, `working_dir:`, `environment:`, and `env_file:` map directly to execution and environment fields.
- `volumes:` entries map to `mounts` or `storage` depending on whether the source is a host path, named volume, or anonymous volume.
- `ports:` and `expose:` map to `endpoints`; `ports:` with host bindings require the provider's host-port capability.
- `depends_on:` maps to `dependsOn` and is used for lifecycle ordering.
- Supported `networks:`, `configs:`, `secrets:`, `labels:`, `profiles:`, and `deploy:` forms are accepted. Fields in the supported subset without provider-neutral semantics are preserved in `ServicePlan.extensions.compose` and capability-checked per §5.5.1.

Lando aliases such as `workingDirectory`, `envFile`, `appMount`, `mounts`, `storage`, `endpoints`, `routes`, `certs`, `security`, and `packages` remain available as extensions. When both a Compose key and its Lando simplification are present, the more specific Lando key wins during normalization and `lando config` SHOULD report the resolved value.

Effect Schema definition (illustrative; final schema lives in `@lando/sdk`):

```ts
export const ServiceConfig = Schema.extend(ComposeServiceConfig, Schema.Struct({
  api: Schema.optional(Schema.Literal(4)),
  type: Schema.optional(Schema.String),         // defaults to "lando"
  primary: Schema.optional(Schema.Boolean),

  artifact: Schema.optional(ArtifactInput),
  command: Schema.optional(CommandInput),
  entrypoint: Schema.optional(CommandInput),
  user: Schema.optional(UserInput),
  workingDirectory: Schema.optional(PortablePath),
  environment: Schema.optional(EnvironmentInput),
  envFile: Schema.optional(Schema.Array(Schema.String)),

  appMount: Schema.optional(AppMountInput),
  mounts: Schema.optional(Schema.Array(MountInput)),
  storage: Schema.optional(Schema.Array(StorageInput)),

  endpoints: Schema.optional(Schema.Array(EndpointInput)),
  routes: Schema.optional(Schema.Array(RouteInput)),

  healthcheck: Schema.optional(HealthcheckInput),
  certs: Schema.optional(CertsInput),
  hostnames: Schema.optional(Schema.Array(Schema.String)),
  security: Schema.optional(Schema.Struct({
    ca: Schema.optional(Schema.Array(CaInput)),
  })),

  build: Schema.optional(Schema.Struct({
    artifact: Schema.optional(BuildScript),
    app: Schema.optional(BuildScript),
  })),

  packages: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),

  providers: Schema.optional(Schema.Record({ key: ProviderId, value: Schema.Unknown })),
}));
```

**Top-level Landofile excerpt** (informative):

```yaml
services:
  app:
    api: 4
    type: lando
    primary: true

    artifact: nginxinc/nginx-unprivileged:1.27
    command: "{{ load('scripts/start.sh') | text }}"
    user: nginx
    environment:
      APP_ENV: development
    env_file:
      - .env

    app-mount: /app
    mounts:
      - source: ./config
        target: /etc/myapp
        type: copy
    storage:
      - /var/lib/data
      - destination: /shared
        scope: app
        type: volume

    endpoints:
      - 8080/http
      - 8443/https
      - port: 5432
        protocol: tcp
        bind: 127.0.0.1

    routes:
      - app.lndo.site
      - hostname: admin.lndo.site
        endpoint: 8080/http
        pathname: /admin
        tls: true

    healthcheck:
      command: curl -fsS http://localhost:8080/health
      retry: 25
      delay: 1000

    certs: true
    hostnames:
      - extra.app.lndo.site

    security:
      ca:
        - ./certs/CorpCA.crt
        - "{{ load('other-ca.pem') }}"

    build:
      artifact: |
        RUN apt-get update -y && apt-get install -y curl
      app: |
        npm ci

    packages:
      git: true
      ssh-agent: true
      sudo: true

    providers:
      docker:
        labels:
          example.com/team: platform
```

### 6.3 Artifact build (provider-neutral)

`artifact:` describes how to obtain or produce the runnable asset for a service. Container providers translate it to image build/pull. VM providers translate it to template selection or disk creation. Remote providers may translate it to a deployment manifest reference.

**Supported forms:**

```yaml
# Existing artifact reference (image tag, template name, etc.)
artifact: nginxinc/nginx-unprivileged:1.27

# Build from a sourcefile (e.g. Containerfile or VM template)
artifact:
  sourcefile: ./Containerfile
  context: ./

# Inline build instructions, group-weighted
artifact:
  source: scratch
  tag: my-app:dev
  context:
    - ./assets:/app/assets
    - source: ./scripts
      destination: /usr/local/bin
      owner: 1000:1000
      permissions: "0755"
  args:
    NODE_VERSION: "20"
  secrets:
    - { id: npmrc, source: ~/.npmrc }
  ssh:
    agent: true
    keys: ["~/.ssh/id_ed25519"]
  platform: linux/amd64
  groups:
    - { name: system, weight: 200, user: root }
    - { name: tooling, weight: 400, user: root }
    - { name: user, weight: 2000 }
  steps:
    - { instructions: "RUN apt-get update -y", group: system }
    - { instructions: "RUN apt-get install -y curl jq", group: system, weight: 1 }
    - { instructions: "USER node\nRUN npm i -g pm2", group: user }
```

**Group-weighted instruction model.** Adopted from SPEC2's L337 builder. A v4 artifact is assembled from groups (named, weighted, user-scoped) and steps (instructions assigned to a group). Final ordering is by group weight + step weight. Service types, features, fragments (§7.7), and the user's Landofile contribute steps into named groups; users override or extend. (Recipes do not contribute steps at runtime — they are init-time scaffolds that produce a Landofile, which then contributes through the normal mechanisms.)

Group override syntax `<group>[-<offset>][-{before|after}][-<user>]`:

- `system-4` → group `system`, offset `+4`.
- `system-3-after` → group `system`, offset `+3`.
- `system-10-before` → group `system`, offset `-10`.
- `system-nginx-after-4` → group `system`, user `nginx`, offset `+4`.

**Provider neutrality rules:**

- `sourcefile:` is the canonical Lando key for any external build definition file. Compose `build.context`, `build.dockerfile`, and related build fields are accepted as input and normalized when possible; provider-specific aliases beyond the Compose spec live in provider extension schemas.
- Build-time secrets and SSH require the provider's `buildSecrets` / `buildSsh` capabilities; planning enforces this.
- Artifact tags are not assumed to be globally meaningful or pushable.
- Compose `image:` is accepted as input and normalized into `artifact:`. `artifact:` remains Lando's provider-neutral spelling in the resolved config and plan.

### 6.4 App mounts and mounts

**App mount** is a convenience for binding the project root into a service. `appMount:` accepts:

- `false` / `disabled` — no mount; `workingDirectory` falls back to a service-specific default.
- A string — bind to that destination.
- An object — full `MountInput` with `source`, `destination`, `type`, `excludes`, `includes`, etc.

When active, the planner sets `workingDirectory`, exports `LANDO_APP_ROOT` and `LANDO_PROJECT_MOUNT`, and records `appMount` on the resulting `ServiceInfo`.

**Mounts** are a list of additional mount entries. Each entry is normalized to a `MountPlan`.

```yaml
mounts:
  # Bind, string shorthand
  - "./config:/etc/myapp:ro"

  # Object form
  - source: ./scripts
    destination: /etc/lando/service/helpers
    type: copy

  # Inline content (literal — bytes are written as-is)
  - destination: /etc/myapp/generated.yml
    type: inline
    content: "{{ load('config.yml') | text }}"

  # Template content (rendered through a TemplateEngine before writing)
  - source: ./config/vhost.conf.hbs
    destination: /etc/apache2/sites-available/000-default.conf
    type: template
    engine: handlebars                    # optional; inferred from file extension
    vars:
      docroot: /app/web
      port: 8080
    mode: "0644"                          # optional; POSIX file permissions

  # Bind with excludes (creates volume shadows for excluded subpaths)
  - source: ./
    destination: /app
    type: bind
    excludes:
      - node_modules
      - depth1/depth2
      - "!depth1/depth2/test4"   # re-include
```

**Mount types:**

| Type | Meaning | Provider capability |
|---|---|---|
| `bind` | Live-mount host path | `bindMounts` |
| `copy` | Copy host path into the artifact at build time | `copyMounts` |
| `inline` | Write literal content to the destination | (always supported) |
| `template` | Render a template file through a `TemplateEngine` (§7.3.2) and write the result to the destination | (always supported — materializes to `inline` after render) |
| `disabled` | Explicitly disables an inherited mount | (no-op) |

**Template mount semantics:**

- `source:` is a host-side path to the template file, resolved relative to the app root. The same security rules as local `includes:` (§7.7.6) apply: the path must stay under the app root unless `--allow-include-outside-root` is set.
- `engine:` is the `TemplateEngine` id (§4.2, §7.3.2). When omitted, the engine is selected by file extension; when no extension matches, the `lando` engine is used.
- `vars:` is an object that becomes the `vars.<key>` scope of the template's render context (§7.3.1, §7.3.2). Values inside `vars:` themselves go through the standard expression resolver, so `vars: { x: "${env.X}" }` and `vars: { x: "{{ env.X }}" }` both work.
- `mode:` (octal string) sets POSIX file permissions on the rendered output. Ignored on Windows hosts.
- The template's effective bootstrap level is the maximum across every scope its content references (§7.3.1). A template that references `service.endpoints[0].port` is rendered by the planner at level `app`; a template that references only `env.*` and `vars.*` could be rendered earlier but is still deferred to the mount materializer in practice.
- After rendering, the resulting `MountPlan` is `type: inline` with the rendered text as `content:`. Providers see only `inline` mounts; no provider-side support for `template` is required.
- Render output is cached at `<userCacheRoot>/templates/<engineId>/<contentHash>-<varsHash>.bin` (§12.1 `template-render` cache). Re-renders are skipped when neither the template content nor the resolved `vars:` change.

**Excludes/includes semantics** (preserved from SPEC2 with provider-neutral phrasing):

- A bind with `excludes:` becomes the primary bind plus one `volume`-type storage shadow per excluded path. Volumes shadow the bind, effectively excluding the excluded paths from live host sync.
- Entries starting with `!` are includes. Each include re-binds that path back over the volume shadow.
- A copy with `includes:` becomes the primary copy plus one bind per included path.
- Excludes are applied in ascending depth order so deeper excludes are created after shallower ones.

**Mount realization (`passthrough` vs `accelerated`).** A `MountPlan` of `type: bind` carries a planner-set `realization` field — `"passthrough"` or `"accelerated"` — derived deterministically from the active provider's `bindMountPerformance` capability (§5.4):

- Provider declares `bindMountPerformance: "native"` (Linux native runtime; OrbStack on macOS; the WSL-resident detection path) → `realization: "passthrough"`. The provider's native bind primitive realizes the mount directly. The `FileSyncEngine` is not consulted; no daemon is spawned; no `pre-file-sync-*` events fire. Volume shadows for `excludes:` are still created the same way as today.
- Provider declares `bindMountPerformance: "slow"` (Docker Desktop on macOS / Windows; Podman Desktop machines; default-config Lima/Colima; Rancher Desktop) → `realization: "accelerated"`. The planner replaces the bind shape with a pair: (1) a provider-managed `volume`-type storage entry named `lando-sync-<app-id>-<service>-<mountKeyHash>` mounted at the original `destination:`, and (2) a `FileSyncEngine` session whose source is the host path and whose target is that volume. The bundled `@lando/file-sync-mutagen` engine (§4.2) realizes this pair via a Mutagen sync session; alternate engines see the same `FileSyncSessionSpec` shape (§3.5).
- Provider declares `bindMountPerformance: "none"` → planner refuses with `CapabilityError` per §5.4.

The user's Landofile is unchanged across all three cases — the realization shape is invisible. `lando config --format yaml` MAY surface the resolved realization in a `--debug` view; it MUST NOT include the engine id or session id in the canonical config output, because doing so would leak machine state into a value the user is expected to commit.

**Excludes under `realization: "accelerated"`.** When the active `FileSyncEngine` declares `capabilities.exclusionPatterns: true` (§4.2), the planner forwards `excludes:` to the engine's session-spec rather than emitting per-exclude volume shadows. Mutagen's `.mutagen.yml`-style ignore patterns are richer than the volume-shadow trick (full glob support, no per-exclude volume cost); the planner translates `excludes: ["node_modules", "vendor", "!vendor/something"]` into the engine's native exclude grammar. When the engine declares `exclusionPatterns: false` (e.g., the `passthrough` engine itself, or a hypothetical engine that cannot honor patterns), the planner falls back to the volume-shadow expansion so the user's `excludes:` still take effect — engines never silently drop excludes.

**Mount key.** Every `MountPlan` carries a stable `mountKey` (SHA-256 over the canonicalized `(source, destination, type, normalized-excludes)` tuple) used as the correlation key between the mount, the realized volume name, the `FileSyncSessionSpec`, the `file-sync-sessions` cache entry (§12.1), and lifecycle events (§3.5). The mount key is invariant across replans of the same Landofile content; an `excludes:` change rolls the mount key, which causes the engine to terminate the old session and create a fresh one without the user thinking about session state.

### 6.5 Storage

Storage is a list of persistent data declarations, scoped by lifetime.

```yaml
storage:
  # Short form: destination only → service-scoped volume
  - /var/lib/postgresql/data

  # Full form
  - destination: /cache
    scope: app
    type: volume
    owner: app
    permissions: "0755"

  - destination: /shared
    scope: global
    type: volume

  # Remount existing named volume by source
  - source: my-existing-vol
    destination: /external
    type: volume
```

**Scopes:**

| Scope | Lifetime |
|---|---|
| `service` | Owned by one service in one app. Default. |
| `app` | Shared by services in one app. |
| `global` | Shared across apps when provider supports it. Survives `lando destroy`. |

The v3/SPEC2 `scope: project` alias is **not** accepted in v4 core. Use `scope: app`. A config translator plugin (§7.4.1) MAY rewrite `project` → `app` when migrating older Landofiles.

**Auto-naming** (when `source` not provided):

- `scope: global` → `lando-<kebab(destination)>`.
- `scope: app` → `<project>-<kebab(destination)>`.
- `scope: service` → `<project>-<service>-<kebab(destination)>`.

**Provider labels.** Providers that implement labeled volume metadata MUST tag created volumes:

```text
dev.lando.storage-volume: "TRUE"
dev.lando.storage-scope: <scope>
dev.lando.storage-project: <project>      # not on global
dev.lando.storage-service: <service>      # not on global
```

`destroy` removes volumes labeled with the matching project (and, for `service` scope, the matching service) excluding `global` scope.

**Storage inside the global app.** Services contributed to the **global Lando app** (§20) follow the same scope rules with the auto-naming substitution `<project>` → `global`: `scope: service` → `global-<service>-<destination>`, `scope: app` → `global-<destination>`. `scope: global` storage is identical to today and is the only scope that survives `meta:global:destroy --purge` (§20.9); services in user apps using `scope: global` share the same volumes as global-app services declaring it (this is the canonical mechanism for cross-app shared persistent state). Volumes created by global services additionally carry the `dev.lando.storage-global-app: "TRUE"` label so `apps:poweroff --keep-global` can identify them (§20.9).

### 6.6 Endpoints, hostnames, routes

**Endpoints** describe service listeners. Endpoints are provider-neutral.

```yaml
endpoints:
  - 8080/http              # short form
  - 8443/https
  - port: 5432
    protocol: tcp
    bind: 127.0.0.1
  - path: /var/run/foo.sock
    protocol: unix
```

The `/http` and `/https` suffixes on short-form entries are *intent* signals: the planner annotates the endpoint as proxy-routable and the URL scanner picks it up. The actual transport on the wire is `tcp`.

**Hostnames** are extra DNS aliases for the service on the provider's network.

```yaml
hostnames:
  - extra.app.lndo.site
  - admin.app.internal
```

The planner always adds the canonical alias `<service>.<app>.internal` when the provider supports `sharedCrossAppNetwork`.

**Routes** are host-facing HTTP/TLS mappings. They live at the Landofile top level under `proxy:` (kept for compat) or under each service's `routes:` (preferred).

```yaml
proxy:
  app:
    - app.lndo.site                # http on default
    - app.lndo.site:8080
    - app.lndo.site/api            # path-based
    - "*.app.lndo.site"            # wildcard hostname
    - hostname: admin.lndo.site
      endpoint: 8080/http
      pathname: /admin
      tls: true
      filters:
        - type: requestHeader
          name: X-Lando
          value: v4
```

**Provider-neutral filters.** Route filters replace SPEC2's Traefik middlewares. Built-in filter types:

| Filter | Purpose |
|---|---|
| `requestHeader` | Add/remove/replace request headers |
| `responseHeader` | Add/remove/replace response headers |
| `redirect` | Permanent or temporary redirect |
| `rewritePath` | Path rewrite |
| `stripPrefix` | Strip path prefix |
| `addPrefix` | Add path prefix |
| `auth.basic` | Basic auth (credentials sourced via `SecretStore`) |
| `rateLimit` | Per-route rate limit |

Plugins contribute additional filter types via `provides.routeFilters`. Proxy plugins translate the filter schema into their native middleware.

**Default hostnames.** Generated as `<service>.<app>.<domain>`, where `<domain>` defaults to `lndo.site` and is overridable via global config or Landofile.

**Default bind address.** Host-exposed endpoints bind to `127.0.0.1` by default. LAN exposure is opt-in via global `bindAddress` and emits a security warning.

### 6.7 Healthchecks

```yaml
healthcheck: false
healthcheck: curl -fsS http://localhost:8080/health
healthcheck:
  command: "{{ load('healthcheck.sh') | text }}"
  user: app
  retry: 25
  delay: 1000
  timeout: 5000
```

Rules:

- `false` disables healthchecks.
- String, string-array, and object forms are all supported. Any form may be computed from disk via `load()` (§7.3).
- The `HealthcheckRunner` service decides how to execute. Default runner uses `RuntimeProvider.exec`.
- `lando start` distinguishes `running` from `ready`. Subscribers may listen to `post-start` priority `ready` to react to readiness.

### 6.8 Certificates and security

```yaml
certs: true
certs: false
certs: ./custom.crt
certs:
  cert: ./custom.crt
  key: ./custom.key
```

When `certs: true`, the active `CertificateAuthority` plugin generates a leaf cert with SANs covering:

- The service name (`<service>`)
- The internal alias (`<service>.<app>.internal`)
- All configured `hostnames:`
- All proxied hostnames from `routes:` / `proxy:`
- `localhost` and `127.0.0.1`

Cert/key paths are exposed as `LANDO_SERVICE_CERT` and `LANDO_SERVICE_KEY` environment variables.

**Additional CAs** via `security.ca:` (and aliases `cas`, `certificate-authority`, `certificate-authorities`):

```yaml
security:
  ca:
    - ./CorpCA.crt
    - "{{ load('other-ca.pem') }}"
    - "{{ import('inline-ca.crt') }}"
```

Each entry is mounted into the service at a CA-distro-appropriate path and registered with the system trust store via the boot scaffolding (`type: lando` only). Plugins handle distro-specific install logic; core defines only the intent.

**Outbound proxy/CA for app builds.** Lando's global `network.proxy` and `network.ca` settings (§7.5/§10.3.1) are available to provider plugins during artifact pull/build and to `type: lando` service boot scaffolding when the user opts into inheriting them for app dependency downloads. Providers MUST use the resolved proxy/CA settings for Lando-initiated artifact pulls and builds. App services SHOULD NOT receive proxy credentials by default; when a service or build step opts in, credentials are treated as secrets and redacted from logs, telemetry, caches, `LANDO_INFO`, and rendered config output.

### 6.9 Service environment variables

The standard env var set is published by core; providers and `lando` services inject. `LANDO_*` is reserved for core; plugins use `LANDO_PLUGIN_<NAME>_*`.

**Always-injected (when applicable):**

```text
LANDO=ON
LANDO_DEBUG=<empty|1>
LANDO_HOST_IP=<host gateway alias or IP>
LANDO_HOST_OS=<platform>
LANDO_HOST_USER=<host user>
LANDO_HOST_UID=<host uid>
LANDO_HOST_GID=<host gid>
LANDO_HOST_HOME=<host home>
LANDO_APP_NAME=<app name>
LANDO_APP_ROOT=<app root visible inside service>
LANDO_PROJECT=<app slug>
LANDO_PROJECT_MOUNT=<app mount target>
LANDO_SERVICE_API=4
LANDO_SERVICE_NAME=<service id>
LANDO_SERVICE_TYPE=<resolved type>
LANDO_DOMAIN=<configured domain>
LANDO_INFO=<JSON-encoded service info>
```

**Conditional:**

```text
LANDO_SERVICE_CERT          # when certs enabled
LANDO_SERVICE_KEY           # when certs enabled
LANDO_CA_CERT               # when CA available
LANDO_CA_DIR                # when CA installed in trust store
LANDO_CA_BUNDLE             # when CA installed in trust store
LANDO_USER, LANDO_UID, LANDO_GID  # type: lando services
SSH_AUTH_SOCK               # when ssh-agent feature enabled
LANDO_HOST_PROXY_SOCKET     # when host-proxy feature enabled (in-container path to the bound socket; §10.10)
LANDO_HOST_PROXY_TOKEN      # when host-proxy feature enabled (per-`app:start` random token; required as Bearer auth)
LANDO_HOST_PROXY_DEPTH      # set by HostProxyService for `runLando` re-entries; recursion guard, never set by users
LANDO_DB_USER               # when service-type opts in to the §6.12.4 creds schema
LANDO_DB_PASSWORD           # when service-type opts in to the §6.12.4 creds schema (redacted in logs)
LANDO_DB_NAME               # when service-type opts in to the §6.12.4 creds schema
LANDO_DB_ROOT_PASSWORD      # when service-type opts in and rootPassword is defined (redacted in logs)
LANDO_GLOBAL_<SERVICE>_HOST     # always when AppFeature activates requires.globalServices: [<service>]
LANDO_GLOBAL_<SERVICE>_PORT     # primary endpoint port; conditional on the global service exposing one
LANDO_GLOBAL_<SERVICE>_<EP>_PORT  # named endpoint port (e.g., LANDO_GLOBAL_MAILPIT_SMTP_PORT)
LANDO_GLOBAL_<SERVICE>_URL      # primary route URL; conditional on the global service having a route
```

> The `LANDO_GLOBAL_*` family is a **projection** — only the values the user app's activated `AppFeature`s actually depend on (via `requires.globalServices`, §6.11.4 + §20.6.3) appear in a given service. A user app with no features activating against a global service does not see `LANDO_GLOBAL_*` for it. Plugins MAY add extra fields (e.g., a Mailpit API token) by writing them through their `AppFeature.apply()` body using the standard `addEnv` mutator, reading from `globalServices.<name>.*` per the §7.3.1 cross-service expression scope.

**Inheritable via env layer.** `type: lando` services source `/etc/lando/environment` on every exec, which:

- Detects distro metadata and exports `LANDO_LINUX_DISTRO`, `LANDO_LINUX_DISTRO_LIKE`, `LANDO_LINUX_NAME`, `LANDO_LINUX_PACKAGE_MANAGER`.
- Sources `/etc/lando/env.d/*.sh` so plugin features can contribute env on every login.

Raw `l337` services do not include the env layer; they receive only the compose-level env vars.

### 6.10 Service info

`lando info` consumes provider-neutral `ServiceInfo`. The schema is invariant across providers.

```ts
export const ServiceInfo = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  status: Schema.Literal(
    "unknown", "stopped", "starting", "running", "healthy", "unhealthy", "error",
  ),
  artifact: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  workingDirectory: Schema.optional(Schema.String),
  appMount: Schema.optional(AppMountInfo),
  endpoints: Schema.Array(EndpointInfo),
  urls: Schema.Array(Schema.String),
  hostnames: Schema.Array(Schema.String),
  certs: Schema.Literal("none", "generated", "custom"),
  health: Schema.Union(Schema.Literal("unknown"), Schema.Boolean),
  externalConnections: Schema.Array(ConnectionInfo),
  internalConnections: Schema.Array(ConnectionInfo),
  creds: Schema.optional(ServiceCreds),                  // §6.12.4; present iff the service-type opts in
  providerInfo: Schema.optional(Schema.Unknown),
});
```

`providerInfo` is the only provider-specific field; consumers should treat it as opaque unless they know the provider. `creds` is present only on service-types that opt in to the creds schema (§6.12.4); plain-text credential fields are redacted in `lando info` unless `--show-secrets` is passed.

### 6.11 Service type and feature contracts

**Service types** are resolvers that turn `type: <name>` into normalized config + a list of features to apply.

```ts
export class ServiceType extends Context.Service<ServiceType, {
  readonly name: string;
  readonly versions?: ReadonlyArray<string>;
  readonly base: "l337" | "lando";
  readonly extends?: string;                                // optional parent service-type id (§6.11.1)
  readonly artifacts?: ReadonlyRecord<string, string>;      // declarative version → image tag (§6.11.2)
  readonly schema: Schema.Schema<unknown>;
  readonly resolve: (input: ServiceTypeInput) => Effect.Effect<ServiceTypeResolution, ServiceTypeError>;
}>()("@lando/core/ServiceType") {}

export interface ServiceTypeResolution {
  readonly normalizedConfig: ServiceConfig;
  readonly features: ReadonlyArray<FeatureRef>;
  readonly tooling?: ReadonlyRecord<string, ToolingTask>;  // §6.11.3, see §8.5 for the ToolingTask shape
  readonly metadata?: Record<string, unknown>;
}
```

#### 6.11.1 Service-type inheritance (`extends:`)

A `ServiceType` MAY declare `extends: <parent-id>` to inherit the parent's resolved normalized config, feature list, tooling, and `artifacts` table. Resolution proceeds parent-first, then the child's `resolve()` runs against the parent's resolution as input and may overlay or replace fields per the §7.2 merge rules. Inheritance is single (no diamond) and depth-limited to 4. Cycles are rejected at plugin load with `ServiceTypeCollisionError`. Use cases: `pantheon-php extends php`, `drupal-mariadb extends mariadb`, `pantheon-mariadb-arm extends mariadb`.

#### 6.11.2 Declarative version pinning (`artifacts:`)

The `artifacts:` field is a `{ "<version>": "<image-tag>" }` map consulted at plan-compile time to resolve a user's `type: mariadb:10.11` into a concrete image tag. The map is data — adding a new pin is a YAML edit, not a code change. Resolution rules:

- Exact match wins. Wildcard / range matching is **not** supported in v4.0; authors who need range resolution write a custom `resolve()`.
- A `versions:` entry without a corresponding `artifacts:` entry resolves to `<name>:<version>` by convention (the user is using upstream tags directly).
- The resolved tag is recorded in the app-plan cache key (§12.1) so a pin change invalidates plans.
- Plugin-contributed `artifacts:` may be merged from a sibling YAML file via `artifacts: ./artifacts.yml` to keep manifests readable.

#### 6.11.3 Service-type-shipped tooling

The optional `tooling:` field on `ServiceTypeResolution` lets a service-type contribute tooling tasks that are merged into the app's tooling map at plan time. Conflict precedence (highest wins): user `tooling:` > recipe `tooling:` > service-type `tooling:`. The service that contributed the task is the default `service:` target unless overridden. This is how the §6.12 catalog ships `lando mariadb`, `lando psql`, `lando redis-cli`, `lando mongo`, etc. without the user writing a `tooling:` block.

#### 6.11.4 App-scoped features (`AppFeature`)

Some plugins need to mutate **other** services in the plan when a triggering service is present (Mailpit injecting SMTP env into PHP services, an Xdebug sidecar adding `XDEBUG_*` env to siblings, an observability agent wiring tracing env into selected runtimes). `ServiceFeature` mutates a single `ServicePlanContext` and cannot express this. `AppFeature` is the matching app-scoped contract.

```ts
export interface AppFeatureDefinition {
  readonly id: string;
  readonly schema?: Schema.Schema<unknown>;
  readonly priority: number;
  readonly activatedBy?: AppFeatureActivation;             // when this feature runs
  readonly selectors?: AppFeatureSelectors;                // which services it mutates
  readonly requires?: {                                     // §20.6.3 — auto-start integration with the global app
    readonly providerCapabilities?: ReadonlyArray<keyof ProviderCapabilities>;
    readonly globalServices?: ReadonlyArray<string>;       // global-app service ids this feature depends on
  };
  readonly apply: (ctx: AppFeatureContext) => Effect.Effect<void, AppFeatureError>;
}

export interface AppFeatureActivation {
  readonly services?: { readonly type?: string; readonly hasFeature?: string };
}

export interface AppFeatureSelectors {
  readonly types?: ReadonlyArray<string>;                  // service-type ids
  readonly framework?: ReadonlyArray<string>;              // language-runtime framework: ids
  readonly hasFeature?: ReadonlyArray<string>;             // service feature ids present
  readonly names?: ReadonlyArray<string>;                  // explicit service names
  readonly fromConfig?: string;                            // expression yielding a string[] of service names
}
```

App-feature rules:

- Activation runs at app-plan time after `ServiceType.resolve()` for every service has completed. A feature whose `activatedBy` does not match is a no-op (no `apply()` invocation, no plan-cache entry).
- `AppFeatureContext` exposes the same mutators as `ServiceFeatureContext` (`addEnv`, `addMount`, `addBuildStep`, `addHealthcheck`, `setEntrypoint`, …) but applies them to **each service yielded by the selector**. Mutators are idempotent and replay-safe.
- Selectors are evaluated against the resolved app plan, not raw user config. `fromConfig: "{{ services.smtp.config.mailFrom }}"` reads through the §7.3.1 expression engine.
- Priority bands match `ServiceFeature` priorities (§6.11). App-features run after all service-features at each priority bucket.
- Cyclic mutations (feature A mutates B; feature B mutates A) are detected and rejected with `AppFeatureCycleError`.
- `AppFeatureError` is a tagged union (`SelectorMatchedNothing`, `MutationConflict`, `CycleDetected`); planners surface failures with the contributing plugin id and remediation.

**`requires.globalServices`** declares that this feature depends on one or more services running in the global Lando app (§20). When the feature activates against a user app's plan, the `AppPlanner` aggregates `requires.globalServices` across every activated feature and the lifecycle orchestrator calls `GlobalAppService.ensureRunning(needed)` inside the user app's `pre-start` phase, after early subscribers and before the user-app build block (§20.6.3). A `requires.globalServices` entry referring to a global service id that is not in the resolved global plan (disabled by the user, capability-blocked, or contributed by a plugin that is not installed) raises `GlobalServiceMissingError` and aborts the user app's start with remediation pointing at `meta:global:install <plugin>`.

The mailpit plugin is the canonical example: an `@lando/service-mailpit` plugin contributes (a) a `mailpit` `ServiceType` (§4.2), (b) a `globalServices:` entry that materializes a `mailpit` service into the **global Lando app**'s `dist` Landofile layer (§20.4, §20.11.1), and (c) an `AppFeature` selecting `types: [php]` (or `framework: [drupal, wordpress, laravel, …]`) with `requires.globalServices: ["mailpit"]` and `apply()` adding `MAIL_HOST=mailpit.global.internal` and `MAIL_PORT={{ globalServices.mailpit.endpoints.smtp.port }}` env. The user installs the plugin and gets Mailpit globally; their PHP services automatically get SMTP env injected without any Landofile change.

**Features** are deterministic, idempotent functions that mutate an in-memory `ServicePlanContext`. Features are the v4 replacement for the SPEC2 "packages" pattern.

```ts
export interface ServiceFeatureDefinition {
  readonly id: string;
  readonly schema?: Schema.Schema<unknown>;
  readonly priority: number;
  readonly requires?: ReadonlyArray<keyof ProviderCapabilities>;
  readonly apply: (ctx: ServiceFeatureContext) => Effect.Effect<void, ServiceFeatureError>;
}
```

Feature rules:

- Features run in deterministic priority order. Lower priority runs first.
- Features mutate only the in-memory plan context.
- Features must be idempotent across replanning and rebuilds.
- Feature conflicts are declared in the manifest (`conflicts:`) or surfaced as typed planning errors.
- Provider-specific feature behavior is gated on `requires:` capabilities.
- Features emit provider-neutral plan changes. Provider-extension config under `providers.<id>` is permitted only when the feature explicitly opts in.

**Built-in features** (provided by `@lando/service-lando`):

| Feature id | Purpose | Priority |
|---|---|---|
| `lando.boot` | `/etc/lando/*` scaffolding for `type: lando` services | 100 |
| `lando.system` | System-level group | 200 |
| `lando.user-id` | Container user/UID/GID mapping | 300 |
| `lando.tooling` | Tooling install group | 400 |
| `lando.storage` | Storage owner/permission steps | 500 |
| `lando.config` | Config file injection group | 600 |
| `lando.env` | `/etc/lando/environment` + `env.d/` | 700 |
| `lando.app-mount` | App-mount wiring | 800 |
| `lando.healthcheck` | Healthcheck wiring | 900 |
| `lando.certs` | Service leaf cert wiring | 1000 |
| `lando.security` | Additional CAs into trust store | 1100 |
| `lando.ssh-agent` | SSH agent forwarding (sidecar by default — see §10.4) | 1200 |
| `lando.host-proxy` | Container→host RPC: bind-mount the per-app `HostProxyService` socket, install the in-container shim binary symlinked as `xdg-open`/`open`/`lando`, inject `LANDO_HOST_PROXY_*` env (§10.10) | 1250 |
| `lando.bun-self` | Container-side Bun primitive: install a Bun runtime inside the service so `bun` / `bunx` / `bun install` / `bun create` / `bun build` work directly without round-tripping through the host (§8.2.4 / §10.10.2 forbid `meta:bun` and mutating `runBun` verbs from the host-proxy path). The feature provisions Bun under `/usr/local/lib/lando/bun` with a stable PATH symlink, sets `BUN_INSTALL_GLOBAL_DIR` to a service-scoped directory so `bun add -g` does not write to the host user's home, and adds `LANDO_BUN_VERSION` / `LANDO_BUN_PATH` env. The feature MUST refuse to coexist with the `lando.host-proxy` shim symlinking `bun` (the §10.10.3 `lando.host-proxy.bun: true` opt-in) and rejects with `BunSelfFeatureConflictError` at plan time. Default Bun version tracks the §14.2 floor and is overridable via the feature's config schema. | 1260 |
| `lando.git` | Install git, set safe.directory | 1300 |
| `lando.sudo` | Install sudo, add user to sudo group | 1400 |
| `lando.proxy` | Proxy-package config wiring (when ProxyService active) | 1500 |
| `lando.user-image` | User-contributed pre-user image steps | 1900 |
| `lando.user` | User-run image steps (matches the `user` artifact-build group from §6.3) | 2000 |

The mapping from feature id to feature module is published by `@lando/service-lando` and may be replaced.

The feature ids `lando.system`, `lando.tooling`, and `lando.user` mirror the well-known artifact-build group names in §6.3 (`system`, `tooling`, `user`); the priority numbers determine the order in which features wire their steps into those groups. `lando.user-id` is a separate, lower-priority feature that runs before any artifact build group is assembled because it establishes the container user identity that later steps run as.

### 6.12 Canonical service-type catalog

Core's distribution ships a comprehensive set of `ServiceType` implementations covering the common stack-starter surface. The intent is that the v4 recipe set (§8.8.10) and ordinary user Landofiles can express their services in one or two lines without reaching for plugins. Niche service types (a particular SaaS emulator, an unusual queue) remain plugin-contributable.

The canonical types are bundled into the binary (§13.5) by `@lando/service-lando` and a small set of focused `@lando/service-*` packages whose membership is fixed at v4.0 and grows only by spec amendment.

#### 6.12.1 Catalog

| `type:` | Versions | Default base | What you get out of the box |
|---|---|---|---|
| `php:<version>` | 8.1, 8.2, 8.3, 8.4 | `lando` | PHP-FPM, Composer 2, common extensions (gd, intl, opcache, pdo_*, mbstring, zip), framework-aware nginx/apache config selectable via `framework: <id>` (`drupal`, `wordpress`, `laravel`, `symfony`, `magento`, `none`), webroot resolution, cache mounts |
| `node:<version>` | 18, 20, 22, 24, lts | `lando` | Node + npm + yarn + pnpm + bun installers; `command:` for the dev server; `script:` for npm scripts; node_modules cache mount |
| `python:<version>` | 3.10, 3.11, 3.12, 3.13 | `lando` | Python + pip + `uv` + venv; `framework: <id>` (`django`, `fastapi`, `flask`, `none`); requirements/pyproject install |
| `ruby:<version>` | 3.1, 3.2, 3.3 | `lando` | Ruby + Bundler + rbenv; `framework: <id>` (`rails`, `sinatra`, `none`); bundle install hooks |
| `go:<version>` | 1.21, 1.22, 1.23 | `lando` | Go toolchain + module cache; `framework: <id>` (`echo`, `fiber`, `none`); `go build` + `go run` hooks |
| `nginx[:<version>]` | 1.24, 1.26, latest | `lando` | nginx with sensible PHP/static upstream presets; framework presets shared with `php:*`; TLS via `lando.certs` |
| `apache[:<version>]` | 2.4 | `lando` | Apache + mod_php / mod_rewrite presets; framework presets shared with `php:*` |
| `mariadb[:<version>]` | 10.6, 10.11, 11.4 | `lando` | MariaDB + `creds:` (user/password/database/rootPassword), healthcheck, persistent volume, mysql tooling |
| `mysql[:<version>]` | 8.0, 8.4 | `lando` | MySQL + `creds:`, healthcheck, persistent volume, mysql tooling |
| `postgres[:<version>]` | 14, 15, 16, 17 | `lando` | PostgreSQL + `creds:`, healthcheck, persistent volume, psql tooling |
| `mongodb[:<version>]` | 6, 7, 8 | `lando` | MongoDB + `creds:`, healthcheck, persistent volume, mongo tooling |
| `redis[:<version>]` | 6, 7 | `lando` | Redis + persistent flag, redis-cli tooling |
| `memcached[:<version>]` | 1.6 | `lando` | Memcached |
| `valkey[:<version>]` | 7, 8 | `lando` | Valkey (Redis-compatible) + persistent flag |
| `solr[:<version>]` | 8, 9 | `lando` | Solr + `core:` config, schema mount, persistent volume |
| `elasticsearch[:<version>]` | 7, 8 | `lando` | Elasticsearch + index init, persistent volume |
| `opensearch[:<version>]` | 2 | `lando` | OpenSearch + index init, persistent volume |
| `meilisearch[:<version>]` | 1 | `lando` | Meilisearch + master key, persistent volume |
| `mailpit` | latest | `lando` | Mailpit SMTP capture + web UI proxy route |
| `mailhog` | latest | `lando` | MailHog SMTP capture + web UI proxy route. **Deprecated** since v4.2.0; scheduled for removal in v5.0.0; replacement `mailpit`. The catalog keeps the entry registered (and the §9.4 plugin manifest example mirrors the deprecation) so legacy projects continue to validate while the deprecation runtime emits the §18.4 `deprecation-used` event on use. New projects should select `mailpit`. |
| `rabbitmq[:<version>]` | 3, 4 | `lando` | RabbitMQ + management UI route, persistent volume |
| `minio` | latest | `lando` | MinIO S3-compatible object store + console route, bucket init |
| `localstack` | latest | `lando` | LocalStack AWS emulator |
| `static[:<server>]` | nginx, caddy | `lando` | Plain web server for static content; `webroot:`, optional build hook |
| `compose` | n/a | `l337` | Raw Compose-spec passthrough; the escape hatch for anything not in the catalog. Validates the `image:` / `build:` block and routes everything else through provider-specific extensions. |

Each type's configuration schema is published from `@lando/sdk` under `@lando/sdk/schema/services/<type>` (§13.2) and surfaces in editor completion and the docs site. Version aliases (`lts`, `latest`) resolve at plan compile time and are recorded in the app-plan cache (§12).

#### 6.12.2 Framework presets

`framework:` is a normalized field on the language-runtime types (`php`, `python`, `ruby`, `go`) that selects opinionated defaults: webserver config, URL rewriting, env defaults, common build steps, and tooling additions.

| Field value | Effects |
|---|---|
| `drupal` | Drupal-aware nginx/apache rewrites, `web/` webroot, drush install hook, settings-file env mapping |
| `wordpress` | WP-aware rewrites, default `wp-content/` mount, wp-cli install hook |
| `laravel` | `public/` webroot, .env mapping, queue worker scaffolding, artisan tooling |
| `symfony` | `public/` webroot, .env mapping, console tooling |
| `magento` | Magento-aware rewrites, `pub/` webroot, n98-magerun install |
| `django` | uvicorn/gunicorn defaults, manage.py tooling, settings env mapping |
| `fastapi` | uvicorn defaults |
| `flask` | gunicorn defaults |
| `rails` | `public/` webroot, asset pipeline, rails tooling |
| `sinatra` | Rack defaults |
| `echo`, `fiber` | Go-framework-specific port/env defaults |
| `none` | No framework preset; user provides full config |

Framework presets are pure config — they emit the same fields a user would write by hand. A user can always override any preset value; nothing is hidden.

#### 6.12.3 Catalog membership rules

- The catalog is fixed at v4.0. Adding a new canonical type or removing one requires a spec amendment.
- Versions inside a catalog entry (e.g., adding PHP 8.5) follow upstream releases and may be added in v4.x without a spec amendment.
- Plugins MAY contribute service types with the same shape; a name collision with a canonical type is rejected at plugin load with `ServiceTypeCollisionError`.
- Plugins MAY contribute features that compose with canonical types (e.g., a `php-newrelic` feature that adds the New Relic extension). The feature priority list (§6.11) is the integration point.
- Library consumers do **not** receive the canonical catalog by default — they must opt into bundled discovery (§16.4) or contribute their own service-type Layers, the same as for any other contribution surface.

#### 6.12.4 The `creds:` schema (database service-types)

Database service-types (`mariadb`, `mysql`, `postgres`, `mongodb`) and any plugin-contributed type that declares `creds:` participate in a uniform credentials contract.

```ts
export const ServiceCreds = Schema.Struct({
  user:         Schema.String,
  password:     Schema.String,
  database:     Schema.String,
  rootPassword: Schema.optional(Schema.String),
});
```

Resolution rules:

- A service-type opts in by setting `creds: { defaults: { ... } }` in its manifest (§9.5) or its resolver output. The defaults are expressions resolved at plan time at level `plugins`.
- The default-defaults shipped by the canonical types are deterministic per (app.slug, service.name) so replans produce the same values without persisting state:
  - `user:         "{{ service.name }}"`
  - `password:     "{{ service.name }}"`
  - `database:     "{{ service.name }}"`
  - `rootPassword: "{{ hash(app.slug + ':' + service.name + ':root', 'sha256', 'hex') | slice(0, 24) }}"`
- A user MAY override any field by setting `creds:` on the service in their Landofile. User values win.
- Resolved creds are exposed in three places:
  1. The §7.3.1 expression scopes `service.creds.*` (self) and `services.<name>.creds.*` (cross-service).
  2. The `LANDO_DB_*` environment family inside the container (`LANDO_DB_USER`, `LANDO_DB_PASSWORD`, `LANDO_DB_NAME`, `LANDO_DB_ROOT_PASSWORD`) — added to the §6.9 contract.
  3. `ServiceInfo.creds` for `lando info` consumption (redacted by default).
- Creds are **not secrets** in the §7.3.1 sense — they are dev-environment defaults, not user secrets. A service-type MAY declare a creds field as `secret: true` to opt that field into `${secret:…}` redaction; `password` and `rootPassword` are secret by default.

This schema is the spec's commitment that the §6.12.1 catalog promise of "MariaDB + creds:" is uniform across types, addressable from anywhere via the cross-service expression scope, and never reinvented per-plugin.

### 6.13 Build orchestration

`BuildOrchestrator` (§3.4) is the v4 replacement for v3's serial start sequence, where a long-running `composer install` against the PHP service blocked an equally long-running `npm ci` against the Node service from even starting until the first one finished. In v4 the two run concurrently by default, share one task-tree render surface, and stream their progress through the same lifecycle event bus the rest of core uses.

This subsection specifies the build phase shape, the DAG construction rules, the concurrency caps, the failure policy, the up-to-date check, the per-step transcript artifact, and cancellation. The renderer-side surface that consumes the resulting events is spec'd in §8.9.2 (concurrent task tree contract).

#### 6.13.1 The two phases

The build phase of `app:start` (and the equivalent positions of `app:rebuild` and `app:cache:refresh --rebuild`) decomposes into two ordered sub-phases. Both phases publish `pre-build-phase` / `post-build-phase` events and feed `build-step-*` events through `EventService`. The §11.4 standard sequence renders this as a nested block under `pre-start` / `post-start`.

| Phase | Source | Provider call | Per-service serial dep | Default failure policy | Default concurrency cap |
|---|---|---|---|---|---|
| `artifact` | `build.artifact:` plus the §6.3 group-weighted artifact instructions a service-type and its features contributed | `RuntimeProvider.buildArtifact` (or `pullArtifact` when the artifact is a tag the provider can pull) | none — artifact builds for distinct services are independent | **fail-fast** (§6.13.4) | `build.concurrency.artifact`, default `2` (Docker-class daemons saturate around 2–3 concurrent image builds; over-parallelizing wastes CPU and IO) |
| `app` | `build.app:` plus any `ServiceFeature.apply()` contributions that registered a runtime build step | `RuntimeProvider.execStream` against the started service container | for service S, S's `app` step waits on S's `artifact` step (the `lando.boot` scaffolding lives inside the built artifact) and on `start(S)` reaching `running` (so the container is up before we exec into it); cross-service waits flow through Compose `depends_on:` | **continue-all** (§6.13.4) | `build.concurrency.app`, default `min(4, cpu_count)` (leaves headroom for the user's editor / browser; CI runners with high core counts get a higher cap up to the floor) |

Concurrency caps and failure policies are global config keys (§7.5) with per-app override under the Landofile `build:` key and per-service override under `services.<name>.build:` (`build: { failFast: true }`, `build: { concurrency: 1 }`).

#### 6.13.2 The `BuildPlan` DAG

`BuildOrchestrator` derives a `BuildPlan` from the resolved `AppPlan` at level `app`. The plan is a directed acyclic graph of typed nodes; siblings without an edge between them are eligible to run concurrently subject to the phase cap.

```ts
export const BuildStep = Schema.Struct({
  stepId:    Schema.String,                                 // "<service>:<phase>:<short-name>"
  phase:     Schema.Literal("artifact", "app"),
  service:   ServiceName,
  buildKey:  Schema.String,                                 // SHA-256 over the resolved inputs (§6.13.5)
  command:   BuildCommand,                                  // shape per phase (artifact spec | exec script)
  dependsOn: Schema.Array(Schema.String),                   // predecessor stepIds in this BuildPlan
  failFast:  Schema.Boolean,                                // resolved per-step from phase + per-service overrides
  redact:    Schema.Array(Schema.String),                   // additional redaction tokens propagated to events
  estimateMs: Schema.optional(Schema.Number),               // optional hint from the build-results cache (§12.1) for renderer ETA
});

export const BuildPlan = Schema.Struct({
  app:        AppRef,
  steps:      Schema.Array(BuildStep),
  caps:       Schema.Struct({                               // resolved phase caps
    artifact: Schema.Number,
    app:      Schema.Number,
  }),
});
```

DAG construction rules:

- For each service S in the plan, if S has artifact-build inputs (a non-empty group-weighted instruction list, a `sourcefile:`, or a Compose `build:` block), emit one `artifact` step `<S>:artifact`. If S resolves to a pullable artifact tag with no build inputs, emit a degenerate `artifact` step that calls `pullArtifact` and is almost always cached on the second run.
- For each service S in the plan, if `build.app:` is non-empty (or any service-feature contributed app-build steps), emit one `app` step `<S>:app:<short-name>` per discrete script. Multiple `build.app:` entries for one service emit one step each, in declaration order, with sequential `dependsOn` edges between siblings.
- Per-service edge: every `<S>:app:*` step depends on `<S>:artifact` and on `start(S)` reaching `running` (the orchestrator publishes a synthetic `service-running` predecessor for each service so steps that only need the container up can declare it explicitly).
- Cross-service edges from Compose `depends_on:`: if service S declares `depends_on: [db]`, every `<S>:app:*` step gets an additional `dependsOn` entry on the synthetic `<db>:running` node. The orchestrator does NOT add `dependsOn` between `<S>:artifact` and `<db>:artifact` — image builds are independent of each other regardless of `depends_on:`.
- Cycles are rejected at plan time with `BuildPlanCycleError` containing the offending edge list. (Service `depends_on:` cycles are already rejected by the `AppPlanner`; this is belt-and-braces.)

Execution:

- The orchestrator walks the DAG and pushes every step whose predecessors have all resolved (`complete` or `skip`) into the appropriate phase's run pool.
- Each phase's run pool is bounded by `Effect.forEach({ concurrency: caps[phase] })` from §2.4. The same primitive that governs intra-bootstrap parallelism governs build siblings — there is no second concurrency mechanism to reason about.
- `Effect.interrupt` (from `SIGINT`, command-level cancellation, or fail-fast within the artifact phase) propagates through the `forEach` pool; every in-flight `execStream` (§5.3) is killed at scope close; the orchestrator publishes `build-step-fail { reason: "interrupted" }` for each.

#### 6.13.3 What runs where

The orchestrator dispatches each step kind to the right provider primitive:

| Step kind | Provider call | Notes |
|---|---|---|
| `artifact` (full build) | `RuntimeProvider.buildArtifact(spec)` consuming the §6.3 group-weighted instruction list | Returns an `ArtifactRef`; the orchestrator stamps the resulting tag onto the `ServicePlan` so `start(S)` references it. |
| `artifact` (pull only) | `RuntimeProvider.pullArtifact(spec)` | Used when the service resolves to a published image tag with no inline build inputs. |
| `app` (build script) | `RuntimeProvider.execStream({ service: S }, { script, user, cwd, env })` | The orchestrator owns the `Stream<ExecChunk>` consumer and translates chunks into `build-step-progress` events plus transcript writes. |

The `app`-phase step is always dispatched through `execStream` even when the script is short — uniformity makes the renderer's tail panel work the same way for every step, and `exec` is itself a `Stream.runFold` over `execStream` per §5.3.

#### 6.13.4 Failure policy

The two phases have different default policies because their failure modes differ:

- **`artifact` phase: fail-fast.** A failed image build for service S blocks every `<S>:app:*` step downstream, and a half-built image set tends to leave the user in a broken state. First failure interrupts in-flight siblings via `Effect.interrupt`, marks queued siblings as `build-step-skip { reason: "phase-aborted" }`, and raises the failure to `pre-start`'s caller. Override per-app via `build.failFast: false` in the Landofile when the user explicitly wants every artifact build to run to completion (e.g., to reproduce multiple failures in one cycle).
- **`app` phase: continue-all.** A failed `composer install` does NOT interrupt a healthy `npm ci`. Every sibling runs to completion; the orchestrator aggregates failures and raises a single `BuildPhaseFailedError { failures: ReadonlyArray<BuildStepFailure> }` after `post-build-phase`. Rationale: when a developer `lando start`s a fresh clone after a long branch update, "all four broken services" is one round-trip to fix; "one broken service, run again, next broken service, run again" is four round-trips.

Per-service overrides: `services.<name>.build.failFast: true` opts a single service into fail-fast even in the `app` phase. Per-step overrides are not exposed; the failure granularity is the service.

#### 6.13.5 The `buildKey` up-to-date check

Every `BuildStep` carries a `buildKey` — a SHA-256 hash over the canonicalized inputs that determine whether re-running the step would produce a different result. The orchestrator consults the `build-results` cache (§12.1) before dispatching: if `buildKey` matches a successful prior run, the step is short-circuited and emits `build-step-skip { reason: "up-to-date", cached: true }`.

`buildKey` inputs:

| Phase | Hashed inputs |
|---|---|
| `artifact` | The resolved group-weighted instruction list (after §6.3 group/weight resolution), the resolved `args:` and `secrets:` *names* (not values), the resolved `platform:`, the realized `context:` directory tree's content hash, the parent artifact reference (e.g., `nginxinc/nginx-unprivileged:1.27`), the provider id, and the active `lando` and `@lando/service-*` versions that contributed steps. |
| `app` | The resolved script source (post-template-render), the resolved `cwd:`, `user:`, `env:` keys (values redacted before hashing — secret value changes do NOT bust the cache, by design; secret *name* changes do), the realized `mounts:` `mountKey` set, the `ArtifactRef` from the same service's `artifact` step (so a rebuilt image always re-runs the app step), and the active `lando` version. |

Inputs that are deliberately NOT in `buildKey`:

- The resolved value of any `${secret:…}` reference (changing a secret value MUST NOT silently re-run a build step the user did not change; if a user wants to force a rerun, `lando rebuild <service>` or `lando app cache refresh --rebuild` does it).
- The host system clock or timezone.
- The values inside `mounts:` of `type: bind` (they are content-addressed by `mountKey` already; the file contents inside the bind mount are tracked by the build script itself, not the orchestrator).
- Any environment variable that wasn't declared on the build script's `env:` map.

`build-results` cache entries:

```ts
export const BuildResult = Schema.Struct({
  buildKey:       Schema.String,
  service:        ServiceName,
  phase:          Schema.Literal("artifact", "app"),
  outcome:        Schema.Literal("complete", "fail"),       // "skip" entries are not persisted
  exitCode:       Schema.Number,
  durationMs:     Schema.Number,
  artifactRef:    Schema.optional(Schema.String),           // present for artifact phase
  transcriptPath: AbsolutePath,
  completedAt:    Schema.DateTimeUtc,
});
```

Only `outcome: "complete"` entries short-circuit a future run. A cached failure entry is informational (lets `lando logs --build` find the transcript) and does NOT prevent the orchestrator from retrying. Cache rotation is per-service per-`buildKey`; the most recent N (default 10) `complete` entries and the most recent N (default 5) `fail` entries are kept.

#### 6.13.6 Per-step transcripts

For every dispatched step, the orchestrator writes the full unredacted output to a per-step transcript file at `<userDataRoot>/builds/<app-id>/<phase>/<service>/<buildKey>.log` (full path schema in §12.4). The file is opened on `build-step-start`, every chunk from `execStream` is appended atomically, and the file is closed on `build-step-complete` / `build-step-fail`.

- `transcriptPath` is published on `BuildStepEvent` and `BuildStepResultEvent` so subscribers and the renderer can `tail -f` it.
- The renderer's "expand task" surface (§8.9.2) reads from this file directly — the live tail and the post-completion replay use the same source.
- `lando logs <service> --build [--build-key …]` resolves the latest transcript for a service or a specific `buildKey`.
- Transcripts are never sent to telemetry. `${secret:…}`-resolved values are redacted at the `Logger`/event boundary but written *unredacted* to the transcript file (they are local-only diagnostic artifacts; the file lives under the user data root and is removed by `lando destroy`).

#### 6.13.7 Cancellation

Cancellation propagates through Effect's standard interrupt model. `SIGINT` from the CLI shell (§3.6) calls `Effect.interrupt` on the running build phase; `Effect.forEach` propagates to every in-flight sibling; each step's `Scope` invokes the provider's `kill()` on its `execStream` child; the orchestrator publishes `build-step-fail { reason: "interrupted" }` for every in-flight or queued step; the per-step transcript is closed cleanly with a final marker line. The user-perceived gap between Ctrl+C and the renderer's "Cancelled" line MUST stay inside the §2.1 cancellation budget.

When fail-fast triggers a phase abort (§6.13.4), the same machinery runs but the published `reason:` is `"phase-aborted"` and the cause field carries the originating step's `BuildStepFailure`.

#### 6.13.8 Errors

```ts
export class BuildPlanCycleError extends Schema.TaggedError<BuildPlanCycleError>()(
  "BuildPlanCycleError",
  { app: AppRef, edges: Schema.Array(Schema.String) },
) {}

export class BuildStepFailedError extends Schema.TaggedError<BuildStepFailedError>()(
  "BuildStepFailedError",
  { step: BuildStep, exitCode: Schema.Number, transcriptPath: AbsolutePath, summary: Schema.String },
) {}

export class BuildPhaseFailedError extends Schema.TaggedError<BuildPhaseFailedError>()(
  "BuildPhaseFailedError",
  { app: AppRef, phase: Schema.Literal("artifact", "app"), failures: Schema.Array(BuildStepFailedError) },
) {}

export class BuildOrchestratorUnavailableError extends Schema.TaggedError<BuildOrchestratorUnavailableError>()(
  "BuildOrchestratorUnavailableError",
  { reason: Schema.String },
) {}
```

`BuildOrchestratorUnavailableError` exists because the service is `Layer.suspend`-wrapped (§3.4): an embedding host that constructs the runtime at level `app` but never references `BuildOrchestrator` MUST still see a typed failure if a downstream subsystem tries to publish a `Build` event without going through the orchestrator. (The orchestrator is the only publisher of the `Build` event scope; manifest validation rejects plugin subscribers that try to publish into the scope.)

---
