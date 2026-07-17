import { Effect } from "effect";

import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ArtifactRef, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";

import { buildStepsFor } from "./build-key.ts";

export const runProviderBuild = (
  provider: RuntimeProviderShape,
  plan: AppPlan,
  service: ServicePlan,
  buildKey: string,
): Effect.Effect<ArtifactRef, ProviderError> =>
  Effect.gen(function* () {
    const artifact = service.artifact;
    if (artifact?.kind === "ref" && buildStepsFor(service).length === 0) {
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
