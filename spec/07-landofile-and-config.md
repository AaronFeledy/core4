# Lando v4 — Landofile and Configuration

> **Part 7 of 18** · [Index](./README.md)
> **Read next:** [08 CLI and Tooling](./08-cli-and-tooling.md)

This part defines the user-facing configuration system. A Landofile is committed to a project repo and any developer can produce an identical, networked environment from it. Global config sits at `<userConfRoot>/config.yml` with optional `config.d/*.yml` overlays, and every key is overridable by environment variables.

Covered here: Landofile discovery rules and bounds, the six-file merge order with array-merge identity keys, the `load` and `import` expression helpers for reading external files, configuration expressions, the top-level Landofile keys, the supported Compose subset, explicit config translation, the explicitly forbidden wrapper keys (`compose:`, `recipe:`, `recipes:`), the global config schema, the env-var override naming convention, the `includes:` composition primitive with its source-resolution rules and lockfile, and how schemas are published from `@lando/sdk` as JSON Schema and generated documentation.

---

## 7. Landofile and Configuration

### 7.1 Discovery

A Landofile-bearing directory is identified by the presence of any of the merge files in §7.2. Discovery walks upward from CWD; the first matching directory becomes the *app root*. Discovery is bounded by:

- Filesystem root (`/`)
- A directory containing `.lando.stop` (sentinel for "stop walking here")
- A configurable `discovery.maxDepth` (default `8`)

Discovery uses `FileSystem.readdir` and is cached per-CWD for the lifetime of a CLI invocation.

#### 7.1.1 Landofile file forms

Lando v4 accepts the user-editable Landofile in **two file forms**:

| Form | Default basename | Role |
|---|---|---|
| **YAML (canonical, default)** | `.lando.yml` | The declarative form. The §7.2 six-file merge order applies as written. This is the form 99% of users will write and edit, and the form `lando init` (§8.8) emits. |
| **TypeScript (programmatic)** | `.lando.ts` | The programmatic form. Loaded by the embedded Bun runtime (§2.1, §3.4 `BunSelfRunner`) at parse time and required to **default-export an `Effect Schema`-validated `Landofile` value** matching the published Landofile schema (§7.8). Used when the declarative form would force unreasonable repetition (computing N replica services from an array, generating per-developer config from `process.env.USER`, deriving service names from a workspace package list, etc.). |

The two forms are **mutually exclusive within a merge layer**: a directory MAY contain `.lando.yml` *or* `.lando.ts` for the canonical layer, but not both. The same rule applies to every layer position in §7.2 — `.lando.base.{yml,ts}`, `.lando.dist.{yml,ts}`, `.lando.upstream.{yml,ts}`, `.lando.local.{yml,ts}`, `.lando.user.{yml,ts}`. Discovery scans for both extensions per layer; finding both at the same layer fails with a tagged `LandofileFormConflictError` and remediation telling the user which file to remove.

The TypeScript form's contract:

```ts
// .lando.ts — illustrative
import { defineLandofile } from "@lando/core/schema";
import process from "node:process";

export default defineLandofile({
  name: process.env.LANDO_APP_NAME ?? "myapp",
  services: Object.fromEntries(
    ["web-1", "web-2", "web-3"].map((id) => [id, {
      type: "lando",
      api: 4,
      base: "node:20",
      command: `node server.js --replica=${id}`,
    }]),
  ),
  tooling: {
    test: { service: "web-1", cmd: "bun test" },
  },
});
```

Required behaviors and constraints:

- `defineLandofile(value)` is a thin identity helper exported from `@lando/core/schema` (and re-exported from `@lando/sdk`) that pins the argument's TS type to the inferred `Landofile` shape, so authors get full editor completion. The runtime decode still goes through the canonical Landofile schema; `defineLandofile` is purely a typing convenience.
- The default export MUST be either a `Landofile` value or a function `(ctx: LandofileContext) => Landofile | Promise<Landofile> | Effect.Effect<Landofile, LandofileError>`. The function form receives a constrained context: `{ cwd, env, host: { os, arch, platform, isWsl }, layer, mergeAccumulator, secrets }` — equivalent to the §7.3.1 expression scopes plus an explicit accumulator for layered evaluation.
- The `secrets` field of `LandofileContext` is a deferred-resolver, NOT a populated map: `secrets.read("MY_SECRET")` returns an `Effect` that resolves the secret through `SecretStore` at the same evaluation point a `${secret:MY_SECRET}` expression in the YAML form would resolve. This keeps the redaction guarantees of §7.3.1 intact for the TS form.
- The module is loaded by `LandofileService` (§3.4) through Bun's TS loader. No build step is required; the same TS-loader path that powers `plugin.ts` (§9.1) and `.bun.ts` tooling scripts (§8.5.9) loads `.lando.ts`. Library-mode embedding hosts (§16) get the same loader through the embedded Bun.
- Side-effects at module top level are **forbidden**. The module MUST be pure: imports, `defineLandofile(value)`, `export default`. Any I/O happens inside the function form's body and is run inside an `Effect.timeout` (default 5 s; configurable via global `landofile.tsTimeoutMs:`). Top-level `await`, file reads, network calls, or `console.log` calls cause the loader to fail with `LandofileTopLevelSideEffectError`.
- The decoded result is cached the same way YAML Landofiles are cached: by file mtime and size in the `app-plan` cache (§12.1). Re-decoding only happens when the `.lando.ts` file changes or any file the function explicitly reads through `FileSystem` changes.
- `lando app config edit` (§8.2.1) refuses to edit a `.lando.ts` file in v4.0 — programmatic Landofiles are author-mode artifacts and the structured `set` / `unset` / `validate` semantics don't translate cleanly to a TypeScript module. `lando app config view --source resolved` works on both forms identically.
- The `${VAR}` shell-parameter-expansion (§7.3.1) is **not** evaluated against TS-form output: a TS-form Landofile uses native `process.env` access. Embedded `{{ … }}` expression strings *are* still resolved against the merged tree post-evaluation, so a TS-form Landofile can emit `{ env: "{{ host.platform }}" }` and have it resolved at the same staged-bootstrap-level point a YAML Landofile would.
- Compatibility with `includes:` (§7.7) is full: a TS-form Landofile MAY declare `includes: [...]` in its returned value, and the included fragments merge into its tree per §7.7. The reverse — a YAML Landofile including a TS fragment — is supported via the same loader.

The TS form is **opt-in and intentionally rare**. Recipes ship YAML by default; templates only emit TS when the recipe author needs the programmatic form. The §7.8 schema reference docs and the §13.2 schema gates apply to both forms equally because both decode to the same `Landofile` shape.

### 7.2 Merge order

Default load order (low → high precedence):

```text
1. .lando.base.yml         [advanced]
2. .lando.dist.yml          first-class
3. .lando.upstream.yml     [advanced]
4. .lando.yml               first-class — the canonical file (filename configurable globally)
5. .lando.local.yml         first-class
6. .lando.user.yml         [advanced]
```

