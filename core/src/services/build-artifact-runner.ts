import { Effect } from "effect";

import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ArtifactRef, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";

import { artifactBuildStepsFor } from "./build-key.ts";

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

export const serviceWithArtifact = (service: ServicePlan, artifact: ArtifactRef): ServicePlan => ({
  ...service,
  artifact: {
    kind: "ref",
    ref: artifact.ref,
    ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
  },
});
