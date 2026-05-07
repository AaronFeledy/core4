# Lando v4 — Landofile and Configuration

> **Part 7 of 15** · [Index](./README.md)
> **Read next:** [08 CLI and Tooling](./08-cli-and-tooling.md)

This part defines the user-facing configuration system. A Landofile is committed to a project repo and any developer can produce an identical, networked environment from it. Global config sits at `<userConfRoot>/config.yml` with optional `config.d/*.yml` overlays, and every key is overridable by environment variables.

Covered here: Landofile discovery rules and bounds, the six-file merge order with array-merge identity keys, the `!load` and `!import` YAML extensions with hint suffixes, configuration expressions, the top-level Landofile keys, the supported Compose subset, explicit config translation, the explicitly forbidden wrapper keys (`compose:`, `recipe:`, `recipes:`), the global config schema, the env-var override naming convention, the `includes:` composition primitive with its source-resolution rules and lockfile, and how schemas are published from `@lando/sdk` as JSON Schema and generated documentation.

---

## 7. Landofile and Configuration

### 7.1 Discovery

A Landofile-bearing directory is identified by the presence of any of the merge files in §7.2. Discovery walks upward from CWD; the first matching directory becomes the *app root*. Discovery is bounded by:

- Filesystem root (`/`)
- A directory containing `.lando.stop` (sentinel for "stop walking here")
- A configurable `discovery.maxDepth` (default `8`)

Discovery uses `FileSystem.readdir` and is cached per-CWD for the lifetime of a CLI invocation.

### 7.2 Merge order

Default load order (low → high precedence):

```text
1. .lando.base.yml
2. .lando.dist.yml
3. .lando.upstream.yml
4. .lando.yml          (canonical; filename configurable globally)
5. .lando.local.yml
6. .lando.user.yml
```

Rules:

- Files load in order; later files override earlier files.
- Maps deep-merge.
- Arrays of scalars replace.
- Arrays of objects merge by recognized identity keys: `name`, `id`, `hostname`, `service`, schema-specific keys.
- Tooling arrays (`cmds`, `deps`, `status`, `preconditions`, `prompt`) replace by default; object entries MAY opt into schema-specific merge by declaring a stable `name` or `id`.
- Custom file basenames and pre/post lists live in *global config*, not in Landofiles.
- The final `name:` is taken from the highest-precedence file that defines it.
- `.lando.recipe.yml` is **not** part of the merge order in v4. The v3 recipe-as-plugin model is removed; recipes are now init-time scaffolds (§8.8) that produce a fully-visible `.lando.yml` the user owns.
- `includes:` (§7.7) are resolved per file *before* the merge across files. Each file's `includes:` are merged into that file's tree as if the included content appeared inline, using the same map/array rules.

### 7.3 YAML extensions

The Landofile parser supports `!load` and `!import` YAML tags. Both read a file relative to the Landofile's directory; both accept an optional `@hint` suffix.

```yaml
services:
  app:
    command: !load scripts/start.sh @string
    environment: !load environment.yml @yaml
    metadata:
      json: !import config.json @json
      binary: !import cert.der @binary
```

| Hint | Behavior |
|---|---|
| `@string` | Read as UTF-8 string |
| `@yaml` | Parse as YAML |
| `@json` | Parse as JSON |
| `@binary` | Read as bytes; emit base64 |

Default inference (when no hint):

- `.yml` / `.yaml` → `@yaml`
- `.json` → `@json`
- otherwise → `@string`

`!load` returns the parsed/raw value directly. `!import` returns an `ImportRef` that preserves the original filename in metadata; consumers like the CA installer use this to choose a sensible in-container filename.

### 7.3.1 Configuration expressions

Lando supports a small, pure expression language in configuration strings. The syntax is Taskfile-inspired (`{{ ... }}`), but it is a Lando contract rather than Go template compatibility.

```yaml
name: "{{ .env.PROJECT_NAME | default .app.basename }}"

services:
  appserver:
    type: lando
    environment:
      APP_ENV: "{{ .env.APP_ENV | default \"local\" }}"

tooling:
  test:
    service: appserver
    cmds:
      - "php vendor/bin/phpunit {{ .raw | shellJoin }}"
```