The three **first-class** layers (`dist`, canonical, `local`) cover ~99% of projects: ship-with-the-repo defaults, the canonical file, and per-developer overrides. The three **advanced** layers (`base`, `upstream`, `user`) exist for organizations with cross-repo policy injection or per-user host-wide defaults; ordinary documentation, tutorials, and `lando init` output reference only the first-class trio. Cross-repo composition that crosses package or organization boundaries SHOULD use `includes:` (§7.7) rather than relying on the advanced layers — `includes:` is strictly more powerful (versioned, lockfile-tracked, namespaceable).

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
- Each layer position above accepts the YAML form (`.lando[.layer].yml`) **or** the TypeScript form (`.lando[.layer].ts`) per §7.1.1, but not both at the same layer. A directory MAY mix forms across layers (e.g., a YAML `.lando.dist.yml` plus a TS `.lando.ts`); the merge happens after both forms decode to the same `Landofile` shape.

### 7.3 Loading external file content

External files become Landofile values through two pure expression helpers:

- `load(path) → FileRef` — read a file and return a value-shaped reference to its contents.
- `import(path) → ImportRef<T>` — same as `load`, but the result preserves source provenance (original filename, layer) for downstream consumers that need it.

```yaml
services:
  app:
    command: "{{ load('scripts/start.sh') | text }}"
    environment: "{{ load('environment.yml') | yaml }}"
    metadata:
      json: "{{ load('config.json') }}"             # extension-inferred → json
      binary: "{{ load('cert.der') | bytes }}"

security:
  ca:
    - "{{ import('certs/CorpRootCA.pem') }}"        # provenance preserved for the CA installer
```

Earlier drafts of this spec defined `!load` and `!import` as YAML scalar tags. Tags are removed in v4.0; the same patterns are spelled as expression-helper calls so they share the §7.3.1 expression engine's syntax, scopes, error model, and caching. The translation is mechanical — `command: !load script.sh @string` becomes `command: "{{ load('script.sh') | text }}"`.

#### `FileRef` value

`load(path)` returns a `FileRef` — an opaque value with metadata properties accessible through standard dotted access (the same syntax used for any other value path):

| Property | Type | Meaning |
|---|---|---|
| `.path` | `string` | Absolute path the read resolved to, after symlink and relative resolution |
| `.size` | `number` | File size in bytes |
| `.mime` | `string` | MIME type derived from extension (matches `Bun.file(p).type`) |
| `.checksum` | `string` | Lowercase hex SHA-256 of the bytes |
| `.encoding` | `string` | Detected encoding: `"utf-8"`, `"binary"`, or `"ascii"` |

```text
{{ load('./logo.png').size }}
{{ load('./logo.png').mime }}             # → "image/png"
{{ load('./composer.lock').checksum }}
```

The bytes themselves are obtained via the decoders below.

#### Decoders

Decoders are pipe filters that turn a `FileRef` into a structured or scalar value:

| Decoder | Result |
|---|---|
| `text` | UTF-8 string contents |
| `json` | Parsed JSON value |
| `yaml` | Parsed YAML value (a strict superset of JSON) |
| `fromToml` | Parsed TOML value (paired with the existing `fromJson` and `fromYaml` helpers) |
| `bytes` | Raw bytes (`Uint8Array`) |

```text
{{ load('./script.sh') | text }}
{{ load('./config.json') | json }}
{{ load('./Cargo.toml') | fromToml }}
{{ load('./fixtures/cert.der') | bytes }}
```

When a `FileRef` is consumed without an explicit decoder, the decoder is **inferred from the file extension**:

| Extension | Implicit decoder |
|---|---|
| `.json` | `json` |
| `.yml`, `.yaml` | `yaml` |
| `.toml` | `fromToml` |
| anything else | `text` |

So `load('./composer.json')` and `load('./composer.json') | json` produce the same value. The explicit form is unambiguous and SHOULD be preferred when the file extension does not match its content.

A positional second argument is sugar for the pipe form:

```text
load('./script.sh', 'text')           # ≡ load('./script.sh') | text
load('./config.json', 'json')         # ≡ load('./config.json') | json
```

Valid decoder names: `"text"`, `"json"`, `"yaml"`, `"fromToml"`, `"bytes"`. Any other value throws `ConfigExpressionError` at expression-eval time.

#### Picking a single value from a structured file

The standard pattern for reading one value out of a JSON / YAML / TOML config file is `load → decode → extract`:

```yaml
services:
  appserver:
    type: php
    # Safe walk with default — get(value, path, default?)
    version: "{{ load('./composer.json') | json | get('config.platform.php', '8.3') }}"

  node:
    type: node
    # Strict walk via direct dotted access — parens disambiguate from "pipe to property"
    version: "{{ (load('./package.json') | json).engines.node }}"

  rust:
    type: rust
    # Same shape, different format
    version: "{{ load('./Cargo.toml') | fromToml | get('package.rust-version') }}"

tooling:
  install:
    service: appserver
    sources: ["composer.lock"]
    # Fingerprint a sub-tree for cache invalidation
    checksum: "{{ hash(load('./composer.lock') | json | get('content-hash')) }}"
```

Distinction between the two extraction styles:

- `get(value, path, default?)` returns the default (or `null`) when any segment of the path is missing. Use when the value or key may be absent.
- `(value).a.b.c` throws `ConfigExpressionError` with the failing segment when any intermediate key is missing. Use when the value is required.

`get()` accepts the same path-access syntax as the rest of the language:

```text
get(obj, 'a.b.c')                       # dotted
get(obj, 'scripts.test:unit')           # only `.` separates; colons in keys are fine
get(obj, 'exports["./index.js"]')       # bracket-escape keys with dots
get(obj, ['a', 'b', 'c'])               # array form for fully unambiguous paths
```

Plain text plus regex covers the non-structured case:

```yaml
node-version: "{{ load('./.nvmrc') | text | trim }}"
php-version: "{{ load('./.tool-versions') | text | regexMatch('^php (.+)$', 'm') | get(1) }}"
```

#### `ImportRef<T>` and provenance

`import(path)` returns an `ImportRef<T>` — the same value `load(path)` would produce, wrapped with source metadata for consumers that act on it:

| Property | Type | Meaning |
|---|---|---|
| `.value` | `T` | The decoded inner value (string, parsed structure, or bytes) |
| `.path` | `string` | Path as written in the Landofile (pre-resolution) |
| `.basename` | `string` | Original basename — used by consumers like the CA installer to pick an in-container filename |
| `.checksum` | `string` | Lowercase hex SHA-256 of the bytes |
| `.layer` | `string` | Which Landofile layer the call originated from, per the §7.2 merge order |

Schema positions that accept `ImportRef<T>` are annotated `acceptsImportRef: true` in the published Landofile schema (§7.8). Using `import()` at any other position fails validation with `LandofileImportRefMisuseError` and remediation pointing to the closest accepting key. The annotation is enumerable from `dist/schemas/landofile.json`.

Most users will reach for `load()` for value-picking and `import()` only when a downstream consumer documents that it wants provenance — chiefly the CA installer at `security.ca:` (§6.8).

#### Path resolution and security

Paths passed to `load()` and `import()` resolve relative to:

- The Landofile's directory when the call appears in a Landofile or any of its `includes:` fragments. A call inside a fragment resolves against the *fragment's own* source location, not the file that included it.
- The recipe's directory when the call appears in a recipe scaffold (§8.8).
- The mount template's directory when the call appears in a `mounts: type: template` body (§6.4).

Containment rules (mirroring §7.7.6):

