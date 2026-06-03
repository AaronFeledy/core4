/**
 * @lando/sdk — type-only contracts for plugin authors.
 *
 * Effect Schema is the only schema library in core. This is the package
 * plugin authors import to get Effect Schemas, Effect Service tags,
 * tagged-error classes, and event-payload schemas. Core re-exports
 * everything here from `@lando/core/schema`, `@lando/core/errors`, and
 * `@lando/core/events`.
 *
 * Philosophy: this package is **type + schema only**. It MUST NOT contain Live
 * implementations or anything that would force a plugin author to take a
 * runtime dependency on Bun-specific APIs. Implementations live in `@lando/core`
 * and the bundled plugin packages.
 */

export * as Schema from "./schema/index.ts";
export * as Errors from "./errors/index.ts";
export * as Services from "./services/index.ts";
export * as Events from "./events/index.ts";
export * as Expressions from "./expressions/index.ts";
export * as Secrets from "./secrets/index.ts";
export * as Template from "./template/index.ts";
