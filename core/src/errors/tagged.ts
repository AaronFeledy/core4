/**
 * All `TaggedError` classes.
 *
 * Tagged errors only — no thrown exceptions in core.
 * `Schema.TaggedError` plugs into Effect's error channel.
 *
 * The canonical catalog lives in `@lando/sdk/errors`. Re-exported here so
 * core implementation modules can import from a stable internal path.
 */
export * from "@lando/sdk/errors";