- The resolved path MUST stay under the app root.
- Absolute paths and paths that traverse outside the app root via `..` or symlinks are rejected with `LandofileLoadOutsideRootError`.
- The `--allow-load-outside-root` global config flag opts into broader paths. Setting it is logged at `info` level on every load that uses the relaxation.

Source schemes:

- `load()` and `import()` accept **local paths only** at v4.0. Remote retrieval of value-level content is intentionally out of scope; use `includes:` (§7.7) for fragment-level remote composition.

#### Caching and limits

Every successful `load()` and `import()` call contributes its `(absolutePath, size, mtime, sha256)` tuple to the **app-plan cache key** (§12.1). When any referenced file's bytes change, the plan is recomputed; when only `mtime` drifts but the bytes are unchanged, the plan is reused. A file's content hash is computed once per resolution and reused across decoders applied to the same `FileRef`.

`load()` reads are **eager** — the read happens at expression-eval time and the bytes are captured before the `FileRef` is returned. The `Bun.file()`-style "lazy handle" mental model survives in the value shape (metadata accessible without further IO) but reads themselves are synchronous and complete before the FileRef is observable. This is forced by §7.3.1's synchronous expression contract.

Limits (overridable in global config, §7.5):

| Limit | Default |
|---|---|
| `loadMaxFileBytes` | `1 MiB` |
| `loadMaxFilesPerExpression` | `16` |
| `loadMaxRecursionDepth` | `4` |

Exceeding any limit throws a tagged `LandofileLoadLimitError` with remediation pointing at the global config key.

### 7.3.1 Configuration expressions

Lando supports a small, pure expression language in configuration strings and template files. The syntax is designed to feel familiar regardless of whether you come from Go templates, Handlebars, Twig/Jinja/Liquid, or shell-parameter-expansion: `{{ … }}` interpolation with bracketed-or-dotted paths, both pipe filters and positional helper calls (transparently equivalent), and native shell-style `${VAR}` substitution. The same language is used by the `lando` template engine described in §7.3.2 — a single-line expression in a Landofile string and a multi-line template under `mounts: type: template` (§6.4) parse identically and share a context.

```yaml
name: "{{ env.PROJECT_NAME | default(app.basename) }}"

services:
  appserver:
    type: lando
    environment:
      APP_ENV: "{{ env.APP_ENV | default(\"local\") }}"
      # Native shell-parameter-expansion is part of the same engine:
      LISTEN_PORT: "${PORT:-8080}"
      DOCROOT: "${DOCROOT:?docroot is required}"

tooling:
  test:
    service: appserver
    cmds:
      - "php vendor/bin/phpunit {{ raw | shellJoin }}"
```

#### Syntax

| Form | Meaning |
|---|---|
| `{{ expr }}` | Interpolate an expression value. |
| `{{- expr }}` / `{{ expr -}}` / `{{- expr -}}` | Trim leading / trailing / both whitespace around the rendered value (Twig/Jinja-style). |
| `{{# comment #}}` | Comment; produces no output. |
| `{{ if expr }}` … `{{ else if expr }}` … `{{ else }}` … `{{ end }}` | Conditional block (whole-file render only — see §7.3.2). |
| `{{ for name in expr }}` … `{{ end }}` | Iteration over an array; binds `name` per item. |
| `{{ for key, value in expr }}` … `{{ end }}` | Iteration over an object; binds `key` and `value`. |
| `${VAR}` | Substitute the named scope value `VAR` from the active context (typically a key under `env.*`, `vars.*`, or `service.*` depending on render site). Empty string when unset. |
| `${VAR:-default}` | Use `default` when `VAR` is unset or empty. |
| `${VAR-default}` | Use `default` only when `VAR` is unset (set-but-empty stays empty). |
| `${VAR:?message}` | Render error tagged `ConfigExpressionError` when `VAR` is unset or empty. |
| `${VAR:+alt}` | Use `alt` when `VAR` is set and non-empty; empty otherwise. |
| `$VAR` | Bare form of `${VAR}`; recognized only when followed by a non-identifier character (or end-of-string). Use the brace form anywhere ambiguity is possible. |
| `{{{{` / `$${` | Escapes for a literal `{{` or `${` respectively. |

#### Paths and lookups

```text
app.name
service.endpoints[0].port
vars["my-key"]
env.HOME
```

Bracket notation works for arrays, for keys with non-identifier characters, and for dynamic keys (`vars[env.LOOKUP_KEY]`). Dotted paths and bracket lookups compose freely.

#### Filters and helpers

Pipe filters and positional helper calls are equivalent. `x | f(a, b)` and `f(x, a, b)` parse to the same AST node. The two forms exist so that users coming from Twig/Jinja/Liquid/Blade and users coming from Handlebars/Go-template each see their familiar idiom; documentation always shows both forms in examples. There is no semantic difference, no precedence trickery, and no "preferred" form.

```text
{{ env.PORT | default(8080) }}             # pipe form
{{ default(env.PORT, 8080) }}              # call form — identical AST

{{ app.name | upper | trim }}              # filter chain
{{ trim(upper(app.name)) }}                # call chain — identical AST

{{ paths.userCacheRoot | path.join("foo") }}
{{ path.join(paths.userCacheRoot, "foo") }}
```

Built-in functions (all pure, deterministic, and redaction-safe). Most stay flat for use in pipe chains; domains with multiple related operations are namespaced.

**Logical and comparison:** `default`, `required`, `eq`, `ne`, `lt`, `gt`, `and`, `or`, `not`, `contains`, `startsWith`, `endsWith`.

**String:** `lower`, `upper`, `trim`, `split`, `join`, `replace`, `regexMatch`.

**Collection:** `length`, `slice`, `keys`, `values`, `entries`, `get`, `merge`, `range`, `map`, `filter`.

**Format (encode and parse pairs):** `json`, `fromJson`, `yaml`, `fromYaml`, `fromToml`, `b64encode`, `b64decode`.

**File IO** (the file-read carve-out, see §7.3): `load`, `import`, `text`, `bytes`, `hash`.

**Shell-form:** `shellQuote`, `shellJoin`.

**Process facts:** `which`, `glob`.

**Namespaced:**

| Namespace | Helpers |
|---|---|
| `path.*` | `path.join`, `path.dirname`, `path.basename`, `path.extname`, `path.relative`, `path.resolve` |
| `fs.*` | `fs.exists`, `fs.isFile`, `fs.isDir`, `fs.size` |
| `url.*` | `url.build`, `url.parse` |
| `semver.*` | `semver.satisfies`, `semver.compare` |

A dotted name whose first segment matches a namespace (`path`, `fs`, `url`, `semver`) is a function reference and MUST be called. All other dotted forms are value path access (per "Paths and lookups" above). Namespaces are a closed set published in `@lando/sdk`; plugins MAY contribute additional namespaces through the manifest contribution surface (§9.5) provided the new namespace name does not collide with an existing scope. The singular helper namespace `path.*` is distinct from the plural scope `paths.*` (see the scope table below); the spelling is the only disambiguator.

**Deprecated aliases (removed in v5.0):** `pathJoin` → `path.join`, `pathDirname` → `path.dirname`, `pathBasename` → `path.basename`. The old names continue to work through v4.x and emit a `DeprecationNotice` per §18 on first use.

