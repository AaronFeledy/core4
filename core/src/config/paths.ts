/**
 * `@lando/core/paths` — re-export of the canonical Effect-free root/path resolver.
 *
 * The single implementation lives in `@lando/paths` (`paths/src/paths.ts`): pure
 * logic, Node builtins and type-only SDK imports only, no Effect and no OCLIF.
 * Core re-exports it so the semver-stable `@lando/core/paths` subpath (part of
 * the package's published `exports` map and its additive-export compatibility
 * guarantee) keeps resolving for embedding hosts and packed installs.
 *
 * **Tree-shakeability:** importing one helper MUST NOT pull every export in the
 * package. Use `import { makeLandoPaths } from "@lando/core/paths"` — Bun's
 * bundler tree-shakes unused exports.
 */

export * from "@lando/paths";
