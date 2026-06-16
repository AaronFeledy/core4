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
| `@lando/core/testing` | Deterministic test runtime fixtures and executable-guide scenario helpers. |
| `@lando/core/cli` | Programmatic CLI runner surface. |
| `@lando/core/cli/operations` | Built-in command operations for hosts that want command logic without argv parsing. |
| `@lando/core/docs/components` | Executable-guide component contracts and decode helpers. |
| `@lando/core/docs/render` | Public transcript view-model and deterministic HTML renderer for docs pipelines. |
| `@lando/core/docs/redactions` | Public transcript redaction helpers for docs pipelines. |
| `@lando/core/oclif` | Internal OCLIF adapter for alternate CLI distributions; embedding hosts should not import it. |

The default `@lando/core` entry and stable subpaths avoid pulling the OCLIF adapter into embedding bundles. Import OCLIF glue only from `@lando/core/oclif` when building an OCLIF-based CLI distribution.