The function set is published from `@lando/sdk` as a portable utility module so plugin-contributed template engines (§7.3.2, §9.5) can register the same names under their idiomatic registration API. Plugins MAY contribute additional pure functions through the expression-function contribution surface (§9.5); core schemas and docs MUST identify which functions are portable.

#### Result types

A string whose entire content is exactly one `{{ expr }}` (no surrounding text, no `${…}`, no other interpolation) preserves the expression's result type — `boolean`, `number`, array, object, or `null`. A string that interpolates expressions or `${VAR}` forms with surrounding text always renders as a string. This rule applies to Landofile values; whole-file template rendering (§7.3.2) always produces text.

#### AST and staged, bootstrap-level-aware resolution

Expressions are parsed into an **AST at Landofile parse time**. Parsing is cheap, IO-free, and produces no values; it is what is cached in the app-plan cache (§12) alongside the rest of the resolved Landofile.

Each AST node records the **scopes** it touches. Scopes have a known minimum bootstrap level (§3.2):

| Scope | Min bootstrap level | Source |
|---|---|---|
| `host.{os,arch,platform,isWsl}` | `none` | Process facts |
| `env.<NAME>` | `none` | Process environment after global env-override handling |
| `paths.{userConfRoot,userCacheRoot,userDataRoot}` | `none` | Resolved Lando roots |
| `app.{name,root,basename,slug}` | `minimal` | Landofile discovery + slug derivation (§7.4) |
| `global.<key>` | `minimal` | Resolved global config values that are safe to expose |
| `loader` (`load(...)`, `import(...)`) | `minimal` | Landofile-relative file IO; bytes contribute to the app-plan cache key (§7.3, §12.1) |
| `vars.<key>` | varies (≥ origin's level) | Variables from the nearest expression scope (Landofile `vars:`, mount `vars:`, tooling `vars:`, etc.) |
| `service.{name,type,primary}` | `plugins` | Service-type resolution (the *self*-service the expression renders inside) |
| `service.creds.{user,password,database,rootPassword}` | `plugins` | Self-service credentials, populated by service-types that opt in to the `creds:` schema (§6.12.4). Absent on service-types without creds. |
| `service.{hostnames,routes,endpoints}` | `app` | App planning (§5.5) |
| `services.<name>.{type,primary,creds,hostnames,routes,endpoints}` | `app` | **Cross-service** references: read-only view of another service's resolved plan. The named service must exist in the same app; absent or misnamed references fail with `ConfigExpressionError`. Cyclic cross-service expression chains are detected and rejected at plan time. |
| `plugin.<id>.{root,config,version}` | `plugins` | Plugin-local file roots and metadata for the plugin that *owns* the surrounding contribution (service-type, feature, recipe, command). `root` is the plugin's package root; `config` is `<root>/config` by convention. Resolves to the contributing plugin even when the expression is reused across multiple plugins. |
| `info.{status,containerIp,…}` | `provider` | Post-start runtime info |
| `secrets.<key>` | per-`SecretStore` (typically `minimal`) | `${secret:…}` references resolve through `SecretStore` (§4.2) |
| `globalServices.<name>.{type,primary,creds,hostnames,routes,endpoints}` | `app` | Cross-service references into the **global Lando app**'s resolved plan (§20.8.3). The named global service must exist in the resolved global plan AND must be in the current user app's set of `AppFeature.requires.globalServices` (§6.11.4, §20.6.3); references outside that set fail with `ConfigExpressionScopeNotPermittedError` to avoid implicit cross-app coupling. |
| `task`, `flags`, `args`, `raw`, `sources`, `generates`, `checksum`, `timestamp` | tooling invocation | Per-step tooling context (§8.5.4) |
| `event` | event dispatch | Subscriber invocation payload |
| `answers`, `recipe`, `destination`, `flags`, `cwd` | recipe init | Recipe scaffold context (§8.8.6) |

An expression's **effective level** is the maximum minimum-level across every scope it references. Resolution is **staged**: each consumer (planner, healthcheck runner, tooling step, mount materializer, event subscriber, …) calls `ConfigService.resolve(node, currentLevel)` and either receives the resolved value, when `currentLevel >= node.minLevel`, or a typed `DeferredExpression` thunk that the consumer passes through to a downstream consumer running at a higher level. Re-entry at the higher level resolves the thunk in place; the thunk is opaque to lower-level code paths.

Practical consequences:

- Hot-path commands at level `none` (§3.2) never parse or render an expression that requires `service.*` or `info.*`. They see only opaque thunks in the cached plan.
- A typo in `service.bogus` fails at the consumer that requires it, not at parse time, with a tagged `ConfigExpressionError` that includes the expression path, source location, and remediation.
- A template that requires `service.endpoints[0].port` is rendered by the planner (level `app`) and the rendered output is what the provider applies; the cached plan stores both the AST and the most recent rendered output keyed by content+vars hash (§12.1 `template-render` cache).
- Rendering is driven by the consumer at the consumer's bootstrap level, never coupled to YAML parse, so bootstrap level escalation cannot happen accidentally.

#### Purity and safety

- Expressions and templates are pure and deterministic. They MUST NOT execute shell commands, perform network IO, or mutate process or global state. The only file IO permitted is via `load()` / `import()` (§7.3), where the read is captured in the app-plan cache key, plus the implicit read of a template body itself (resolved before render). Shell-backed dynamic values are allowed only in tooling-specific `vars.<name>.sh` (§8.5.3), where execution is explicit and goes through `ToolingEngine` / `ProcessRunner`.
- Cyclic references, unknown paths at the consumer's level, type mismatches, and out-of-range bracket lookups all fail with a tagged `ConfigExpressionError` that includes the expression path, the source location, and remediation.
- `${secret:KEY}` is a secret reference (distinct from `${KEY}` shell-parameter-expansion: the `secret:` prefix is the marker). Secret values resolve through `SecretStore` (§4.2), MUST be redacted in logs/errors and lifecycle event payloads, and MUST NOT be written decrypted into caches (§12). Secret references that appear inside `${VAR}` shell-style substitutions follow the same redaction rules.
- A plugin-contributed engine (§7.3.2) MUST honor the same purity guarantees. An engine that cannot — for example, a template engine whose helper API permits arbitrary host-side code — declares `unsafe: true` in its manifest contribution; `unsafe` engines are disabled by default and require explicit global config opt-in (§9.5).

#### Helper design conventions

The §7.3.1 helper set is the pure, sync, dev-env-relevant subset of Bun's first-party utilities, with a small set of Lando-specific rules where Bun's conventions do not apply to a sync-pure-deterministic helper language:

1. **Synchronous, pure, deterministic, no-network, no-mutation.** Helpers run synchronously (there is no await in expressions) and MUST NOT execute shell commands, perform network IO, or mutate process or global state. The single explicit carve-out is file IO via `load()` / `import()`, where the read is part of the cache key (§7.3).
2. **No `Sync` suffix.** Bun uses `gzipSync` / `spawnSync` to disambiguate from async siblings. Lando expression helpers have no async siblings; the suffix would be redundant and misleading.
3. **Flat naming with namespaces only when ≥2 operations share a domain.** Most helpers stay flat for use in pipe chains. Domains with multiple related operations are namespaced (`path.*`, `fs.*`, `url.*`, `semver.*`). The first identifier in a dotted form is matched against the namespace registry; if it is a known namespace, the dotted form is a function reference and MUST be called.
4. **Polymorphic conversion via a trailing `format` string parameter.** Helpers that produce multiple representations of the same value take a string `format` argument from a fixed closed set, e.g. `hash(data, "sha256", "hex")`. Invalid format values throw `ConfigExpressionError` at expression-eval time when the value is statically known.
5. **Optional configuration via a final `opts` object literal.** When a helper has more than one optional knob, they MAY be collected into a single trailing object so the call site stays readable. Positional args are reserved for required parameters and the polymorphic `format` parameter from rule 4.
6. **Return shapes mirror Web and Node standards verbatim.** `url.parse` returns the field set of the WHATWG `URL`; `path.parse` returns the field set of `node:path.parse`. Lando does not invent new field names where a standard exists.
7. **Error model.** Converters return `null` on un-interpretable input — compose with `default(...)` or `required(...)`. Parsers (`fromJson`, `fromYaml`, `fromToml`) throw `ConfigExpressionError` with line and column. Predicates return `false` for bad input. Misconfiguration (unknown algorithm, unknown format) throws.

A Bun-mapping table is published as part of the §7.8 generated reference for every helper that has a Bun source. When Bun's behavior shifts in a way that would change a helper's contract, Lando either re-pins to Bun's new behavior or freezes to the old and documents the divergence in the helper's reference page.

Plugins MAY contribute additional helpers and namespaces through the contribution surface (§9.5). Contributed helpers MUST satisfy the same constraints; the SDK provides a contract test suite (§13.1) every helper passes.

### 7.3.2 Template engines

Template rendering is pluggable. Core ships the `lando` engine (§7.3.1) as the default and bundles two additional engines (`handlebars`, `mustache`) for users with existing template files in those formats. Any plugin may contribute additional engines through the `templateEngines:` manifest surface (§9.5); selection follows the standard precedence rules (§4.3).

The same `lando` engine renders every template surface in the system: Landofile string-value interpolation (§7.3.1), `mounts: type: template` (§6.4), recipe `templates/**/*.tmpl` files (§8.8.6), and any other site that renders text. Plugin-contributed engines rendering whole files MAY be selected per file site; engines other than `lando` MUST NOT be used for Landofile string-value interpolation (the `lando` engine's syntax *is* the Landofile expression contract).

Engine selection precedence at any render site:

```text
1. Explicit `engine:` field at the render site
2. File extension match against installed engines' `extensions:` lists
3. Landofile-level `defaultTemplateEngine:` (where the site supports it)
4. Global config `defaultTemplateEngine:` (default: lando)
5. Sole installed implementation
6. Tagged `TemplateEngineUnresolvedError` with remediation suggesting an `engine:` value or plugin to install
```

Bundled engines and conventional file extensions:

| Engine id | Default file extensions | Notes |
|---|---|---|
| `lando` | `.tmpl`, `.tpl`, no extension | Built into core, always available. The default. Implements the §7.3.1 syntax. Whole-file rendering supports the full `{{ if }}` / `{{ for }}` / comment / whitespace-trim grammar. Single-string rendering (used for Landofile string-value interpolation) supports interpolation, filters, helpers, and `${VAR}` substitution but not control-flow blocks. |
| `handlebars` | `.hbs`, `.handlebars` | Bundled as `@lando/template-handlebars` in the default install. Configured with `noEscape: true` and `strict: true` so config-file rendering does not HTML-escape and missing keys fail loudly. The §7.3.1 function set is registered as Handlebars helpers under the same names. The template render context (below) is exposed as the Handlebars data context. Recipe-level partials are available via `{{> name}}` when the surrounding site supplies named partials. |
| `mustache` | `.mustache` | Bundled as `@lando/template-mustache` in the default install. Logic-less by design. Useful for cross-language templates that the user already maintains in Mustache form. Helper functions are not invocable from Mustache (the engine has no helper concept); callers that need helpers should use `lando` or `handlebars`. |

A user who is satisfied with the binary footprint MAY disable bundled engines through plugin disablement (§7.5 / §9). The `lando` engine cannot be disabled — it is built into core and backs the Landofile expression contract itself.

#### Render context

Every engine receives a context object with a stable, schema-defined shape (`TemplateRenderContext` in `@lando/sdk/schema`). The context is identical across engines; engines differ only in accessor syntax (e.g., `{{ app.name }}` in `lando`, `{{app.name}}` in `handlebars`, `{{app.name}}` in `mustache`). The shape is the union of the scopes published in the §7.3.1 scope-to-bootstrap-level table; each render site publishes the subset that is meaningful at the consumer's effective bootstrap level. Sites that render before `app` planning (§5.5) MUST NOT include `service.*` or `info.*` in the context.

A site MAY merge per-render `vars:` into the `vars.<key>` scope. Resolution precedence for `vars.*` at a given site:

```text
1. Per-render `vars:` (e.g. on a single mount entry)
2. Landofile-level `templateVars:` (§7.4)
3. Engine defaults (engine plugins MAY ship a small, documented set; the `lando` engine ships none)
```

#### Engine contract (illustrative)

The canonical schema lives in `@lando/sdk`. The shape:

```ts
export interface TemplateEngine {
  readonly id: string;
  readonly extensions: ReadonlyArray<string>;
  readonly capabilities: TemplateEngineCapabilities;

  readonly compile: (
    input: TemplateCompileInput,
  ) => Effect.Effect<CompiledTemplate, TemplateCompileError>;

  readonly render: (
    template: CompiledTemplate,
    context: TemplateRenderContext,
  ) => Effect.Effect<string, TemplateRenderError>;
}

export interface TemplateEngineCapabilities {
  readonly wholeFile: boolean;             // multi-line render with control flow
  readonly stringInterpolation: boolean;   // single-string render for Landofile values
  readonly partials: boolean;              // engine supports named partials
  readonly unsafe: boolean;                // engine cannot guarantee §7.3.1 purity
}
```

`wholeFile`-only engines (most third-party engines) cannot replace the `lando` engine for Landofile string-value interpolation; they may only be selected at sites that render whole files. The `lando` engine is the only built-in engine that satisfies both `wholeFile: true` and `stringInterpolation: true`.

Compiled templates are content-addressed and cached at `<userCacheRoot>/templates/<engineId>/<contentHash>.bin` (§12.1 `template-render` cache). Rendered output is cached at the same path with `<contentHash>-<varsHash>.bin`; re-renders are skipped when neither template content nor resolved vars change.

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

remotes:                               # named RemoteSource configs for `lando pull`/`push` (§10.12); feature is 4.1
  <name>:
    source: <remoteSource-id>          # e.g. pantheon | rsync | s3 | local; validated by that source's configSchema
    <source-specific-config>           # e.g. site/token (pantheon), host/path (rsync), bucket/prefix (s3)
sync:                                  # optional Dataset→service bindings (usually inferred; §10.12)
  <datasetId>:
    service: <service-name>
    path: <container-path>             # files datasets only

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

The slug `global` is **reserved** for the global Lando app (§20.2). A user app whose resolved `name:` (or directory-basename-inferred name) normalizes to `global` is rejected at parse time with `AppIdReservedError` and remediation suggesting an explicit `name:`. The global app's own Landofile lives at `<userDataRoot>/global/.lando.yml` and is excluded from cwd-based discovery (§20.3.2); only `meta:global:*` commands resolve to it.

**Scratch apps live in a separate identifier namespace.** Unlike `global`, scratch app ids do **not** consume the user-app slug namespace. The `kind` field on `AppRef` (`"user"` | `"global"` | `"scratch"`; §11.2, §21.2) splits the namespace so a user app named `scratch-foo` and a scratch app whose id happens to begin with `scratch-foo-` coexist without collision: caches are keyed by `(kind, id)` (§12.1), provider labels carry both `dev.lando.storage-project` (the id) and `dev.lando.scratch-id` (the scratch id, only on scratch apps; §6.5, §21.8), and DNS aliases (`<service>.<id>.internal`) are unique by virtue of the scratch id's 6-hex suffix (§21.2). No parse-time rejection applies; a user authoring `name: scratch-foo` is legal and produces a user app with that slug.

The slug normalization, the basename inference, and the collision policy are all part of the published Landofile schema metadata so embedding hosts and editor tooling produce the same identity Lando does.

**Compose compatibility.** A Landofile accepts a documented subset of the Compose project spec. The subset covers common Compose features and every Compose feature Lando uses internally. Lando adds higher-level keys (`includes:`, `tooling:`, `toolingDefaults:`, `toolingIncludes:`, `events:`, `proxy:`, plugin config, service shortcuts) and accepts simplifications, but it does not promise that every valid Compose project document is valid Landofile input.

Rules:

- Top-level Compose project keys including `services:`, `volumes:`, `networks:`, `configs:`, `secrets:`, `include:`, and `x-*` extension fields are accepted when their shapes are in the supported subset.
- Compose service keys are accepted under `services.<name>` alongside Lando service extensions (§6.2) when their shapes are in the supported subset.
- The supported subset MUST be published as a schema-backed key matrix in the docs. Unsupported Compose keys fail closed with remediation pointing to a Lando key, provider extension, or config translator.
- Compose's obsolete top-level `version:` is accepted for compatibility, ignored for behavior, and MUST emit a `DeprecationNotice` per §18 (kind: `landofile-key`, id: `version`); the notice is shown by `lando config --format yaml` and recorded by `DeprecationService` (§18.3) so `lando doctor --deprecations` lists it.
- Compose fields that normalize cleanly become provider-neutral `AppPlan` fields (§5.5.1).
- Compose fields without provider-neutral semantics are preserved in plan extensions and require a provider that declares the needed Compose capability. They MUST NOT be silently dropped.
- Lando-specific keys win over equivalent Compose shorthand during normalization. For example, `services.web.endpoints:` wins over endpoint intent inferred from `services.web.ports:`.
- `lando config --format yaml` SHOULD render the post-merge, post-normalization config so users can see how Compose and Lando keys were resolved.
- The canonical import surface is **`includes:`** (§7.7), which accepts a `kind:` discriminator: `landofile` (the default — whole-file fragment merge), `tooling` (tooling-only fragments per §8.5.8), or `compose` (Compose-spec project fragments). Each kind preserves its own resolution timing and namespacing rules; the unification is at the *surface* level so authors learn one key.
- `toolingIncludes:` is sugar for `includes: [{ source, kind: tooling, ... }]` and is preserved as an idiomatic shorthand. New documentation, generated examples, and `lando init` output use `includes:` with `kind: tooling`; `toolingIncludes:` MAY appear interchangeably and is not deprecated. Both surfaces resolve through the same machinery.
- Compose's top-level `include:` is recognized as `includes: [{ ..., kind: compose }]`. When both `includes:` and a top-level `include:` appear in the same file, `include:` entries are appended to the resolved `includes:` list with `kind: compose`. Lando's `includes:` is otherwise a strict superset of the supported Compose `include:` forms, with additional source schemes (git, npm, registry) and Lando-aware merge semantics.

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

Examples of external formats include Terraform outputs, framework metadata, hosting platform config, cloud-service descriptors, and legacy Lando v3 Landofiles. v3 compatibility remains out of core: an external plugin MAY contribute a `lando-v3` translator, but core treats it the same as any other translator.

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

These four roots, the resolution order above, the platform-default matrix, and every path derived from them are owned by a single primitive — the Effect-free `@lando/core/paths` resolver and the `PathsService` runtime tag (§7.5.1). Core code, plugins, and embedding hosts MUST resolve roots and derived paths through that primitive rather than re-deriving `$HOME`/XDG/`%APPDATA%` fallbacks or hand-joining `<userDataRoot>/plugins`, `<userCacheRoot>/scratch`, etc.

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

# Plugin enablement for the global Lando app (§20.3.1). Toggled by
# `meta:global:install <plugin>` / `meta:global:uninstall <plugin>`.
# The map drives generation of `<userDataRoot>/global/.lando.dist.yml`.
# Per-service config overlays go in `<userDataRoot>/global/.lando.yml`,
# not here; this map's responsibility is on/off only.
# (See also: <userConfRoot>/global.config.yml — same map shape as this value.)
globalServices: {}                       # e.g., { mailpit: { enabled: true }, traefik: { enabled: true } }

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

# Build orchestration (§6.13). Concurrency caps and failure policies for the
# artifact-build and per-service app-build phases of `app:start` / `app:rebuild`.
build:
  concurrency:
    artifact: 2                        # concurrent image builds; Docker-class daemons saturate around 2-3
    app: min(4, cpu_count)             # concurrent in-container app builds (composer install, npm ci, ...)
  failFast:
    artifact: true                     # a failed image build aborts in-flight siblings in the artifact phase
    app: false                         # app-phase siblings run to completion; failures aggregated and reported once
  transcripts:
    keepCompleted: 10                  # per service per buildKey; older entries rotated out of build-results cache
    keepFailed: 5                      # per service per buildKey

logLevelConsole: info
experimental: false

stats:
  report: true                         # telemetry enabled by default; users may opt out
```

`build.concurrency.app: min(4, cpu_count)` is the spec form; the resolved value at runtime is the integer minimum of `4` and the host CPU count. CI runners with high core counts therefore stay capped at `4` by default to leave headroom for the runner's own work; users with a fixed budget can pin a literal integer in their global config or per-app override. Per-service overrides live under `services.<name>.build:` in the Landofile (§6.2): `services.appserver.build.failFast: true` opts a single service into fail-fast even when the phase default is continue-all; `services.node.build.concurrency: 1` serializes a service's own multi-step app build.

#### 7.5.1 Root and path resolution primitive

Root resolution and the dozens of paths derived from the four roots are a single primitive rather than a convention re-implemented per call site. It is published in two cooperating forms:

- **`@lando/core/paths`** — a pure, Effect-free, OCLIF-free module (§2.7). It exposes `resolveLandoRoots(options?)`, `makeLandoPaths(options?)`, and `normalizeHostPlatform(input?)`. Because it constructs no `Context.Service` and imports neither `effect` nor `@oclif/core`, it is safe on the level-`none` fast path (§3.2), inside `scripts/`, and for embedding hosts and plugin utilities that need a path before (or without) a runtime.
- **`PathsService`** — the runtime DI tag (§3.4), constructed eagerly at level `minimal`. Its Live Layer is a thin wrapper over `makeLandoPaths`, so runtime code already inside the Layer graph resolves the same paths through `yield* PathsService` without re-deriving them and without depending on `ConfigService`.

**Resolved roots.** `resolveLandoRoots` returns the four roots — `userConfRoot`, `userCacheRoot`, `userDataRoot`, `systemPluginRoot` — applying, per root, the §7.5 order: explicit runtime option (a `RootOverrides` field, §16.3/§16.5) → `LANDO_USER_CONF_ROOT` / `LANDO_USER_CACHE_ROOT` / `LANDO_USER_DATA_ROOT` / `LANDO_SYSTEM_PLUGIN_ROOT` → value from `config.yml` → platform default. The `userConfRoot` self-reference rule holds: a `userConfRoot` value inside `config.yml` decodes as ordinary config but MUST NOT relocate the `config.yml` load itself, so `resolveLandoRoots` reads `config.yml` for the other three roots only after the conf root is fixed from option/env/default. The platform-default matrix is exactly the §7.5 table (Linux/BSD XDG, macOS `~/Library/...`, Windows `%APPDATA%`/`%LOCALAPPDATA%`/`%PROGRAMDATA%`); `normalizeHostPlatform` resolves the `HostPlatform` (including WSL) that selects the column.

**Derived paths.** `makeLandoPaths` returns `LandoPaths`: the resolved `roots`, the active `platform`, and builders for every path the §12 catalog and §9.3 discovery order name — `pluginsDir`, `appPluginsDir(appId)`, `pluginAuthFile`, `binDir`, `keysDir`, `certsDir`, `runtimeDir`, `globalAppRoot`, `snapshotsDir`, `appSnapshotsDir(appId)`, `managedFileLedger(appId)` (default `<userDataRoot>/managed-files/<app-id>/ledger.json`) (under `userDataRoot`); `logsDir`, `scratchDir`, `scratchRegistryFile`, `appCacheDir(appName, appRoot)`, `appPlanCacheFile(appName, appRoot)`, `fileSyncSessionsDir`, `toolDownloadsDir(toolId)` (under `userCacheRoot`); and `configFile`, `configDir`, `globalConfigFile` (under `userConfRoot`). The data-movement snapshot store (§10.11) resolves through `appSnapshotsDir`, and the managed-file ledger (§10.13) resolves through `managedFileLedger`; nothing re-derives `<userDataRoot>/snapshots/` or `<userDataRoot>/managed-files/` by hand. App-scoped cache builders apply the §12.1 name-sanitization and app-root fingerprinting so two apps sharing a `name:` never collide.

**Config schema.** `GlobalConfig` (§7.8) carries all four roots — `userConfRoot`, `userCacheRoot`, `userDataRoot`, and `systemPluginRoot` — as optional `AbsolutePath` fields, so the `config.yml` layer of the resolution order and the host `config:` override (§16.5) are typed end to end.

**Overridability.** `RootOverrides` accepts per-root overrides plus `platform`, `env`, and `home` for deterministic testing and host isolation. The primitive is host- and test-overridable but is **not** a plugin contribution surface (§4.2): the resolution order and platform matrix are a fixed contract, and a plugin relocating roots would break the layout every other contribution assumes.

### 7.6 Environment overrides

Every global config key is overridable with an env var that uses the configured prefix (default `LANDO`).

Rules:

- Keys are converted from `camelCase` to `UPPER_SNAKE_CASE`.
- JSON-parseable string values are parsed into objects/arrays.
- `LANDO_PLUGIN_CONFIG_<NAME>` injects plugin config (JSON).
- `LANDO_PROVIDER_<PROVIDER>_*` adjusts a single provider's extension config.
- Standard proxy env vars (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, lowercase variants) are honored for Lando-owned network clients unless explicit `network.proxy` config overrides them.
- `LANDO_NETWORK_CA_CERTS` accepts a JSON array of additional CA certificate paths for Lando-owned network clients.
- `commandAliases:` (§7.4 Landofile, §7.5 global) is overridable through the standard prefix rules but the nested map keys are JSON-encoded. The master switch is `LANDO_COMMAND_ALIASES_ENABLED=true|false`; the `disabled:` array is set with `LANDO_COMMAND_ALIASES_DISABLED='["start","poweroff"]'`; the `custom:` map is set with `LANDO_COMMAND_ALIASES_CUSTOM='{"halt":"app:stop"}'`. Per-alias scalar setters (`LANDO_COMMAND_ALIASES_CUSTOM_HALT=app:stop`) are NOT supported because alias names may contain characters incompatible with `UPPER_SNAKE_CASE` round-tripping; the JSON-document setter is the canonical mechanism.

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


**Deprecation.** Any key defined in §7.4 (top-level Landofile keys and the supported Compose subset), §7.5 (global config), or §7.6 (env-var overrides) MAY carry a `deprecated:` schema annotation per the surface deprecation matrix in §18.5. The annotation propagates to JSON Schema (`deprecated: true` plus `x-deprecation`), the generated docs callout, and `DeprecationService` (§18.3); it produces a runtime `message.warn` on first observation and is recorded by `lando doctor --deprecations`. Removing a deprecated key is gated by the release-pipeline `removeIn` enforcement in §18.7.

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

Each include MAY be a bare string (path only) or an object with `{ source, kind?, when?, version?, namespace?, flatten?, internal?, aliases?, excludes?, vars? }`. The `when:` field is a config expression (§7.3.1) evaluated against the same context that resolves expressions in the including file; a falsy `when:` skips the include without error.

The `kind:` field discriminates the fragment's shape and resolution timing:

| `kind:` | Resolves at | Fragment shape | Notes |
|---|---|---|---|
| `landofile` (default) | per-file, before §7.2 merge | Whole-Landofile fragment per §7.7.2 | The unmarked default. Most includes are this kind. |
| `tooling` | app-plan compile time | `tooling`/`toolingDefaults`/`toolingIncludes` shape per §8.5.8 | Tooling-only fragments. The shorthand `toolingIncludes:` (§7.4, §8.5.8) is sugar for `includes: [{ kind: tooling, ... }]`. The `namespace`, `flatten`, `internal`, `aliases`, `excludes`, and `vars` fields apply only to this kind. |
| `compose` | per-file, before §7.2 merge | Compose-spec project fragment | Recognized for Compose `include:` interop (§7.4). |

#### 7.7.2 Fragment shape

A fragment is a YAML or JSON document that is itself a partial Landofile — it MAY contain any combination of top-level keys (services, tooling, events, proxy, includes, providers, etc.). A fragment MUST NOT contain `name:` or `runtime:`; those are the including file's identity.

A fragment MAY itself declare `includes:`. Cycles are detected and rejected with `IncludeCycleError`. Maximum include depth is configurable globally (`includeMaxDepth`, default `8`).

#### 7.7.3 Merge semantics

- Includes resolve in array order. Later entries in the same `includes:` array override earlier entries on conflict, before the including file's inline keys are layered on top.
- The including file's inline keys always win over its own includes.
- Map/array merge rules from §7.2 apply unchanged.
- `load()` and `import()` calls inside a fragment resolve paths relative to the fragment's source location, not the including file.
- Configuration expressions inside a fragment use the including file's context. A fragment cannot define new variable bindings outside its own scope.

#### 7.7.4 Lockfile

`<appRoot>/.lando.lock.yml` (basename configurable globally via `landoLockFile:`) records the resolved versions, refs, and content checksums for every non-local include and every app-declared plugin source from `plugins:`. The lockfile is committed with the project. Resolution rules:

- If a lockfile entry exists for an include or app-declared plugin, that exact ref/version/checksum is used and verified.
- If no entry exists, the source is resolved fresh and a new lockfile entry is written.
- `lando app includes update [<source>...]` (canonical id `app:includes:update`; §8.2) refreshes one or more entries; with no arguments, refreshes all.
- `lando app includes verify` (canonical id `app:includes:verify`; §8.2) re-checks every checksum without updating.
- A lockfile mismatch (checksum drift, missing source) fails with a tagged `IncludeLockError` and remediation pointing at `lando app includes update`.

The lockfile is read and written through the canonical `StateStore` primitive (§12.7) — a `none`-lock bucket at `{ root: { app: appRoot }, key: ".lando.lock.yml" }` whose custom codec wraps the existing block-style renderer/parser, so the committed on-disk YAML is byte-for-byte unchanged while gaining the shared atomic-write and path-containment guarantees.

#### 7.7.5 Caching

Resolved fragment contents are cached under `<userCacheRoot>/includes/` keyed by source + ref + checksum. Cache reads are content-addressed and cross-app — a fragment used by multiple apps is fetched once.

Network access is required only when an include or app-declared plugin is missing from the cache, `lando app includes update` is invoked, or the app build itself pulls remote artifacts/dependencies. Routine `lando start` / tooling invocations on a project with complete caches, a complete lockfile, and already-built app artifacts do not touch the network.

#### 7.7.6 Security

- Local includes are restricted to the app root by default. The `--allow-include-outside-root` global config flag opts into broader paths.
- Git and npm includes are pinned by ref and verified by checksum on every load. A drift fails closed.
- Registry includes (when implemented) require signature verification against the registry's published key.
- Fragments cannot execute code. The YAML/JSON parser rejects every YAML tag other than the small allowlist required for native YAML semantics; external file content enters fragments through `load()` and `import()` (§7.3), the same as in the top-level Landofile.

#### 7.7.7 Distinction from related keys

| Key | Purpose | Resolution time |
|---|---|---|
| `includes:` (Lando, §7.7) — the canonical surface | Unified import primitive; `kind:` discriminates `landofile` (default), `tooling` (§8.5.8), or `compose` | Per-file before §7.2 merge for `landofile` / `compose`; app-plan compile time for `tooling` |
| `toolingIncludes:` (§8.5.8) | Idiomatic shorthand for `includes: [{ kind: tooling, ... }]` | App-plan compile time |
| Compose `include:` | Recognized as `includes: [{ kind: compose, ... }]`; entries are appended to the resolved `includes:` list | Per-file before §7.2 merge |

### 7.8 Schema and documentation publication

Effect Schemas for the Landofile, global config, service config, expression AST/resolution errors, tooling config, route config, healthcheck config, plugin manifest, event payloads, the prompt vocabulary (§8.10.1), and the machine-readable command-output contract (`CommandResultEnvelope`, `CommandWarning`, `CommandResultFormat`, `StreamFrame`; §8.11) are published from `@lando/sdk` and re-exported from `@lando/core/schema`. `@lando/sdk/schema` exposes a central public schema registry so build tooling can enumerate every schema that is part of the public contract. Schemas and individual fields MAY carry a `deprecated:` annotation per §18.5; the build pipeline propagates this to JSON Schema (`deprecated: true` plus `x-deprecation`) and to the generated reference MDX as a "Deprecated since X" callout (§17.2 codegen).

Build-time schema publication produces:

- `dist/schemas/*.json` JSON Schema files for editor integration and external tooling. The default target is JSON Schema draft-07 for broad editor support; additional targets such as 2020-12 or OpenAPI 3.1 MAY be emitted when a consumer requires them.
- Generated MDX schema reference pages for the Starlight docs site. These pages are generated from Effect Schema AST traversal and annotations, not hand-maintained tables.
- A schema metadata index consumed by docs navigation, editor integration docs, and release checks.

Schema definitions MUST include useful annotations (`identifier`, `title`, `description`, and examples where helpful) because the same metadata powers validation errors, JSON Schema output, and generated docs. Human-authored docs remain in `docs/` and explain concepts and workflows; generated schema reference documents exact contract shape.

#### 7.8.1 Canonical Landofile serializer

Core ships **one** canonical serializer pair for the block-style Landofile subset, published as pure, dependency-free logic from `@lando/sdk/landofile` (mirroring the `@lando/sdk/expressions` engine, and like it not compatibility-locked beyond its declared exports) and re-exported from `@lando/core/landofile`:

- `emitLandofileYaml(value): string` — serialize a Landofile object (or a `Partial<LandofileShape>` fragment) to block-style YAML. Fails with a tagged `LandofileEmitError` on a non-emittable input.
- `emitLandofileYamlEither(value): Either<string, LandofileEmitError>` — the same emit as an `Either` for callers that prefer typed handling over a throw.
- `parseLandofile({ file, content, cwd }): Effect<unknown, LandofileParseError>` — parse the block-style subset back into a plain object.

The pair is governed by one **round-trip law**: for every value in the supported domain, `parseLandofile(emitLandofileYaml(value))` MUST deep-equal `value`. This serializer is the single source of truth for writing a `LandofileShape`/fragment back to disk — `app:config:translate --write`, `app:config:set` / `unset` (§8.2.1), `lando doctor`'s YAML report, and global-config writes all consume it — and config-translator plugins (§9.5) and embedding hosts (§16.2) use it to preview, emit, and test generated fragments. Per-recipe and per-command hand-written YAML is forbidden where this serializer applies.

Supported value domain (inputs outside it fail with `LandofileEmitError`, never silently corrupt):

- **Map keys** matching `^[A-Za-z0-9_.-]+$` — emitted verbatim. A key carrying any other character fails with a path-tagged `LandofileEmitError` rather than emitting unparseable YAML; symbol keys fail the same way.
- **Scalars** — `string`, finite `number`, `boolean`, and `null`. Strings that would otherwise re-parse as a number, boolean, or `null`, or that carry structural YAML characters, are quoted so the round-trip law holds. Non-finite numbers (`NaN`, `Infinity`) fail with `LandofileEmitError`.
- **Maps** — nested plain objects (own-prototype `Object.prototype` or `null`) whose values are themselves in the supported domain. An empty object emits as `{}`.
- **Arrays** — lists whose items are scalars or maps. An empty array emits as `[]`. Nested arrays-of-arrays are unsupported (a Landofile never contains them) and fail with `LandofileEmitError`.

Values outside this domain — `undefined`, `bigint`, functions, symbols, `Date`/`RegExp`/`Map` and other exotic objects, class instances, a cyclic structure, or any other non-plain structure — fail with `LandofileEmitError` rather than emitting malformed YAML.

The serializer consumes the **encoded (wire) form** of a Landofile — the merged tree of plain records, arrays, strings, finite numbers, booleans, and `null` (`LandofileShape.Encoded`), not a decoded runtime `LandofileShape.Type` whose leaves may be branded or `DateTime` values. `emitLandofileYaml(value, { sortKeys })` accepts an optional `sortKeys` flag: it defaults to insertion order (no behavior change) and, when `true`, emits map keys in ascending lexicographic order for stabler canonical-write diffs without reordering array elements.
