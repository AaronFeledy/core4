import { Effect } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import type { ServiceConfig, ServicePlan } from "@lando/sdk/schema";

import { applyAuthoredDependencies } from "../services/authored-dependencies.ts";
import { composeBuildToArtifact, isComposeBuild } from "../services/compose-build-artifact.ts";
import { mergeComposeKnobs } from "../services/compose-knobs.ts";
import { applyPreparedService } from "../services/feature.ts";
import { applyAuthoredHealthcheck } from "./authored-probes.ts";
import {
  SERVICE_FEATURES_EXTENSION_KEY,
  mergeComposeExtension,
  normalizeBuildScripts,
  serviceFeatureBuildSteps,
  serviceFeatureExtension,
  toAppFeatureDraft,
} from "./extensions.ts";
import { serviceHomeIntent } from "./home.ts";
import { type PlannedServiceDraft, type ResolvedService, servicePlanError } from "./service-types.ts";
import { plannedContainerDestination } from "./storage.ts";
export { applyAuthoredHealthcheck } from "./authored-probes.ts";

export const validateAuthoredAppMount = (
  service: ServiceConfig,
  appRoot: string,
  serviceName: string,
): LandofileValidationError | undefined => {
  const authored = service.appMount;
  if (authored === undefined || authored === false) return;
  const target = plannedContainerDestination(authored.target, appRoot, [
    "services",
    serviceName,
    "appMount",
    "target",
  ]);
  if (!(target instanceof LandofileValidationError)) return;
  return new LandofileValidationError({
    message: target.message,
    remediation:
      "Set appMount to an absolute container path such as /app, or false to disable the app mount.",
    file: target.file,
    issues: target.issues.map((issue) => ({
      ...issue,
      suggestion:
        "Set appMount to an absolute container path such as /app, or false to disable the app mount.",
    })),
  });
};

export const applyAuthoredSqlite = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan =>
  service.sqlite === undefined ? servicePlan : { ...servicePlan, sqlite: service.sqlite };

export { applyAuthoredDependencies } from "../services/authored-dependencies.ts";

export const planServiceDrafts = Effect.fn("AppPlanner.planServices")(function* (input: {
  readonly resolvedServices: ReadonlyArray<ResolvedService>;
  readonly appRoot: string;
}): Effect.fn.Return<ReadonlyArray<PlannedServiceDraft>, LandofileValidationError> {
  const plannedServiceDrafts: PlannedServiceDraft[] = [];
  for (const {
    name,
    service,
    authored,
    serviceType,
    resolution,
    logSources,
    prepared,
    endpointContributions,
    applicationConfigs,
    routes,
    resolvedArtifactTag,
    configSourceInputs,
  } of input.resolvedServices) {
    const composition = yield* applyPreparedService({
      prepared,
      endpointContributions,
      applicationConfigs,
    }).pipe(
      Effect.mapError((error) =>
        servicePlanError(
          input.appRoot,
          name,
          error.cause instanceof LandofileValidationError ? error.cause : error,
        ),
      ),
    );
    const authoredServicePlanWithoutLabels = applyAuthoredDependencies(
      applyAuthoredSqlite(applyAuthoredHealthcheck(composition.plan, service), service),
      service,
    );
    const authoredServicePlan = mergeComposeKnobs(
      mergeComposeExtension(authoredServicePlanWithoutLabels, service),
      service,
    );
    const build = service.build;
    const authoredArtifact =
      build !== undefined && isComposeBuild(build) ? composeBuildToArtifact(build, input.appRoot) : undefined;
    const artifactScripts = authoredArtifact === undefined ? normalizeBuildScripts(build?.artifact) : [];
    const appScripts = authoredArtifact === undefined ? normalizeBuildScripts(build?.app) : [];
    const servicePlan: ServicePlan =
      artifactScripts.length === 0 && appScripts.length === 0
        ? authoredServicePlan
        : {
            ...authoredServicePlan,
            extensions: {
              ...authoredServicePlan.extensions,
              [SERVICE_FEATURES_EXTENSION_KEY]: {
                ...serviceFeatureExtension(authoredServicePlan.extensions),
                buildSteps: [
                  ...serviceFeatureBuildSteps(authoredServicePlan.extensions),
                  ...artifactScripts.map((script, index) => ({
                    id: `authored-artifact:${index + 1}`,
                    phase: "build" as const,
                    command: ["sh", "-lc", script.run],
                    ...(script.user === undefined ? {} : { user: script.user }),
                  })),
                  ...appScripts.map((script, index) => ({
                    id: `authored-app:${index + 1}`,
                    phase: "app" as const,
                    command: { command: ["sh", "-lc", script.run] },
                    ...(script.user === undefined ? {} : { user: script.user }),
                  })),
                ],
              },
            },
          };
    plannedServiceDrafts.push({
      name,
      authoredStorage: service.storage,
      hostnames: service.hostnames ?? [],
      authoredArtifact,
      authored,
      homeIntent: serviceHomeIntent({
        service: {
          ...service,
          ...(resolution.normalizedConfig.home === undefined
            ? {}
            : { home: resolution.normalizedConfig.home }),
        },
        serviceTypeId: serviceType.id,
        identity: serviceType.identity,
        pinnedArtifactTag: resolvedArtifactTag,
      }),
      // App-feature drafts carry original declarations, not synthesized publications.
      draft: toAppFeatureDraft(
        name,
        { ...servicePlan, endpoints: composition.endpointContributions },
        resolution,
        composition.featureIds,
      ),
      logSources,
      routes,
      extensions:
        configSourceInputs.length === 0
          ? servicePlan.extensions
          : {
              ...servicePlan.extensions,
              [SERVICE_FEATURES_EXTENSION_KEY]: {
                ...serviceFeatureExtension(servicePlan.extensions),
                configSources: [...configSourceInputs].sort((left, right) =>
                  left.key.localeCompare(right.key),
                ),
              },
            },
    });
  }
  return plannedServiceDrafts;
});