Rules:

- Expressions are resolved by `ConfigService` / `LandofileService` after YAML parsing, `!load` / `!import`, `includes:` resolution, file merge, and env overrides for the relevant config layer, but before resolved schema validation and app planning consume the values.
- A string that is exactly one expression preserves the expression result type (`boolean`, `number`, array, object, `null`, or string). A string with surrounding text interpolates the expression result as a string.
- Expressions are pure and deterministic. They MUST NOT execute shell commands, read files, perform network IO, or mutate process/global state. Shell-backed dynamic values are allowed only in tooling-specific `vars.<name>.sh` (§8.5.3), where execution is explicit and goes through `ToolingEngine` / `ProcessRunner`.
- Expressions can reference only the evaluation context for the current phase. Unknown paths, cyclic references, or type mismatches fail validation with a tagged `ConfigExpressionError` that includes the expression path and remediation.
- `${secret:...}` remains the SecretStore reference syntax. Secret values MAY be used as expression inputs only through resolver-provided secret references, MUST be redacted in logs/errors, and MUST NOT be written decrypted into caches.
- Literal `{{` in a string is escaped as `{{{{`.

The baseline expression context is:

| Scope | Meaning |
|---|---|
| `.app.name`, `.app.root`, `.app.basename` | App identity and root path known during Landofile discovery |
| `.host.os`, `.host.arch`, `.host.platform`, `.host.isWsl` | Host platform facts |
| `.env.<NAME>` | Process environment after global env override handling |
| `.global.<key>` | Resolved global config values that are safe to expose |
| `.vars.<key>` | Variables from the nearest expression scope |
| `.paths.userConfRoot`, `.paths.userCacheRoot`, `.paths.userDataRoot` | Resolved Lando roots |

Tooling invocation expressions add `.task`, `.flags`, `.args`, `.raw`, `.service`, `.sources`, `.generates`, `.checksum`, and `.timestamp` (§8.5.4). Event expressions add `.event` with the decoded event payload.

The required built-in function set is intentionally small: `default`, `required`, `eq`, `ne`, `and`, `or`, `not`, `contains`, `startsWith`, `endsWith`, `lower`, `upper`, `trim`, `split`, `join`, `json`, `fromJson`, `yaml`, `fromYaml`, `pathJoin`, `shellQuote`, and `shellJoin`. Plugins MAY contribute additional pure functions through a future expression-function contribution surface, but core schemas and docs MUST identify which functions are portable.

### 7.4 Top-level Landofile keys

```yaml
name: <string>                         # optional for supported Compose input; inferred from app root when omitted
runtime: 4                             # optional; default 4 — Landofile runtime/format major version (see "Runtime vs api" below)

includes:                              # composition primitive (§7.7); local/git/npm/registry sources
  - <IncludeRef>

provider: <provider-id>                # which RuntimeProvider to use
toolingEngine: <toolingEngine-id>      # Landofile default for tooling task execution
providers:                             # provider-specific extensions (non-portable)
  <provider-id>: <provider-extension-config>

services:
  <name>: <ServiceConfig>

tooling:
  <name>: <ToolingConfig | "disabled" | false>

toolingDefaults:
  <ToolingDefaults>

toolingIncludes:
  <namespace>: <ToolingInclude>

commandAliases:                        # app-scoped overrides for top-level CLI aliases (§8.1.2)
  enabled: true | false                # opt-out of all top-level aliases for this app
  disabled: <string[]>                 # opt out of specific top-level aliases
  custom:                              # add or override top-level aliases (overrides built-ins)
    <alias>: <canonical-id>

events:
  <event-name>: <EventCommand[]>

proxy:
  <service>: <RouteConfig[]>

env_file:
  - <path>

plugins:                               # app-scoped plugin sources; resolved and cached at app build time
  <plugin-name>: <plugin-spec>
pluginDirs:
  - <path>

keys: <bool | string[]>                # SSH key allowlist behavior

# Compose-spec top-level keys accepted directly by the Landofile schema.
volumes:
  <name>: <ComposeVolumeConfig>
networks:
  <name>: <ComposeNetworkConfig>
configs:
  <name>: <ComposeConfig>
secrets:
  <name>: <ComposeSecretConfig>
include:
  - <ComposeInclude>
x-<name>: <unknown>                    # Compose extension fields
```

