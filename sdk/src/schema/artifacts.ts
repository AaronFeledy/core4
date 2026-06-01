import { Schema } from "effect";

import { AbsolutePath, PortablePath } from "./primitives.ts";

/**
 * Reference to a pre-built artifact (image, template, etc.) the provider
 * should pull rather than build.
 */
export const ArtifactRef = Schema.Struct({
  kind: Schema.Literal("ref"),
  /** Provider-specific identifier (image name, registry URL, OCI ref…). */
  ref: Schema.String,
  /** Optional digest for reproducibility. */
  digest: Schema.optional(Schema.String),
});
export type ArtifactRef = typeof ArtifactRef.Type;

/**
 * Build spec — describes an artifact build from
 * source.
 */
export const ArtifactBuildSpec = Schema.Struct({
  kind: Schema.Literal("build"),
  /** Build context root (absolute, host path). */
  context: AbsolutePath,
  /** Optional dockerfile/spec path relative to `context`. */
  spec: Schema.optional(PortablePath),
  /** Build args (string-keyed; values may be expression-resolved upstream). */
  args: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** Target stage (multi-stage builds). */
  target: Schema.optional(Schema.String),
  /** Content hash for buildKey computation. */
  contentHash: Schema.optional(Schema.String),
});
export type ArtifactBuildSpec = typeof ArtifactBuildSpec.Type;

/** Build script for `build.artifact:` and `build.app:` entries. */
export const BuildScript = Schema.Union(Schema.String, Schema.Array(Schema.String));
export type BuildScript = typeof BuildScript.Type;
