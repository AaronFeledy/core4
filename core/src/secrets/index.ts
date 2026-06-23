/**
 * `@lando/core/secrets` — re-export of the canonical redaction primitive.
 *
 * The single redaction implementation lives in `@lando/sdk/secrets`; core
 * re-exports it for ergonomic consumption from CLI consumers and embedding
 * hosts that already pull `@lando/core`.
 *
 * **Tree-shakeability:** importing one helper MUST NOT pull every export in
 * the package. Use `import { createRedactor } from "@lando/core/secrets"` —
 * Bun's bundler tree-shakes unused exports.
 */

export * from "@lando/sdk/secrets";
