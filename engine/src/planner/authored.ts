/** Authored service overrides and service-draft assembly. */
import { type Context, Effect } from "effect";

import type { LandofileValidationError } from "@lando/sdk/errors";
import {
  PortablePath,
  type ProviderId,
  type RouteInput,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { PluginRegistry, ServiceTypeHostFacts } from "@lando/sdk/services";

import { composeBuildToArtifact, isComposeBuild } from "../services/compose-build-artifact.ts";
import { mergeComposeKnobs } from "../services/compose-knobs.ts";
import { type ComposeServiceFeature, composeService } from "../services/feature.ts";
import {
  SERVICE_FEATURES_EXTENSION_KEY,
  mergeComposeExtension,
  normalizeBuildScripts,
  serviceFeatureBuildSteps,
  serviceFeatureExtension,
  toAppFeatureDraft,
} from "./extensions.ts";
import { mergeDefaultExcludes } from "./file-sync.ts";
import type { PlannedServiceDraft, ResolvedService } from "./service-types.ts";
import { servicePlanError } from "./service-types.ts";
import { applyAuthoredStorage } from "./storage.ts";

export const applyAuthoredAppMount = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authored = service.appMount;
  if (authored === undefined || authored === false) return servicePlan;
  const existingMount = servicePlan.appMount;
  if (existingMount === undefined) return servicePlan;
  const merged = {
    ...existingMount,
    target: PortablePath.make(authored.target),
    readOnly: authored.readOnly ?? existingMount.readOnly,
    excludes:
      authored.excludes !== undefined
        ? [...existingMount.excludes, ...authored.excludes.filter((e) => !existingMount.excludes.includes(e))]
        : existingMount.excludes,
    includes: authored.includes ?? existingMount.includes,
  };
  return { ...servicePlan, appMount: merged };
};

export const applyAuthoredHealthcheck = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authored = service.healthcheck;
  if (authored === undefined) return servicePlan;
  const existing = servicePlan.healthcheck;
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
  };
  if (merged.kind === "command" && merged.command === undefined) return servicePlan;
  return { ...servicePlan, healthcheck: merged };
};

export const applyAuthoredDependencies = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authoredDependencies = new Map(
    (service.dependsOn ?? []).map((dependency) => [
      dependency.service,
      {
        service: ServiceName.make(dependency.service),
        condition: dependency.condition ?? "service_started",
        required: dependency.required ?? true,
      },
    ]),
  );
  if (authoredDependencies.size === 0) return servicePlan;

  const contributedServices = new Set(servicePlan.dependsOn.map((dependency) => dependency.service));
  return {
    ...servicePlan,
    dependsOn: [
      ...servicePlan.dependsOn.map(
        (dependency) => authoredDependencies.get(dependency.service) ?? dependency,
      ),
      ...[...authoredDependencies]
        .filter(([service]) => !contributedServices.has(ServiceName.make(service)))
        .map(([, dependency]) => dependency),
    ],
  };
};

export const planServiceDrafts = (input: {
  readonly pluginRegistry: Context.Tag.Service<typeof PluginRegistry>;
  readonly resolvedServices: ReadonlyArray<ResolvedService>;
  readonly provider: ProviderId;
  readonly appName: string;
  readonly appRoot: string;
  readonly host: ServiceTypeHostFacts | undefined;
  readonly landofileProxy: Readonly<Record<string, ReadonlyArray<RouteInput>>> | undefined;
}): Effect.Effect<ReadonlyArray<PlannedServiceDraft>, LandofileValidationError> =>
  Effect.gen(function* () {
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
    } of input.resolvedServices) {
      const rawPlan = yield* Effect.gen(function* () {
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
        return yield* composeService({
          base: {
            name: ServiceName.make(name),
            type: resolution.normalizedConfig.type ?? serviceType.id,
            provider: input.provider,
            primary: resolution.normalizedConfig.primary ?? name === "web",
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
        }).pipe(Effect.mapError((error) => servicePlanError(input.appRoot, name, error)));
      });
      const authoredServicePlanWithoutLabels = applyAuthoredDependencies(
        applyAuthoredStorage(
          applyAuthoredHealthcheck(applyAuthoredAppMount(mergeDefaultExcludes(rawPlan), service), service),
          service,
        ),
        service,
      );
      const authoredServicePlan = mergeComposeKnobs(
        mergeComposeExtension(authoredServicePlanWithoutLabels, service),
        service,
      );
      const build = service.build;
      const authoredArtifact =
        build !== undefined && isComposeBuild(build)
          ? composeBuildToArtifact(build, input.appRoot)
          : undefined;
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
                      command: ["sh", "-lc", script],
                    })),
                    ...appScripts.map((script, index) => ({
                      id: `authored-app:${index + 1}`,
                      phase: "app" as const,
                      command: { command: ["sh", "-lc", script] },
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
        draft: toAppFeatureDraft(name, servicePlan, resolution, baseDefaultIds),
        logSources,
        routes: [...(service.routes ?? []), ...(input.landofileProxy?.[ServiceName.make(name)] ?? [])],
        extensions: servicePlan.extensions,
      });
    }
    return plannedServiceDrafts;
  });
