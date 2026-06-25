/**
 * `@lando/core/landofile` — re-export of the canonical Landofile serializer.
 *
 * The single emit/parse implementation lives in `@lando/sdk/landofile` (pure
 * logic: no Effect layers, filesystem, or CLI). Core re-exports it for
 * ergonomic consumption from in-tree writers and embedding hosts that already
 * pull `@lando/core`.
 *
 * **Tree-shakeability:** importing one helper MUST NOT pull every export in the
 * package. Use `import { emitLandofileYaml } from "@lando/core/landofile"` —
 * Bun's bundler tree-shakes unused exports.
 */

export * from "@lando/sdk/landofile";
