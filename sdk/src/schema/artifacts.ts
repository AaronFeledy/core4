import { Schema } from "effect";

import { layerMerge } from "./layer-merge.ts";
import { AbsolutePath, ContainerUser, PortablePath, ProviderId } from "./primitives.ts";

// ==== Provider artifacts
// Runtime image identities and reclamation requests.

export const ProviderArtifactRef = Schema.Struct({
  providerId: ProviderId.annotate({ description: "Provider holding the artifact." }),
  ref: Schema.String.annotate({ description: "Provider-local artifact name or image ID." }),
  digest: Schema.optionalKey(Schema.String).annotate({ description: "Artifact content digest, when known." }),
}).annotate({ description: "An artifact held by a runtime provider." });
export type ProviderArtifactRef = typeof ProviderArtifactRef.Type;

export const ArtifactSelector = Schema.Struct({
  labels: Schema.Record(Schema.String, Schema.String).annotate({
    description: "Labels that must all match the image.",
  }),
}).annotate({ description: "Selects provider artifacts by matching every label." });
export type ArtifactSelector = typeof ArtifactSelector.Type;

export const ArtifactListing = Schema.Struct({
  id: Schema.String.annotate({ description: "Runtime image ID exactly as reported by the runtime." }),
  refs: Schema.Array(Schema.String).annotate({
    description:
      "Image names normalized to build-request tags, without docker.io/library/, localhost/, or :latest; excludes <none>:<none>.",
  }),
}).annotate({ description: "A runtime image and its normalized names." });
export type ArtifactListing = typeof ArtifactListing.Type;

export const ArtifactRemovalRequest = Schema.Struct({
  providerId: ProviderId.annotate({ description: "Provider holding the artifact." }),
  ref: Schema.String.annotate({ description: "Image name or runtime image ID to remove." }),
  pruneParents: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Allow removal of parents left dangling; absent or false keeps untagged parents.",
  }),
}).annotate({
  description: "Non-forced removal of a provider artifact with explicit parent-pruning intent.",
});
export type ArtifactRemovalRequest = typeof ArtifactRemovalRequest.Type;

// ==== Planned artifacts
// Artifact sources carried by service plans.

/**
 * Reference to a pre-built artifact (image, template, etc.) the provider
 * should pull rather than build.
 */
export const ArtifactRef = Schema.Struct({
  kind: Schema.Literal("ref"),
  /** Provider-specific identifier (image name, registry URL, OCI ref…). */
  ref: Schema.String,
  /** Optional digest for reproducibility. */
  digest: Schema.optionalKey(Schema.String),
  /**
   * Provenance. `build` marks an artifact the provider produced locally: it
   * exists in no registry, so bring-up never pulls it. Absent means a registry
   * reference.
   */
  origin: Schema.optionalKey(
    Schema.Literal("build").annotate({
      description:
        "Provenance of the referenced artifact. `build` marks a locally produced artifact that bring-up never pulls from a registry; absent means a registry reference.",
    }),
  ),
});
export type ArtifactRef = typeof ArtifactRef.Type;

/** What `RuntimeProvider.removeArtifact` did with the artifact it was asked to remove. */
export const ArtifactRemoval = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("removed").annotate({
      description: "The provider removed the artifact, or an intermediate artifact its build created.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("absent").annotate({ description: "The provider holds no artifact by that name." }),
  }),
  Schema.Struct({
    kind: Schema.Literal("in-use").annotate({
      description:
        "The provider kept the artifact because a container or another artifact still depends on it.",
    }),
    reason: Schema.String.annotate({
      description: "The runtime's explanation of what still uses the artifact.",
    }),
    containers: Schema.Array(Schema.String).annotate({
      description: "Names of containers using the image; may be empty.",
    }),
  }),
]).annotate({ description: "What removing a provider artifact did; removal never forces." });
export type ArtifactRemoval = typeof ArtifactRemoval.Type;

const ArtifactBuildSpecCommon = Schema.Struct({
  kind: Schema.Literal("build"),
  /** Build context root (absolute, host path). */
  context: AbsolutePath,
  /** Build args (string-keyed; values may be expression-resolved upstream). */
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Target stage (multi-stage builds). */
  target: Schema.optionalKey(Schema.String),
  /** Content hash for buildKey computation. */
  contentHash: Schema.optionalKey(Schema.String),
});

const ArtifactBuildSpecSource = Schema.Union([
  Schema.Struct({
    /** Optional dockerfile/spec path relative to `context`. */
    spec: Schema.optionalKey(PortablePath),
    specInline: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    spec: Schema.optionalKey(Schema.Never),
    /** Inline build-spec contents used in place of a context-relative spec file. */
    specInline: Schema.String.annotate({
      description: "Inline Dockerfile contents built in place of a context-relative Dockerfile.",
    }),
  }),
]);

/**
 * Build spec — describes an artifact build from
 * source.
 */
export const ArtifactBuildSpec = Schema.Union([
  ArtifactBuildSpecCommon.pipe(Schema.fieldsAssign(ArtifactBuildSpecSource.members[0].fields)),
  ArtifactBuildSpecCommon.pipe(Schema.fieldsAssign(ArtifactBuildSpecSource.members[1].fields)),
]);
export type ArtifactBuildSpec = typeof ArtifactBuildSpec.Type;

/**
 * One `build.artifact:` / `build.app:` entry. A bare string runs as the
 * service's planned user; the object form names the user for that step alone.
 */
export const BuildScriptStep = Schema.Union([
  Schema.String,
  Schema.Struct({
    run: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
      description: "Shell command run for this build step.",
    }),
    user: Schema.optionalKey(ContainerUser).annotate({
      description: "Container identity this step runs as. Defaults to the service's planned user.",
    }),
  }),
]);
export type BuildScriptStep = typeof BuildScriptStep.Type;

/** Build script for `build.artifact:` and `build.app:` entries. */
export const BuildScript = Schema.Union([
  BuildScriptStep,
  layerMerge(Schema.Array(BuildScriptStep), { kind: "replace" }),
]).annotate({
  description: "One build step as a shell string or { run, user } object, or a list of those steps.",
});
export type BuildScript = typeof BuildScript.Type;
