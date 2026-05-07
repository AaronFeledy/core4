/**
 * Cache catalog schemas.
 *
 * Each cache has a versioned schema header. A version mismatch triggers
 * automatic invalidation. Hot-path caches (app-plan) are Effect-Schema
 * binary-encoded; small JSON caches use Schema.JsonString.
 *
 * Status: stub.
 */
import { Schema } from "effect";

/** All cache header types must include a version + checksum. */
export const CacheHeader = Schema.Struct({
  schemaVersion: Schema.Number,
  createdAt: Schema.DateTimeUtc,
  /** `Bun.hash` of the encoded payload below. */
  contentHash: Schema.String,
});
export type CacheHeader = typeof CacheHeader.Type;

export const CacheKind = Schema.Literal(
  "command",
  "plugin",
  "app-plan",
  "service-info",
  "provider",
  "oclif-manifest",
  "update",
);
export type CacheKind = typeof CacheKind.Type;
