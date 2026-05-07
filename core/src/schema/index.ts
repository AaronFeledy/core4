/**
 * `@lando/core/schema` — re-export of every public Effect Schema.
 *
 * The canonical schemas live in `@lando/sdk/schema`; core re-exports them
 * for ergonomic consumption from CLI consumers and embedding hosts that
 * already pull `@lando/core`.
 *
 * **Tree-shakeability:** importing one schema MUST NOT pull every schema in
 * the package. Use `import { X } from "@lando/core/schema"` — Bun's bundler
 * tree-shakes unused exports.
 */

export * from "@lando/sdk/schema";
