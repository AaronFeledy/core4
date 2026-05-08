# Lando v4 — Service Specification

> **Part 6 of 16** · [Index](./README.md)
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
    command: !load scripts/start.sh @string
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
        - !load other-ca.pem

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
    content: !load config.yml @string

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
  command: !load healthcheck.sh @string
  user: app
  retry: 25
  delay: 1000
  timeout: 5000
```

Rules:

- `false` disables healthchecks.
- String, string-array, object, and `!load`/`!import` forms are all supported.
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
    - !load other-ca.pem
    - !import inline-ca.crt
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
```

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
  health: Schema.Literal("unknown").pipe(Schema.Union(Schema.Boolean)),
  externalConnections: Schema.Array(ConnectionInfo),
  internalConnections: Schema.Array(ConnectionInfo),
  providerInfo: Schema.optional(Schema.Unknown),
});
```

`providerInfo` is the only provider-specific field; consumers should treat it as opaque unless they know the provider.

### 6.11 Service type and feature contracts

**Service types** are resolvers that turn `type: <name>` into normalized config + a list of features to apply.

```ts
export class ServiceType extends Context.Service<ServiceType, {
  readonly name: string;
  readonly versions?: ReadonlyArray<string>;
  readonly base: "l337" | "lando";
  readonly schema: Schema.Schema<unknown>;
  readonly resolve: (input: ServiceTypeInput) => Effect.Effect<ServiceTypeResolution, ServiceTypeError>;
}>()("@lando/core/ServiceType") {}

export interface ServiceTypeResolution {
  readonly normalizedConfig: ServiceConfig;
  readonly features: ReadonlyArray<FeatureRef>;
  readonly metadata?: Record<string, unknown>;
}
```

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
| `mailhog` | latest | `lando` | MailHog SMTP capture + web UI proxy route (alias for `mailpit` users on legacy projects) |
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

---
