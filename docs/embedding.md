---
title: Embedding `@lando/core`
description: How to embed the Effect-native @lando/core library API in a host application.
---

# Embedding `@lando/core`

The `@lando/core` library API is Effect-native. Embedding hosts compose Effect programs with the exported service tags and runtime Layer, then run those programs at the host boundary with Effect.

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

The default entry and every published subpath above are OCLIF-free. OCLIF is development-only; the private CLI directories `core/src/cli/spec/` and `core/src/cli/command-specs/` hold native metadata, adapters, and manifest tooling, and no published package specifier exposes them to embedding hosts.

## Global config

`makeLandoRuntime` resolves global config once while its layer builds and keeps that snapshot for the life of the runtime. The layers are built-in defaults, `<userConfRoot>/config.yml`, `<userConfRoot>/config.d/*.yml`, environment (`LANDO_CONFIG__*`, aliases, `LANDO_USER_*` roots), then the host `config` option, which accepts any `GlobalConfig` field:

```ts
const runtime = makeLandoRuntime({
  bootstrap: "minimal",
  config: { userDataRoot: "/srv/lando/data", router: { httpPort: 8123 } },
  configSources: { user: false, env: false },
});
```

`configSources.user: false` skips the user files; `configSources.env: false` skips environment input. Both default to `true`. An invalid value in any layer fails the layer build with `ConfigError` (its own tag, not `LandoRuntimeBootstrapError`); each entry in `issues[]` carries `path`, `message`, `suggestion`, and a `source` such as `{ layer: "host", path }`. After construction `ConfigService.load` and `ConfigService.get` cannot fail. Build a new runtime to pick up a changed file or environment. See [Embed the runtime](./guides/library/embedding-runtime.mdx#supply-global-config).

`invokeOperation` from `@lando/core/cli/operations` returns `{ ok: false, error, additionalErrors }` when the projected primary is a typed failure. `additionalErrors` is always present, possibly empty, with `{ role, error }` entries for the remaining failures and defects in cause order. Roles are `rollback` for undoing partial work, `cleanup` for release or bookkeeping, and `peer` for sibling failures. Interruptions are excluded. The primary is the first unannotated typed failure, then the first unannotated defect, then the first typed failure or defect. This matches CLI and MCP projection, but the values stay yours: the helper does not serialize or automatically redact them. `renderError` receives only the primary failure. A projected defect or interruption propagates as a defect with the original cause attached rather than returning this result.
