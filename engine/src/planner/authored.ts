import { mapFailures } from "@lando/sdk/command-result";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type ServiceConfig,
  type ServicePlan,
  canonicalSqlitePath,
  serviceAppMount,
  validationIssue,
} from "@lando/sdk/schema";
import { Effect } from "effect";

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
import { servicePullPolicy } from "./pull-policy.ts";
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

export const applyAuthoredSqlite = Effect.fnUntraced(function* (
  servicePlan: ServicePlan,
  service: ServiceConfig,
  appRoot: string,
): Effect.fn.Return<ServicePlan, LandofileValidationError> {
  if (service.sqlite === undefined) return servicePlan;
  const conflict = servicePlan.connection !== undefined || servicePlan.nonSqlCreds !== undefined;
  if (conflict || serviceAppMount(servicePlan) === undefined) {
    const message = conflict
      ? "SQLite cannot coexist with database connections or non-SQL credentials."
      : "SQLite requires an app mount on the service.";
    const suggestion = conflict
      ? "Move sqlite to a separate app service without published credentials."
      : "Enable an app mount on this service, or move sqlite to a service that mounts the app.";
    return yield* Effect.fail(
      new LandofileValidationError({
        message,
        file: appRoot,
        remediation: suggestion,
        issues: [{ ...validationIssue(["services", servicePlan.name, "sqlite"], message), suggestion }],
      }),
    );
  }
  const { connection: _connection, nonSqlCreds: _nonSqlCreds, ...filePlan } = servicePlan;
  return { ...filePlan, sqlite: { path: canonicalSqlitePath(service.sqlite.path) } };
});

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
      mapFailures((error) =>
        servicePlanError(
          input.appRoot,
          name,
          error.cause instanceof LandofileValidationError ? error.cause : error,
        ),
      ),
    );
    const authoredServicePlanWithoutLabels = applyAuthoredDependencies(
      yield* applyAuthoredSqlite(applyAuthoredHealthcheck(composition.plan, service), service, input.appRoot),
      service,
    );
    const authoredServicePlan = mergeComposeKnobs(
      mergeComposeExtension(authoredServicePlanWithoutLabels, service),
      service,
    );
    const build = service.build;
    const composeArtifact =
      build !== undefined && isComposeBuild(build) ? composeBuildToArtifact(build, input.appRoot) : undefined;
    const authoredArtifact =
      composeArtifact ??
      (service.image === undefined ? undefined : { kind: "ref" as const, ref: service.image });
    const artifactScripts = composeArtifact === undefined ? normalizeBuildScripts(build?.artifact) : [];
    const appScripts = composeArtifact === undefined ? normalizeBuildScripts(build?.app) : [];
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
                    command: ["sh", "-c", script.run],
                    ...(script.user === undefined ? {} : { user: script.user }),
                  })),
                  ...appScripts.map((script, index) => ({
                    id: `authored-app:${index + 1}`,
                    phase: "app" as const,
                    command: { command: ["sh", "-c", script.run] },
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
      pullPolicy: servicePullPolicy(service),
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
