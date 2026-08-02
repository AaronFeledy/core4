# Embedding `@lando/core`

The `@lando/core` library API is Effect-native. Embedding hosts compose Effect programs with the exported service tags and runtime Layer, then run those programs at the host boundary with Effect.

## Entry points

Every published entry point in `core/package.json#exports` declares both TypeScript `types` and ESM `import` targets.

| Entry point | Purpose |
| --- | --- |
| `@lando/core` | Runtime factory (`makeLandoRuntime`), runtime options, bootstrap types, and common service tags. |
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
| `@lando/core/docs/redactions` | Public transcript redaction helpers for docs pipelines. |
| `@lando/core/oclif` | Transitional internal adapter still published by current metadata; unsupported for embedding hosts and removed by US-526. |

The default `@lando/core` entry and every stable subpath above other than the explicitly transitional `@lando/core/oclif` entry do not pull OCLIF into embedding bundles. OCLIF is used by today's source-mode CLI dispatch while migration work (US-522..US-531) moves both source and compiled entries onto one native command dispatcher; it is not a supported embedding surface, and embedding hosts should not import it or depend on it remaining available.
