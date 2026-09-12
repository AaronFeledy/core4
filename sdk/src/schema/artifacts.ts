import { Schema } from "effect";

import { AbsolutePath, ContainerUser, PortablePath } from "./primitives.ts";

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

const ArtifactBuildSpecCommon = Schema.Struct({
  kind: Schema.Literal("build"),
  /** Build context root (absolute, host path). */
  context: AbsolutePath,
  /** Build args (string-keyed; values may be expression-resolved upstream). */
  args: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** Target stage (multi-stage builds). */
  target: Schema.optional(Schema.String),
  /** Content hash for buildKey computation. */
  contentHash: Schema.optional(Schema.String),
});

const ArtifactBuildSpecSource = Schema.Union(
  Schema.Struct({
    /** Optional dockerfile/spec path relative to `context`. */
    spec: Schema.optional(PortablePath),
    specInline: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    spec: Schema.optional(Schema.Never),
    /** Inline build-spec contents used in place of a context-relative spec file. */
    specInline: Schema.String.annotations({
      description: "Inline Dockerfile contents built in place of a context-relative Dockerfile.",
    }),
  }),
);

/**
 * Build spec — describes an artifact build from
 * source.
 */
export const ArtifactBuildSpec = ArtifactBuildSpecCommon.pipe(Schema.extend(ArtifactBuildSpecSource));
export type ArtifactBuildSpec = typeof ArtifactBuildSpec.Type;

/**
 * One `build.artifact:` / `build.app:` entry. A bare string runs as the
 * service's planned user; the object form names the user for that step alone.
 */
export const BuildScriptStep = Schema.Union(
  Schema.String,
  Schema.Struct({
    run: Schema.String.pipe(Schema.minLength(1)).annotations({
      description: "Shell command run for this build step.",
    }),
    user: Schema.optional(ContainerUser).annotations({
      description: "Container identity this step runs as. Defaults to the service's planned user.",
    }),
  }),
);
export type BuildScriptStep = typeof BuildScriptStep.Type;

/** Build script for `build.artifact:` and `build.app:` entries. */
export const BuildScript = Schema.Union(BuildScriptStep, Schema.Array(BuildScriptStep));
export type BuildScript = typeof BuildScript.Type;
