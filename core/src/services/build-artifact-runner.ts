import { Effect } from "effect";

import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ArtifactRef, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";

import { artifactBuildStepsFor } from "./build-key.ts";

const CA_BUNDLE_PATH = "/etc/lando/certs/ca-bundle.pem" as const;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasTrustStoreBuild = (service: ServicePlan): boolean => {
  const extension = service.extensions["@lando/core/service-features"];
  if (!isRecord(extension) || !Array.isArray(extension.buildSteps)) return false;
  return extension.buildSteps.some(
    (step) =>
      isRecord(step) &&
      step.id === "lando.security:trust-store" &&
      step.phase === "build" &&
      Array.isArray(step.caFiles) &&
      step.caFiles.length > 0,
  );
};

interface ProviderBuildInput {
  readonly provider: RuntimeProviderShape;
  readonly plan: AppPlan;
  readonly service: ServicePlan;
  readonly buildKey: string;
  readonly resolvedSource?: ArtifactRef;
}

export const runProviderBuild = (input: ProviderBuildInput): Effect.Effect<ArtifactRef, ProviderError> =>
  Effect.gen(function* () {
    const { provider, plan, service, buildKey, resolvedSource } = input;
    const artifact = service.artifact;
    if (artifact?.kind === "ref" && artifactBuildStepsFor(service).length === 0) {
      if (resolvedSource !== undefined) {
        return resolvedSource.digest !== undefined || artifact.digest === undefined
          ? resolvedSource
          : { ...resolvedSource, digest: artifact.digest };
      }
      if (provider.capabilities.artifactPull) {
        const pulled = yield* provider.pullArtifact({ ref: artifact.ref });
        if (pulled.digest !== undefined || artifact.digest === undefined) return pulled;
        return { ...pulled, digest: artifact.digest };
      }
      return {
        providerId: plan.provider,
        ref: artifact.ref,
        ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
      };
    }
    return yield* Effect.scoped(
      provider.buildArtifact({ app: plan.id, service: service.name, plan, buildKey }),
    );
  });

export const serviceWithArtifact = (service: ServicePlan, artifact: ArtifactRef): ServicePlan => {
  const mounts = hasTrustStoreBuild(service)
    ? service.mounts.filter((mount) => String(mount.target) !== CA_BUNDLE_PATH)
    : service.mounts;
  return {
    ...service,
    mounts,
    artifact: {
      kind: "ref",
      ref: artifact.ref,
      ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
    },
  };
};
