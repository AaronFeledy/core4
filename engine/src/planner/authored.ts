import { type Context, Effect } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { type ProviderId, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { PluginRegistry, ServiceTypeHostFacts } from "@lando/sdk/services";

import { applyAuthoredDependencies } from "../services/authored-dependencies.ts";
import { composeBuildToArtifact, isComposeBuild } from "../services/compose-build-artifact.ts";
import { mergeComposeKnobs } from "../services/compose-knobs.ts";
import { type ComposeServiceFeature, composeServiceWithContributions } from "../services/feature.ts";
import { planServicePrimary } from "./effective-events.ts";
import {
  SERVICE_FEATURES_EXTENSION_KEY,
  mergeComposeExtension,
  normalizeBuildScripts,
  serviceFeatureBuildSteps,
  serviceFeatureExtension,
  toAppFeatureDraft,
} from "./extensions.ts";
import { mergeDefaultExcludes } from "./file-sync.ts";
import { serviceHomeIntent } from "./home.ts";
import { type PlannedServiceDraft, type ResolvedService, servicePlanError } from "./service-types.ts";
import { applyAuthoredStorage, plannedContainerDestination } from "./storage.ts";

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

export const applyAuthoredHealthcheck = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authored = service.healthcheck;
  if (authored === undefined) return servicePlan;
  const existing = servicePlan.healthcheck;
  if (authored === false)
    return {
      ...servicePlan,
      readiness: { kind: "none", intervalSeconds: 10, timeoutSeconds: 5, retries: 5 },
      healthcheck: {
        kind: "none",
        intervalSeconds: existing?.intervalSeconds ?? 10,
        timeoutSeconds: existing?.timeoutSeconds ?? 5,
        retries: existing?.retries ?? 5,
      },
    };
  const command = authored.command ?? existing?.command;
  const url = authored.url ?? existing?.url;
  const port = authored.port ?? existing?.port;
  const startPeriodSeconds = authored.startPeriodSeconds ?? existing?.startPeriodSeconds;
  const merged: ServicePlan["healthcheck"] = {
    kind: authored.kind ?? existing?.kind ?? "command",
    intervalSeconds: authored.intervalSeconds ?? existing?.intervalSeconds ?? 10,
    timeoutSeconds: authored.timeoutSeconds ?? existing?.timeoutSeconds ?? 5,
    retries: authored.retries ?? existing?.retries ?? 5,
    ...(command !== undefined ? { command } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(startPeriodSeconds !== undefined ? { startPeriodSeconds } : {}),
    ...(authored.command === undefined && existing?.target !== undefined ? { target: existing.target } : {}),
  };
  if (merged.kind === "command" && merged.command === undefined) return servicePlan;
  return { ...servicePlan, healthcheck: merged, readiness: merged };
};

export { applyAuthoredDependencies } from "../services/authored-dependencies.ts";

export const planServiceDrafts = Effect.fn("AppPlanner.planServices")(function* (input: {
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
  readonly resolvedServices: ReadonlyArray<ResolvedService>;
  readonly provider: ProviderId;
  readonly appName: string;
  readonly appRoot: string;
  readonly host: ServiceTypeHostFacts | undefined;
}): Effect.fn.Return<ReadonlyArray<PlannedServiceDraft>, LandofileValidationError> {
  const plannedServiceDrafts: PlannedServiceDraft[] = [];
  for (const {
    name,
    service,
    authored,
    serviceType,
    resolution,
    logSources,
    baseDefaultIds,
    featureRefs,
    routes,
    resolvedArtifactTag,
    configSourceInputs,
  } of input.resolvedServices) {
    const composition = yield* Effect.gen(function* () {
      const configuredFeatureRefs = featureRefs.filter(
        (featureRef) => !baseDefaultIds.includes(featureRef.id) || featureRef.config !== undefined,
      );
      const configuredFeatureIds = new Set(configuredFeatureRefs.map((featureRef) => featureRef.id));
      const features = yield* Effect.forEach(configuredFeatureRefs, (featureRef) =>
        input.pluginRegistry.loadServiceFeature(featureRef.id).pipe(
          Effect.map(
            (definition): ComposeServiceFeature => ({
              id: featureRef.id,
              ...(featureRef.config === undefined ? {} : { config: featureRef.config }),
              definition,
            }),
          ),
          Effect.mapError((error) => servicePlanError(input.appRoot, name, error)),
        ),
      );
      const defaultFeatures = yield* Effect.forEach(
        baseDefaultIds.filter((id) => !configuredFeatureIds.has(id)),
        (id) =>
          input.pluginRegistry
            .loadServiceFeature(id)
            .pipe(Effect.mapError((error) => servicePlanError(input.appRoot, name, error))),
      );
      return yield* composeServiceWithContributions({
        base: {
          name: ServiceName.make(name),
          type: resolution.normalizedConfig.type ?? serviceType.id,
          serviceTypeId: serviceType.id,
          provider: input.provider,
          primary: planServicePrimary(name, resolution.normalizedConfig.primary),
          ...(resolution.connection === undefined ? {} : { connection: resolution.connection }),
          ...(resolution.nonSqlCreds === undefined ? {} : { nonSqlCreds: resolution.nonSqlCreds }),
          ...(resolution.normalizedConfig.environment === undefined
            ? {}
            : { environment: resolution.normalizedConfig.environment }),
          defaultFeatures,
        },
        baseKind: resolution.base,
        appName: input.appName,
        appRoot: input.appRoot,
        host: input.host,
        normalizedConfig: resolution.normalizedConfig,
        features,
      }).pipe(
        Effect.mapError((error) =>
          servicePlanError(
            input.appRoot,
            name,
            error.cause instanceof LandofileValidationError ? error.cause : error,
          ),
        ),
      );
    });
    const withDefaultExcludes = mergeDefaultExcludes(composition.plan);
    const withStorage = applyAuthoredStorage(
      applyAuthoredHealthcheck(withDefaultExcludes, service),
      service,
      input.appRoot,
      name,
    );
    if (withStorage instanceof LandofileValidationError) return yield* Effect.fail(withStorage);
    const authoredServicePlanWithoutLabels = applyAuthoredDependencies(withStorage, service);
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
        baseDefaultIds,
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
