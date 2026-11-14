import type { ProviderInternalError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import type { ArtifactRef, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";
import { Cause, Effect } from "effect";
import type { ArtifactBuildStep } from "./build-artifact-events.ts";
import { buildKeyForService } from "./build-key.ts";
import type { ArtifactBuildResult } from "./build-results.ts";

export const buildStepFor = (
  provider: RuntimeProviderShape,
  service: ServicePlan,
): Effect.Effect<ArtifactBuildStep, ProviderInternalError> =>
  buildKeyForService(provider, service).pipe(
    Effect.map((buildKey) => ({ phase: "artifact" as const, service, buildKey })),
  );

export const serviceWithResolvedDigest = (
  service: ServicePlan,
  sourceArtifact: ArtifactRef | undefined,
): ServicePlan => {
  if (service.artifact?.kind !== "ref" || sourceArtifact?.digest === undefined) return service;
  return { ...service, artifact: { ...service.artifact, digest: sourceArtifact.digest } };
};

export const sourceIdentityMatches = (
  complete: ArtifactBuildResult,
  service: ServicePlan,
  sourceArtifact: ArtifactRef | undefined,
): boolean => {
  const planned = service.artifact;
  if (planned?.kind !== "ref") return true;
  const resolvedDigest = sourceArtifact?.digest ?? planned.digest;
  return (
    resolvedDigest !== undefined &&
    complete.sourceArtifactRef === planned.ref &&
    complete.sourceArtifactDigest === resolvedDigest
  );
};

export const producedImagePresent = (
  provider: RuntimeProviderShape,
  complete: ArtifactBuildResult,
): Effect.Effect<boolean, ProviderError> =>
  complete.artifactOrigin !== "build" || complete.artifactRef === undefined
    ? Effect.succeed(true)
    : provider.pullArtifact({ ref: complete.artifactRef, policy: "never" }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          cause.reasons.every(Cause.isFailReason) ? Effect.succeed(false) : Effect.failCause(cause),
        ),
      );