**App identity (`name:`, `slug`, `<app-id>`).** A Landofile's app identity is derived deterministically from the resolved config:

- `name:` is the user-facing app name. When omitted, it is inferred from the app root's basename (the directory name). Inference is cached in the app-plan cache and stays stable across invocations as long as the app root path stays the same.
- `slug` is `name` normalized for filesystems, URLs, and provider labels: lowercase, ASCII-only, with non-`[a-z0-9]` runs collapsed to single `-`, leading/trailing `-` stripped, capped at 63 characters. Empty results after normalization (for example, an all-emoji name) fall back to a stable hash of the absolute app root path.
- `<app-id>` is `slug` for v4.0. It is the key under `<userCacheRoot>/apps/<app-id>/` (§12.4), `LANDO_PROJECT`/`LANDO_APP_NAME` env (§6.9), and provider labels (`dev.lando.storage-project`).
- Two distinct Landofiles whose roots produce the same `slug` collide. Collisions are detected at first cache write and reported with `AppIdCollisionError` and remediation suggesting an explicit `name:`. Lando does **not** automatically de-duplicate by appending suffixes; the user resolves the collision by setting an explicit name.

The slug normalization, the basename inference, and the collision policy are all part of the published Landofile schema metadata so embedding hosts and editor tooling produce the same identity Lando does.

**Compose compatibility.** A Landofile accepts a documented subset of the Compose project spec. The subset covers common Compose features and every Compose feature Lando uses internally. Lando adds higher-level keys (`includes:`, `tooling:`, `toolingDefaults:`, `toolingIncludes:`, `events:`, `proxy:`, plugin config, service shortcuts) and accepts simplifications, but it does not promise that every valid Compose project document is valid Landofile input.

Rules:

- Top-level Compose project keys including `services:`, `volumes:`, `networks:`, `configs:`, `secrets:`, `include:`, and `x-*` extension fields are accepted when their shapes are in the supported subset.
- Compose service keys are accepted under `services.<name>` alongside Lando service extensions (§6.2) when their shapes are in the supported subset.
- The supported subset MUST be published as a schema-backed key matrix in the docs. Unsupported Compose keys fail closed with remediation pointing to a Lando key, provider extension, or config translator.
- Compose's obsolete top-level `version:` is accepted for compatibility, ignored for behavior, and SHOULD produce a deprecation warning in `lando config` output.
- Compose fields that normalize cleanly become provider-neutral `AppPlan` fields (§5.5.1).
- Compose fields without provider-neutral semantics are preserved in plan extensions and require a provider that declares the needed Compose capability. They MUST NOT be silently dropped.
- Lando-specific keys win over equivalent Compose shorthand during normalization. For example, `services.web.endpoints:` wins over endpoint intent inferred from `services.web.ports:`.
- `lando config --format yaml` SHOULD render the post-merge, post-normalization config so users can see how Compose and Lando keys were resolved.
- `toolingIncludes:` is deliberately separate from Compose `include:` and from Lando's top-level `includes:`. `toolingIncludes:` imports reusable tooling/task definitions and namespaces them unless explicitly flattened (§8.5.8); Lando's `includes:` (§7.7) imports whole Landofile fragments; Compose `include:` is the Compose-spec import mechanism for project fragments. The three are deliberately distinct surfaces and resolve at different times.
- Lando's `includes:` (§7.7) is a strict superset of the supported Compose `include:` forms, with additional source schemes (git, npm, registry) and Lando-aware merge semantics. A Landofile MAY use either key. If both `includes:` and `include:` appear in the same file, `include:` is treated as a Compose-only fragment list and is resolved through `includes:`'s machinery.

**Runtime vs api.** `runtime:` and per-service `api:` are distinct version surfaces:

