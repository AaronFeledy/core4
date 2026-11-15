import type { ProviderInternalError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import { ProviderId } from "@lando/sdk/schema";
import type { ProviderArtifactRef, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";
import { Cause, Effect } from "effect";
import type { ArtifactBuildStep } from "./build-artifact-events.ts";
import { serviceWithArtifact } from "./build-artifact-runner.ts";
import { buildKeyForService } from "./build-key.ts";
import type { ArtifactBuildResult } from "./build-results.ts";

export const serviceWithCachedArtifact = (
  service: ServicePlan,
  complete: ArtifactBuildResult,
): ServicePlan => {
  const digest =
    complete.artifactDigest ??
    (service.artifact?.kind === "ref" && service.artifact.ref === complete.artifactRef
      ? service.artifact.digest
      : undefined);
  return serviceWithArtifact(service, {
    providerId: ProviderId.make(complete.providerId),
    ref: complete.artifactRef,
    ...(digest === undefined ? {} : { digest }),
    ...(complete.artifactOrigin === undefined ? {} : { origin: complete.artifactOrigin }),
  });
};

export const buildStepFor = (
  provider: RuntimeProviderShape,
  service: ServicePlan,
): Effect.Effect<ArtifactBuildStep, ProviderInternalError> =>
  buildKeyForService(provider, service).pipe(
    Effect.map((buildKey) => ({ phase: "artifact" as const, service, buildKey })),
  );

export const serviceWithResolvedDigest = (
  service: ServicePlan,
  sourceArtifact: ProviderArtifactRef | undefined,
): ServicePlan => {
  if (service.artifact?.kind !== "ref" || sourceArtifact?.digest === undefined) return service;
  return { ...service, artifact: { ...service.artifact, digest: sourceArtifact.digest } };
};

export const sourceIdentityMatches = (
  complete: ArtifactBuildResult,
  service: ServicePlan,
  sourceArtifact: ProviderArtifactRef | undefined,
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

export const sourceArtifactReceipt = (service: ServicePlan, source: ProviderArtifactRef | undefined) => {
  if (service.artifact?.kind !== "ref") return {};
  const digest = source?.digest ?? service.artifact.digest;
  return {
    sourceArtifactRef: service.artifact.ref,
    ...(digest === undefined ? {} : { sourceArtifactDigest: digest }),
  };
};

export const producedImagePresent = (
  provider: RuntimeProviderShape,
  complete: ArtifactBuildResult,
): Effect.Effect<boolean, ProviderError> =>
  complete.artifactOrigin !== "build"
    ? Effect.succeed(true)
    : provider.pullArtifact({ ref: complete.artifactRef, policy: "never" }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          cause.reasons.every(Cause.isFailReason) ? Effect.succeed(false) : Effect.failCause(cause),
        ),
      );
