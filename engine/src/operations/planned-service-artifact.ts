import type { ArtifactBuildSpec, ArtifactRef } from "@lando/sdk/schema";

/**
 * Artifact identity safe to print before a container exists.
 * Matches `lando info`: a registry ref and optional digest, or a build's
 * content hash. Context, arguments, inline source, and provenance stay out.
 */
export type PlannedServiceArtifact =
  | {
      readonly kind: "ref";
      readonly ref: string;
      readonly digest?: string;
    }
  | {
      readonly kind: "build";
      readonly contentHash?: string;
    };

export const plannedServiceArtifact = (
  artifact: ArtifactRef | ArtifactBuildSpec | undefined,
): PlannedServiceArtifact | undefined => {
  if (artifact === undefined) return undefined;
  if (artifact.kind === "ref") {
    return {
      kind: "ref",
      ref: artifact.ref,
      ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
    };
  }
  return {
    kind: "build",
    ...(artifact.contentHash === undefined ? {} : { contentHash: artifact.contentHash }),
  };
};