- `runtime: 4` is the **Landofile-wide format major version**. It declares which Landofile runtime/format the document targets and gates which top-level keys, `includes:` schemes, and merge semantics apply.
- `api: 4` (§6.1) is the **per-service API major version**. It declares which `services.<name>` schema applies for that one service.

In v4 the two are tied: `runtime: 4` Landofiles MUST contain `api: 4` services (default when omitted). They are spec'd as separate keys so a future major can introduce a new service API without forcing a Landofile-wide format bump (or vice versa). Mixing future versions is out of scope for v4.0; a `runtime: 4` Landofile that contains an `api: 5` service fails validation with a tagged `LandofileVersionMismatchError`.

**Forbidden top-level wrapper keys** (per non-goals):

- `compose:` — redundant wrapper. Compose keys belong directly in the Landofile; provider-specific Compose files/fragments belong under `providers.<id>` extensions.
- `recipe:` — recipes are init-time scaffolds (§8.8), not a runtime Landofile key. The v3 recipe-as-plugin model is removed in v4. There is no core migration path; users init a fresh app from a v4 recipe or use an external config translator (§7.4.1).
- `recipes:` — same reason; no top-level "recipes" key exists.

The `compose:` rejection is *only* about the wrapper key; the supported Compose subset is accepted directly at the top level of a Landofile.

```yaml
# Forbidden — `compose:` top-level wrapper
compose:
  services:
    web:
      image: nginx:1.27

# Accepted — Compose top-level keys directly in the Landofile (subject to the documented subset)
name: my-site
services:
  web:
    image: nginx:1.27
volumes:
  db_data: {}
networks:
  default:
    driver: bridge
```

A Landofile that includes `compose:` is rejected at parse time with `LandofileForbiddenWrapperError` and remediation pointing to the unwrapped form. Provider-specific Compose passthrough (override files, native labels, etc.) goes under `providers.<provider-id>` (§5.6), not `compose:`.

### 7.4.1 Config translation

Config translation is the explicit path for turning external configuration formats into v4 Landofile data. Core owns the translation pipeline; plugins own format-specific translators.

Examples of external formats include Terraform outputs, framework metadata, hosting-provider config, cloud-service descriptors, and legacy Lando v3 Landofiles. v3 compatibility remains out of core: an external plugin MAY contribute a `lando-v3` translator, but core treats it the same as any other translator.

Rules:

- Translation never runs during Landofile discovery, normal config loading, `lando start`, or tooling hot-path bootstrap.
- A translator emits a partial Landofile fragment, not an `AppPlan`, provider-native plan, or imperative mutation.
- Core previews the generated fragment by default, then applies it only when the user explicitly requests a write through `lando app config translate --write` (§8.2.1).
- Generated fragments merge with the selected editable Landofile layer using the normal merge rules (§7.2), validate against the published Landofile schema (§7.8), write atomically (§12.3), and invalidate the app-plan cache (§12.1).
- Translator diagnostics MUST distinguish generated values, unsupported source semantics, non-portable provider extensions, and values requiring user review.
- Translator output MUST NOT include decrypted secret values. Secret references use `${secret:...}` and follow the same redaction rules as handwritten Landofiles (§7.3.1).
- Source files are read relative to the app root by default. Reading outside the app root requires the same explicit opt-in model as local includes (§7.7.6).

Illustrative contract (canonical schemas live in `@lando/sdk`):

```ts
export interface ConfigTranslator {
  readonly id: string;
  readonly summary: string;
  readonly inputKinds: ReadonlyArray<string>;
  readonly detect: (input: ConfigTranslateDetectInput) => Effect.Effect<ReadonlyArray<ConfigTranslateMatch>, ConfigTranslateError>;
  readonly translate: (input: ConfigTranslateInput) => Effect.Effect<ConfigTranslateResult, ConfigTranslateError>;
}

export interface ConfigTranslateDetectInput {
  readonly appRoot: AbsolutePath;
  readonly files?: ReadonlyArray<PortablePath>;
}

export interface ConfigTranslateMatch {
  readonly translator: string;
  readonly files: ReadonlyArray<PortablePath>;
  readonly confidence: "exact" | "likely" | "possible";
  readonly summary?: string;
}

export interface ConfigTranslateInput {
  readonly appRoot: AbsolutePath;
  readonly files: ReadonlyArray<PortablePath>;
  readonly current: LandofileConfig;
  readonly options: Record<string, unknown>;
}

export interface ConfigTranslateResult {
  readonly fragment: LandofileFragment;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
}
```

