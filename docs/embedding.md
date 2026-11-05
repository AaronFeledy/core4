---
title: Embedding `@lando/core`
description: How to embed the Effect-native @lando/core library API in a host application.
---

# Embedding `@lando/core`

Use `@lando/core` to run Lando operations from your own application. The API uses Effect: compose a program with the exported service tags and runtime layer, then run it at your application boundary. This guide assumes you already use Effect.

Choose whether your host needs bundled plugins before constructing its runtime. The default import is plugin-free; the example below opts into the bundled plugins.

## Choose the plugin composition

The default `@lando/core` entry is plugin-free: importing it does not require or install any bundled plugin package. A host that installs the bundled plugin packages and wants `bundled-only` discovery must import the opt-in before constructing a runtime:

```ts
import "@lando/core/bundled-plugins";
import { makeLandoRuntime } from "@lando/core";

const runtime = makeLandoRuntime({
  bootstrap: "plugins",
  plugins: { policy: "bundled-only" },
});
```

Requesting bundled discovery without first importing `@lando/core/bundled-plugins` fails with `LandoRuntimeBootstrapError`. The CLI performs this opt-in behind its lazy `@lando/core/cli` boundary, so CLI behavior retains the full bundled composition without adding plugins to the root library import graph.

The default entry and every published subpath listed below are OCLIF-free. OCLIF is development-only; the private CLI directories `core/src/cli/spec/` and `core/src/cli/command-specs/` hold native metadata, adapters, and manifest tooling, and no published package specifier exposes them to embedding hosts.

## Entry points

Every published entry point in `core/package.json#exports` declares both TypeScript `types` and ESM `import` targets.

| Entry point | Purpose |
| --- | --- |
| `@lando/core` | Runtime factory (`makeLandoRuntime`), runtime options, bootstrap types, and common service tags. |
| `@lando/core/bundled-plugins` | Side-effect opt-in that installs the complete bundled plugin composition and exports `BUNDLED_PLUGIN_MODULES`. |
| `@lando/core/schema` | Public schemas re-exported from `@lando/sdk/schema`. |
| `@lando/core/errors` | Public tagged errors re-exported from `@lando/sdk/errors`. |
| `@lando/core/events` | Event service, lifecycle payload schemas, and subscriber priority exports. |
| `@lando/core/services` | Effect service tags for embedding hosts and plugin authors. |
| `@lando/core/paths` | Effect-free root/path resolver for hosts that need roots before constructing a runtime. |
| `@lando/core/testing` | Deterministic test runtime fixtures and executable-guide scenario helpers. |
| `@lando/core/cli` | Programmatic CLI runner surface. |
| `@lando/core/cli/operations` | Built-in command operations for hosts that want command logic without argv parsing. |
| `@lando/core/docs/components` | Executable-guide component contracts and decode helpers. |
| `@lando/core/docs/render` | Public transcript view-model and deterministic HTML renderer for docs pipelines. |
| `@lando/core/docs/variant` | Guide-variant string encoding and file-suffix helpers for docs pipelines. |
| `@lando/core/docs/redactions` | Public transcript redaction helpers for docs pipelines. |

## Global config

Each runtime keeps its own configuration snapshot. `makeLandoRuntime` reads configuration when its layer builds; later file or environment changes do not update that runtime. Create a new runtime to load those changes.

Configuration is resolved in this order, with later layers taking precedence:

1. Built-in defaults.
2. `<userConfRoot>/config.yml`.
3. `<userConfRoot>/config.d/*.yml`.
4. Environment settings, including `LANDO_CONFIG__*`, aliases, and `LANDO_USER_*` roots.
5. The host `config` option, which accepts any `GlobalConfig` field.

To supply configuration without reading user files or environment settings:

```ts
const runtime = makeLandoRuntime({
  bootstrap: "minimal",
  config: { userDataRoot: "/srv/lando/data", router: { httpPort: 8123 } },
  configSources: { user: false, env: false },
});
```

Both `configSources` options default to `true`. Set them independently:

- `user: false` skips user configuration files.
- `env: false` skips `LANDO_CONFIG__*`, aliases, `LANDO_USER_*` roots, `LANDO_PROVIDER`, and the proxy and CA environment variables the HTTP client would otherwise honor.

