/**
 * `@lando/core/errors` — re-export of every public tagged-error class.
 *
 * Every public failure surface is a `Schema.TaggedError` subclass with a
 * discriminating `_tag`. Embedding hosts pattern-match on `_tag` to handle
 * errors without `instanceof`.
 *
 * The canonical catalog lives in `@lando/sdk/errors`; core re-exports it
 * here. New tagged errors raised by core implementation are added to the
 * SDK first (so plugins can import them too), then re-exported here.
 */

export * from "@lando/sdk/errors";