### 7.5 Global config

Global config lives at `<userConfRoot>/config.yml` plus optional `<userConfRoot>/config.d/*.yml`. Every key is overridable by env vars (§7.6).

Lando defaults to platform-conventional user roots rather than a single `$HOME/.lando` directory. The roots remain configurable so tests, embedded hosts, and users with existing layouts can isolate or relocate all Lando-owned files.

| Root | Purpose | Linux / BSD default | macOS default | Windows default |
|---|---|---|---|---|
| `<userConfRoot>` | User-edited config only | `${XDG_CONFIG_HOME:-$HOME/.config}/lando` | `$HOME/Library/Application Support/Lando` | `%APPDATA%\\Lando` |
| `<userCacheRoot>` | Disposable caches and logs | `${XDG_CACHE_HOME:-$HOME/.cache}/lando` | `$HOME/Library/Caches/Lando` | `%LOCALAPPDATA%\\Lando\\Cache` |
| `<userDataRoot>` | Persistent Lando-managed data | `${XDG_DATA_HOME:-$HOME/.local/share}/lando` | `$HOME/Library/Application Support/Lando` | `%LOCALAPPDATA%\\Lando\\Data` |
| `<systemPluginRoot>` | System-installed plugin search root (§9.3); plugins live under `<systemPluginRoot>/plugins/*` | `/usr/local/share/lando` | `/usr/local/share/lando` | `%PROGRAMDATA%\\Lando` |

`<userConfRoot>` is resolved before reading global config. Resolution order is: explicit runtime option (§16.3), `LANDO_USER_CONF_ROOT`, platform default. Because it determines where global config is read from, setting `userConfRoot` inside `config.yml` MUST NOT relocate that same config load. `<userCacheRoot>`, `<userDataRoot>`, and `<systemPluginRoot>` follow the same order with `LANDO_USER_CACHE_ROOT` / `LANDO_USER_DATA_ROOT` / `LANDO_SYSTEM_PLUGIN_ROOT`, then values from global config, then platform defaults. `<systemPluginRoot>` is read-only from Lando's perspective: system packages, OS package managers, or admins write to it; Lando never installs into it through `meta:plugin:add` (which always targets `<userDataRoot>/plugins/`).

```yaml
envPrefix: LANDO
domain: lndo.site
landoFile: .lando.yml
landoLockFile: .lando.lock.yml         # basename of the per-app includes + plugins lockfile (§7.7.4)
preLandoFiles:
  - .lando.base.yml
  - .lando.dist.yml
  - .lando.upstream.yml
postLandoFiles:
  - .lando.local.yml
  - .lando.user.yml
userConfRoot: <platform-default-user-conf-root>
userCacheRoot: <platform-default-user-cache-root>
userDataRoot: <platform-default-user-data-root>
systemPluginRoot: <platform-default-system-plugin-root>   # search root for system-installed plugins (§9.3, §12.4)

defaultProvider: lando                 # default Lando-managed runtime; setup may change for system providers
providers: {}

plugins: {}
pluginDirs: []
disablePlugins: []

bindAddress: 127.0.0.1

routing:
  enabled: true
  bindAddress: 127.0.0.1

network:
  proxy:
    http: null                         # explicit HTTP proxy URL; env vars still honored when null
    https: null                        # explicit HTTPS proxy URL
    noProxy: []                        # host/domain/IP patterns that bypass proxy
  ca:
    trustHost: true                    # use host trust store when platform support exists
    certs: []                          # additional CA certificate files for Lando-owned network clients

logger: pretty                         # which Logger plugin to use
renderer: lando                        # which Renderer plugin to use
toolingEngine: providerExec            # which ToolingEngine plugin to use

# Top-level CLI command aliasing (§8.1.2).
commandAliases:
  enabled: true                        # master switch for top-level aliases
  disabled: []                         # opt out of specific top-level aliases (e.g. ["start", "poweroff"])
  custom: {}                           # add user-defined top-level aliases mapping to canonical ids (e.g. halt: app:stop)

pluginConfig:
  "@lando/proxy-traefik":
    httpPort: 80
    httpsPort: 443
    httpFallbacks: [8000, 8080, 8888, 8008]
    httpsFallbacks: [444, 4433, 4444, 4443]

keys: true
maxKeyWarning: 10

scanner:
  enabled: true
  retry: 25
  timeout: 5000

healthcheck:
  retry: 25
  delay: 1000

logLevelConsole: info
experimental: false

stats:
  report: true                         # telemetry enabled by default; users may opt out
```

