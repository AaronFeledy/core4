/** Endpoint, route, and finalized per-service plan assembly. */
import { Effect, Schema } from "effect";

import {
  type CapabilityError,
  LandofileValidationError,
  PublicationUnsupportedError,
} from "@lando/sdk/errors";
import {
  type AppId,
  type FileSyncPlan,
  type ProviderCapabilities,
  type ProviderId,
  type RouteInput,
  type RoutePlan,
  ServiceName,
  ServicePlan,
  type StorageScope,
} from "@lando/sdk/schema";

import { validateServiceDependencies } from "../services/dependency-validation.ts";
import { redirectLogSourceBuildSteps, runtimeFollowLogSources } from "../services/redirect-log-sources.ts";
import {
  bindRealization,
  missingCapability,
  serviceArtifactBuildRemediation,
  serviceBindRemediation,
} from "./compose-capabilities.ts";
import { LOG_SOURCES_EXTENSION_KEY, isRecord, servicePlanFromDraft } from "./extensions.ts";
import { collectFileSyncEntries } from "./file-sync.ts";
import { DEFAULT_PROXY_DOMAIN } from "./naming.ts";
import type { PlannedServiceDraft } from "./service-types.ts";
import { expandExcludesToShadows } from "./storage.ts";

const duplicateEndpointNameError = (
  appRoot: string,
  serviceName: string,
  endpointName: string,
): LandofileValidationError =>
  new LandofileValidationError({
    message: `Service ${serviceName} declares duplicate endpoint name ${endpointName}.`,
    file: `${appRoot}/.lando.yml`,
    issues: [`services.${serviceName}.endpoints`],
  });

type RoutableEndpoint = ServicePlan["endpoints"][number] & {
  readonly protocol: "http" | "https";
  readonly port: number;
};

const isRoutableEndpoint = (endpoint: ServicePlan["endpoints"][number]): endpoint is RoutableEndpoint =>
  "port" in endpoint && (endpoint.protocol === "http" || endpoint.protocol === "https");

export const resolveRoute = (
  appRoot: string,
  serviceName: string,
  endpoints: ServicePlan["endpoints"],
  route: RouteInput,
): Effect.Effect<RoutePlan, LandofileValidationError> => {
  const candidates = endpoints.filter(isRoutableEndpoint);
  const endpoint =
    route.endpoint === undefined
      ? candidates[0]
      : candidates.find((candidate) =>
          typeof route.endpoint === "number"
            ? candidate.port === route.endpoint
            : candidate.name === route.endpoint,
        );
  if (endpoint === undefined) {
    return Effect.fail(
      new LandofileValidationError({
        message: `Route ${route.hostname} for service ${serviceName} does not resolve to an HTTP endpoint.`,
        file: `${appRoot}/.lando.yml`,
        issues: [`services.${serviceName}.routes`],
      }),
    );
  }
  return Effect.succeed({
    hostname: route.hostname,
    scheme: route.scheme ?? "https",
    service: ServiceName.make(serviceName),
    ...(route.endpoint === undefined ? {} : { endpoint: route.endpoint }),
    ...(route.pathPrefix === undefined ? {} : { pathPrefix: route.pathPrefix }),
    backend: {
      service: ServiceName.make(serviceName),
      protocol: endpoint.protocol,
      port: endpoint.port,
    },
  });
};

export interface FinalizedServices {
  readonly services: Record<string, unknown>;
  readonly serviceHostnames: Record<string, ReadonlyArray<string>>;
  readonly stores: ReadonlyArray<{
    readonly name: string;
    readonly scope: StorageScope;
    readonly kind?: "data" | "cache";
    readonly key?: string;
  }>;
  readonly fileSync: ReadonlyArray<FileSyncPlan>;
  readonly routes: ReadonlyArray<RoutePlan>;
}

export const finalizeServices = (input: {
  readonly plannedServiceDrafts: ReadonlyArray<PlannedServiceDraft>;
  readonly appId: ReturnType<typeof AppId.make>;
  readonly appRoot: string;
  readonly appSlug: string;
  readonly provider: ProviderId;
  readonly providerCapabilities: ProviderCapabilities;
  readonly metadata: ServicePlan["metadata"];
  readonly fileSyncEngineId: string | undefined;
}): Effect.Effect<
  FinalizedServices,
  LandofileValidationError | CapabilityError | PublicationUnsupportedError