The runtime's `StateStore`, plugin trust store, and HTTP client use its captured roots and environment. One runtime never inherits another runtime's snapshot. See [Embed the runtime](./guides/library/embedding-runtime.mdx#supply-global-config).

### Handle invalid configuration

An invalid value in any configuration layer fails the layer build with `ConfigError`, not `LandoRuntimeBootstrapError`. Each entry in `issues[]` contains `path`, `message`, `suggestion`, and a `source`, such as `{ layer: "host", path }`. After construction, `ConfigService.load` and `ConfigService.get` cannot fail.

## Supply tooling inputs by name

On a resolved `App` handle, call `app.tooling(id, options)` with
`input: { _tag: "NamedMaps", flags, args }` for declared inputs. For example, if
the app declares a `greet` task with boolean `loud` and string argument `target`,
run this inside the scoped Effect program that owns `app`:

```ts
const result = yield* app.tooling("app:greet", {
  input: {
    _tag: "NamedMaps",
    flags: { loud: false },
    args: { target: "dev" },
  },
});
```

Inspect `result.exitCode`, `result.stdout`, and `result.stderr`. Explicit false
overrides a true declaration default. An empty string stays present, while an
omitted key allows its default. Named-map input binds once against the resolved
task rather than being serialized to argv and parsed again. Map-capable scripts
accept omitted optional arguments before later named values; argv-only adapters
reject such gaps with `ToolingInputError` before execution.

For original CLI tokens, use
`input: { _tag: "RawArgv", argv: ["dev", "--loud=false"] }` instead.
Omitting `input` means an empty raw invocation. `NamedMaps.passthroughArgv` is
only for undeclared passthrough, not a tail to mix with declared named arguments.
The former options-level argument vector and declaration-array snapshot are
replaced by `input` and `expectedInputRevision`.

If your host retains discovered command metadata, pass its `input.revision` as
`expectedInputRevision` alongside the invocation. This is the SDK's branded
`ToolingInputRevision` from discovery; do not construct a hash or copy an example
string. A semantic declaration change fails with `ToolingInputError` before
execution. Re-resolve the command and review its new declaration before retrying.
Description-only and body-only changes keep the revision compatible. A direct
call without a retained revision uses the invocation-authoritative declaration.

App handles retain their resolved Landofile and plan, so a revision check is
not a request to reload files behind the handle. Resolve a new handle when you
want edited configuration. See
[Embed the runtime](./guides/library/embedding-runtime.mdx) for handle lifetime
and runtime setup.

## Handle operation failures

`invokeOperation` from `@lando/core/cli/operations` returns `{ ok: false, error, additionalErrors }` when the projected primary is a typed failure. `additionalErrors` is always present, possibly empty, with `{ role, error }` entries for the remaining failures and defects in cause order. Each additional error has a role:

- `rollback`: undoing partial work.
- `cleanup`: releasing resources or bookkeeping.
- `peer`: a sibling failure.

Interruptions are excluded. Primary-error selection prefers the first unannotated typed failure, then the first unannotated defect, then the first typed failure or defect.

This matches CLI and MCP projection, but the helper does not serialize or automatically redact the values. Handle them accordingly before displaying or recording them. `renderError` receives only the primary failure. A projected defect or interruption propagates as a defect with the original cause attached instead of returning the result object.

### Bun and plugin child exits

Commands that run Bun for the user (`meta:bun`, `meta:x`, the plugin authoring and management commands, `meta:update`, and recipe `postInit` actions) share one observable contract, documented for CLI consumers in [Script Lando with JSON](./guides/scripting-with-json.mdx#capture-bun-backed-commands). The short version for hosts:

- A completed nonzero child exit remains result data. Direct `invokeOperation` reports `ok: true` when the Effect returned successfully, so inspect the operation's `exitCode`. The CLI command adapter applies completion policy separately, producing `ok: false`, `result.exitCode`, and `LandoCommandError`. Managed plugin failures use `PluginPackageOperationError` with an operation and an exit code only for an observed nonzero child. Preparation, process execution, timeout, and recursion failures retain their own tags; don't infer an offline classification from stderr.
- Direct and event-driven operations never attach the host's stdin, stdout, or stderr on their own. Their default child capture is capped at 1 MiB per channel per child. The CLI adapter additionally supplies the shared invocation-wide budget and envelope output; those are not implicit guarantees of `invokeOperation`. An operation's declared result determines which captured output it returns.
- Bun proxy commands, plugin operations, noninteractive shell commands/scripts, and initialization use the `ProcessRunner` you provide, with no live-runner fallback. The interactive `app:shell` evaluator still owns its separate IPC child and does not use that override. There is no public Bun runner service, layer, or plugin contribution.
- Recipe `postInit` failures reach you as `RecipeInitPostInitError` with the failed action and committed-file context. `rolledBack: false` means the generated scaffold remains. Don't expect the command completion envelope or a child exit field from initialization.