### 7.6 Environment overrides

Every global config key is overridable with an env var that uses the configured prefix (default `LANDO`).

Rules:

- Keys are converted from `camelCase` to `UPPER_SNAKE_CASE`.
- JSON-parseable string values are parsed into objects/arrays.
- `LANDO_PLUGIN_CONFIG_<NAME>` injects plugin config (JSON).
- `LANDO_PROVIDER_<PROVIDER>_*` adjusts a single provider's extension config.
- Standard proxy env vars (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, lowercase variants) are honored for Lando-owned network clients unless explicit `network.proxy` config overrides them.
- `LANDO_NETWORK_CA_CERTS` accepts a JSON array of additional CA certificate paths for Lando-owned network clients.

Examples:

```bash
LANDO_DOMAIN=example.test
LANDO_DEFAULT_PROVIDER=podman
LANDO_RENDERER=json
LANDO_PROVIDERS='{"podman":{"machine":"lando"}}'
LANDO_PLUGIN_CONFIG_AT_LANDO_PROXY_TRAEFIK='{"httpPort":8080}'
HTTPS_PROXY=http://proxy.corp.example:8080
NO_PROXY=localhost,127.0.0.1,.lndo.site
LANDO_NETWORK_CA_CERTS='["/etc/ssl/certs/CorpRootCA.pem"]'
```

### 7.7 Includes and fragments

`includes:` is the runtime composition primitive for Landofiles. It loads partial Landofile fragments from local paths, git, npm, or a future registry, and merges them into the including file before merge across files (§7.2). Fragments are pure config — they are never code.

```yaml
# .lando.yml
name: my-site

includes:
  - ./fragments/team-php.yml                          # local relative path
  - { source: ./fragments/team-tooling.yml, when: "{{ .env.LANDO_DEV }}" }
  - github:acme/lando-fragments/postgres-tuned.yml@v1.2.0
  - npm:@acme/lando-fragments/php-8.3.yml
  - { source: "registry:php-defaults", version: "^1.0.0" }

services:
  appserver:
    type: php:8.3
```

#### 7.7.1 Source schemes

| Scheme | Form | Resolution |
|---|---|---|
| Local | `./relative/path.yml` or `/absolute/path.yml` | Resolved relative to the including file. Must stay under the app root unless `--allow-include-outside-root` is set globally. |
| Git | `github:owner/repo[/path][@ref]`, `gitlab:…`, `bitbucket:…`, full `git+https://host/owner/repo.git[#ref][:path]` | Cloned (shallow) into `<userCacheRoot>/includes/git/<sha>/`. `@ref` may be a branch, tag, or commit; resolved ref is locked. |
| npm | `npm:@scope/pkg[/path][@version]` | Installed under `<userCacheRoot>/includes/npm/`. Path is relative to the package root. |
| Registry | `registry:<id>[@version]` | Resolved against the curated `includes.lando.dev` index (post-v4.0; reserved syntax at v4.0). |

Each include MAY be a bare string (path only) or an object with `{ source, when?, version? }`. The `when:` field is a config expression (§7.3.1) evaluated against the same context that resolves expressions in the including file; a falsy `when:` skips the include without error.

#### 7.7.2 Fragment shape