> =>
  Effect.gen(function* () {
    const services: Record<string, unknown> = {};
    const serviceHostnames: Record<string, ReadonlyArray<string>> = {};
    const stores: Array<FinalizedServices["stores"][number]> = [];
    const fileSync: Array<FileSyncPlan> = [];
    const routes: Array<RoutePlan> = [];
    const routeIndexes = new Map<string, number>();
    const seenStoreNames = new Set<string>();

    const pushStore = (
      name: string,
      scope: StorageScope,
      kind: "data" | "cache" = "data",
      key?: string,
    ): void => {
      if (seenStoreNames.has(name)) return;
      seenStoreNames.add(name);
      stores.push({ name, scope, kind, ...(key === undefined ? {} : { key }) });
    };

    const pushRoute = (route: RoutePlan): number => {
      const key = `${route.hostname}\u0000${route.scheme}`;
      const existing = routeIndexes.get(key);
      if (existing !== undefined) return existing;
      const index = routes.length;
      routes.push(route);
      routeIndexes.set(key, index);
      return index;
    };

    for (const {
      name,
      hostnames,
      authoredArtifact,
      authored,
      draft,
      logSources,
      routes: authoredRoutes,
      extensions,
    } of input.plannedServiceDrafts) {
      const followLogSources = runtimeFollowLogSources(logSources);
      const providerSupportsLogSources = input.providerCapabilities.serviceLogSources === true;
      if (!providerSupportsLogSources) {
        const requiredFollowSource = followLogSources.find((source) => source.required === true);
        if (requiredFollowSource !== undefined) {
          yield* Effect.fail(
            missingCapability(
              input.provider,
              name,
              `required follow log source ${String(requiredFollowSource.id)}`,
              "serviceLogSources",
              `Use strategy: redirect for service ${name} log source ${String(requiredFollowSource.id)}, or choose a provider that advertises serviceLogSources.`,
            ),
          );
        }
      }

      const unavailableFollowSources = providerSupportsLogSources
        ? []
        : followLogSources.filter((source) => source.required !== true);
      const extensionsForPlan: ServicePlan["extensions"] =
        unavailableFollowSources.length === 0
          ? extensions
          : {
              ...extensions,
              [LOG_SOURCES_EXTENSION_KEY]: {
                ...(isRecord(extensions[LOG_SOURCES_EXTENSION_KEY])
                  ? extensions[LOG_SOURCES_EXTENSION_KEY]
                  : {}),
                unavailableFollow: unavailableFollowSources.map((source) => ({
                  id: String(source.id),
                  path: String(source.path),
                  reason:
                    "Provider does not advertise serviceLogSources; use strategy: redirect or choose a provider with serviceLogSources.",
                })),
              },
            };
      const redirectSteps = redirectLogSourceBuildSteps({ logSources, base: draft.base });
      const draftForPlan =
        redirectSteps.length === 0
          ? draft
          : { ...draft, buildSteps: [...draft.buildSteps, ...redirectSteps] };
      const servicePlan = {
        ...servicePlanFromDraft(draftForPlan, [], input.metadata, extensionsForPlan),
        ...(logSources.length === 0 ? {} : { logSources }),
      };

      if (
        (servicePlan.appMount !== undefined || servicePlan.mounts.some((mount) => mount.type === "bind")) &&
        (!input.providerCapabilities.bindMounts || input.providerCapabilities.bindMountPerformance === "none")
      ) {
        yield* Effect.fail(
          missingCapability(input.provider, name, "bind mount", "bindMounts", serviceBindRemediation(name)),
        );
      }

      const withArtifact =
        authoredArtifact === undefined ? servicePlan : { ...servicePlan, artifact: authoredArtifact };
      if (withArtifact.artifact?.kind === "build" && !input.providerCapabilities.artifactBuild) {
        yield* Effect.fail(
          missingCapability(
            input.provider,
            name,
            "artifact build",
            "artifactBuild",
            serviceArtifactBuildRemediation(name),
          ),
        );
      }

      const realization = bindRealization(input.providerCapabilities);
      const shadowResult = expandExcludesToShadows(input.appSlug, name, withArtifact);
      const planWithShadows = shadowResult.servicePlan;
      const appMount = planWithShadows.appMount;
      const servicePlanWithCapabilityRealization: ServicePlan = {
        ...planWithShadows,
        ...(appMount === undefined ? {} : { appMount: { ...appMount, realization } }),
        mounts: planWithShadows.mounts.map((mount) =>
          mount.type === "bind" ? { ...mount, realization } : mount,
        ),
      };

      const endpointNames = new Set<string>();
      for (const endpoint of servicePlanWithCapabilityRealization.endpoints) {
        if (endpoint.name === undefined) continue;
        if (endpointNames.has(endpoint.name)) {
          yield* Effect.fail(duplicateEndpointNameError(input.appRoot, name, endpoint.name));
        }
        endpointNames.add(endpoint.name);
      }

      const routeRefs: Array<ServicePlan["routes"][number]> = [];
      if (authoredRoutes.length > 0) {
        for (const route of authoredRoutes) {
          routeRefs.push({
            index: pushRoute(
              yield* resolveRoute(input.appRoot, name, servicePlanWithCapabilityRealization.endpoints, route),
            ),
          });
        }
      } else {
        const endpoint = servicePlanWithCapabilityRealization.endpoints.find(isRoutableEndpoint);
        if (endpoint !== undefined) {
          routeRefs.push({
            index: pushRoute({
              hostname: `${name}.${input.appSlug}.${DEFAULT_PROXY_DOMAIN}`,
              scheme: "https",
              service: ServiceName.make(name),
              ...(endpoint.name === undefined ? { endpoint: endpoint.port } : { endpoint: endpoint.name }),
              backend: {
                service: ServiceName.make(name),
                protocol: endpoint.protocol,
                port: endpoint.port,
              },
            }),
          });
        }
      }
      const servicePlanWithRoutes: ServicePlan = {
        ...servicePlanWithCapabilityRealization,
        routes: routeRefs,
      };

      if (
        servicePlanWithRoutes.endpoints.some((endpoint) => endpoint._tag === "published") &&
        input.providerCapabilities.hostPortPublish === "none"
      ) {
        yield* Effect.fail(
          new PublicationUnsupportedError({
            message: `Provider ${input.provider} cannot publish endpoints for service ${name}.`,
            providerId: input.provider,
            service: name,
            capability: "hostPortPublish",
            remediation: `Choose a provider with host port publish support or make service ${name} endpoints internal.`,
          }),
        );
      }

      if (servicePlanWithRoutes.storage.length > 0 && !input.providerCapabilities.persistentStorage) {
        yield* Effect.fail(
          missingCapability(
            input.provider,
            name,
            "persistent storage",
            "persistentStorage",
            `Choose a provider with persistent storage support or remove persistent storage from service ${name}.`,
          ),
        );
      }

      const healthcheck = servicePlanWithRoutes.healthcheck;
      if (healthcheck !== undefined && healthcheck.kind !== "command" && healthcheck.kind !== "none") {
        yield* Effect.fail(
          missingCapability(
            input.provider,
            name,
            `healthcheck kind ${healthcheck.kind}`,
            "serviceHealth",
            `Healthcheck for service ${name} uses kind: ${healthcheck.kind}, but only kind: command is supported (executed via the provider's exec channel). Author healthcheck as kind: command or remove it.`,
          ),
        );
      }

      serviceHostnames[name] = hostnames;
      services[name] = Schema.encodeSync(ServicePlan)(servicePlanWithRoutes);
      for (const shadow of shadowResult.shadowStores) pushStore(shadow.name, shadow.scope);
      for (const mount of servicePlanWithRoutes.storage) {
        const authoredInfo = authored.byStore.get(mount.store);
        pushStore(
          mount.store,
          authoredInfo?.scope ?? "service",
          authoredInfo?.kind ?? "data",
          authoredInfo?.key,
        );
      }
      if (input.fileSyncEngineId !== undefined) {
        fileSync.push(
          ...collectFileSyncEntries({
            appId: input.appId,
            appRoot: input.appRoot,
            appName: input.appSlug,
            serviceName: name,
            servicePlan: servicePlanWithRoutes,
            engineId: input.fileSyncEngineId,
          }),
        );
      }
    }

    yield* validateServiceDependencies(input.appRoot, services);
    return { services, serviceHostnames, stores, fileSync, routes };
  });