A fragment is a YAML or JSON document that is itself a partial Landofile — it MAY contain any combination of top-level keys (services, tooling, events, proxy, includes, providers, etc.). A fragment MUST NOT contain `name:` or `runtime:`; those are the including file's identity.

A fragment MAY itself declare `includes:`. Cycles are detected and rejected with `IncludeCycleError`. Maximum include depth is configurable globally (`includeMaxDepth`, default `8`).

#### 7.7.3 Merge semantics

- Includes resolve in array order. Later entries in the same `includes:` array override earlier entries on conflict, before the including file's inline keys are layered on top.
- The including file's inline keys always win over its own includes.
- Map/array merge rules from §7.2 apply unchanged.
- `!load` and `!import` inside a fragment resolve relative to the fragment's source location, not the including file.
- Configuration expressions inside a fragment use the including file's context. A fragment cannot define new variable bindings outside its own scope.

#### 7.7.4 Lockfile

`<appRoot>/.lando.lock.yml` (basename configurable globally via `landoLockFile:`) records the resolved versions, refs, and content checksums for every non-local include and every app-declared plugin source from `plugins:`. The lockfile is committed with the project. Resolution rules:

- If a lockfile entry exists for an include or app-declared plugin, that exact ref/version/checksum is used and verified.
- If no entry exists, the source is resolved fresh and a new lockfile entry is written.
- `lando includes update [<source>...]` refreshes one or more entries; with no arguments, refreshes all.
- `lando includes verify` re-checks every checksum without updating.
- A lockfile mismatch (checksum drift, missing source) fails with a tagged `IncludeLockError` and remediation pointing at `lando includes update`.

#### 7.7.5 Caching

Resolved fragment contents are cached under `<userCacheRoot>/includes/` keyed by source + ref + checksum. Cache reads are content-addressed and cross-app — a fragment used by multiple apps is fetched once.

Network access is required only when an include or app-declared plugin is missing from the cache, `lando includes update` is invoked, or the app build itself pulls remote artifacts/dependencies. Routine `lando start` / tooling invocations on a project with complete caches, a complete lockfile, and already-built app artifacts do not touch the network.

#### 7.7.6 Security

- Local includes are restricted to the app root by default. The `--allow-include-outside-root` global config flag opts into broader paths.
- Git and npm includes are pinned by ref and verified by checksum on every load. A drift fails closed.
- Registry includes (when implemented) require signature verification against the registry's published key.
- Fragments cannot execute code; the YAML/JSON parser rejects YAML tags other than `!load` / `!import` (§7.3) and the parser's allowlist.

#### 7.7.7 Distinction from related keys

| Key | Purpose | Resolution time |
|---|---|---|
| `includes:` (Lando, §7.7) | Compose whole-Landofile fragments from local/git/npm/registry sources | Per-file, before merge across files |
| `toolingIncludes:` (§8.5.8) | Import reusable tooling/task definitions with optional namespace | App-plan compile time |
| Compose `include:` | Compose-spec project fragments | Treated as a Compose-only subset of `includes:`; resolved through the same machinery (§7.4) |

### 7.8 Schema and documentation publication

Effect Schemas for the Landofile, global config, service config, expression AST/resolution errors, tooling config, route config, healthcheck config, plugin manifest, and event payloads are published from `@lando/sdk` and re-exported from `@lando/core/schema`. `@lando/sdk/schema` exposes a central public schema registry so build tooling can enumerate every schema that is part of the public contract.

Build-time schema publication produces:

- `dist/schemas/*.json` JSON Schema files for editor integration and external tooling. The default target is JSON Schema draft-07 for broad editor support; additional targets such as 2020-12 or OpenAPI 3.1 MAY be emitted when a consumer requires them.
- Generated MDX schema reference pages for the Starlight docs site. These pages are generated from Effect Schema AST traversal and annotations, not hand-maintained tables.
- A schema metadata index consumed by docs navigation, editor integration docs, and release checks.

Schema definitions MUST include useful annotations (`identifier`, `title`, `description`, and examples where helpful) because the same metadata powers validation errors, JSON Schema output, and generated docs. Human-authored docs remain in `docs/` and explain concepts and workflows; generated schema reference documents exact contract shape.

---
