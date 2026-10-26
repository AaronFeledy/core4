import type { FileSystem } from "@lando/sdk/services";
import { type Context, Effect, Predicate, Schema } from "effect";

import {
  type CapabilityError,
  DataTreeOwnershipCapabilityError,
  HomePathCapabilityError,
  LandofileValidationError,
  type PublicationUnsupportedError,
  type RouteInputError,
} from "@lando/sdk/errors";
import {
  type AppId,
  type FileSyncPlan,
  type ProviderCapabilities,
  type ProviderId,
  type RoutePlan,
  ServicePlan,
  type StorageScope,
  selectHttpEndpoint,
} from "@lando/sdk/schema";

import { validateServiceDependencies } from "../services/dependency-validation.ts";
import { sortRecord } from "../services/draft.ts";
import { endpointValidationError, normalizeEndpoints } from "../services/endpoint-normalizer.ts";
import { redirectLogSourceBuildSteps, runtimeFollowLogSources } from "../services/redirect-log-sources.ts";
import { applyHostReachability } from "../subsystems/networking.ts";
import { bindRealization, missingCapability } from "./compose-capabilities.ts";
import { dataTreeOwnershipStep, resolveDataTreeOwnership } from "./data-tree.ts";
import { resolveRoute } from "./endpoint-routes.ts";
import { LOG_SOURCES_EXTENSION_KEY, servicePlanFromDraft } from "./extensions.ts";
import { collectFileSyncEntries } from "./file-sync.ts";
import { type GitHostCheck, readGitDirectories, worktreeGitMounts } from "./git-host-checks.ts";
import { applyServiceHome } from "./home.ts";
import {
  publicationCapabilityError,
  requiredLogSourceCapabilityError,
  serviceResourceCapabilityErrors,
} from "./resource-capabilities.ts";
import { makeRouteAccumulator, prioritizeRoutes } from "./route-identity.ts";
import type { PlannedServiceDraft } from "./service-types.ts";
import { type ShadowHostCheck, checkShadowHosts } from "./shadow-host-checks.ts";
import { expandExcludesToShadows } from "./storage.ts";
export { resolveRoute } from "./endpoint-routes.ts";

export interface FinalizedServices {
  readonly gitHostChecks: readonly GitHostCheck[];
  readonly shadowHostChecks: readonly ShadowHostCheck[];
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

export const finalizeServices = Effect.fn("AppPlanner.finalizeServices")(function* (input: {
  readonly plannedServiceDrafts: ReadonlyArray<PlannedServiceDraft>;
  readonly appId: ReturnType<typeof AppId.make>;
  readonly appRoot: string;
  readonly appSlug: string;
  readonly defaultDomain: string;
  readonly provider: ProviderId;
  readonly providerCapabilities: ProviderCapabilities;
  readonly metadata: ServicePlan["metadata"];
  readonly fileSyncEngineId: string | undefined;
  readonly fileSystem?: Context.Service.Shape<typeof FileSystem> | undefined;
}): Effect.fn.Return<
  FinalizedServices,
  | LandofileValidationError
  | CapabilityError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | PublicationUnsupportedError
  | RouteInputError
> {
  const services: Record<string, unknown> = {};
  const shadowHostChecks: ShadowHostCheck[] = [];
  const gitHostChecks: GitHostCheck[] = [];
  const serviceHostnames: Record<string, ReadonlyArray<string>> = {};
  const stores: Array<FinalizedServices["stores"][number]> = [];
  const fileSync: Array<FileSyncPlan> = [];
  const routeAccumulator = makeRouteAccumulator();
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

  for (const {
    name,
    hostnames,
    authoredArtifact,
    authored,
    draft,
    homeIntent,
    logSources,
    routes: authoredRoutes,
    extensions,
  } of input.plannedServiceDrafts) {
    const followLogSources = runtimeFollowLogSources(logSources);
    const providerSupportsLogSources = input.providerCapabilities.serviceLogSources === true;
    const requiredFollowSource = followLogSources.find((source) => source.required === true);
    const logSourceError = requiredLogSourceCapabilityError(input.provider, input.providerCapabilities, {
      name,
      ...(requiredFollowSource === undefined ? {} : { id: String(requiredFollowSource.id) }),
    });
    if (logSourceError !== undefined) yield* Effect.fail(logSourceError);

    const unavailableFollowSources = providerSupportsLogSources
      ? []
      : followLogSources.filter((source) => source.required !== true);
    const extensionsForPlan: ServicePlan["extensions"] =
      unavailableFollowSources.length === 0
        ? extensions
        : {
            ...extensions,
            [LOG_SOURCES_EXTENSION_KEY]: {
              ...(Predicate.isObject(extensions[LOG_SOURCES_EXTENSION_KEY])
                ? extensions[LOG_SOURCES_EXTENSION_KEY]
                : {}),
              unavailableFollow: unavailableFollowSources.map((source) => ({
                id: String(source.id),
                path: String(source.path),
                reason:
                  "This provider cannot follow log files. Set `strategy: redirect` on this source to view it with `lando logs`.",
              })),
            },
          };
    const redirectSteps = redirectLogSourceBuildSteps({ logSources, base: draft.base });
    // Data-tree ownership resolves here, where the composed `draft.user` and
    // the service type's image identity are both final. The step it produces
    // prepares the tree during the image build, so the planned user owns the
    // named volume the runtime seeds from that path.
    const ownedTrees = resolveDataTreeOwnership({
      serviceName: name,
      serviceType: homeIntent.serviceType,
      identity: homeIntent.identity,
      hasCustomImage: homeIntent.customImage === true,
      trees: draft.storageOwnership ?? [],
      plannedUser: draft.user,
    });
    if (ownedTrees instanceof DataTreeOwnershipCapabilityError) {
      return yield* Effect.fail(ownedTrees);
    }
    const ownershipStep = dataTreeOwnershipStep(ownedTrees);
    const draftForPlan =
      ownershipStep === undefined && redirectSteps.length === 0
        ? draft
        : {
            ...draft,
            buildSteps: [
              ...(ownershipStep === undefined ? [] : [ownershipStep]),
              ...draft.buildSteps,
              ...redirectSteps,
            ],
          };
    const endpoints = normalizeEndpoints(draft.endpoints, draft.normalizedConfig);
    const endpointError = endpointValidationError(endpoints, { appRoot: input.appRoot, serviceName: name });
    if (endpointError !== undefined) return yield* Effect.fail(endpointError);
    const planned = applyHostReachability(
      servicePlanFromDraft({ ...draftForPlan, endpoints }, [], input.metadata, extensionsForPlan),
      input.providerCapabilities.hostReachability,
    );
    const servicePlan = {
      ...planned,
      environment: sortRecord(planned.environment),
      ...(logSources.length === 0 ? {} : { logSources }),
    };

    for (const error of serviceResourceCapabilityErrors(input.provider, input.providerCapabilities, {
      name,
      bindMounts:
        servicePlan.appMount !== undefined || servicePlan.mounts.some((mount) => mount.type === "bind"),
    }))
      yield* Effect.fail(error);

    const withArtifact =
      authoredArtifact === undefined ? servicePlan : { ...servicePlan, artifact: authoredArtifact };
    for (const error of serviceResourceCapabilityErrors(input.provider, input.providerCapabilities, {
      name,
      artifactBuild: withArtifact.artifact?.kind === "build",
    }))
      yield* Effect.fail(error);

    const realization = bindRealization(input.providerCapabilities);
    const hostChecks = yield* checkShadowHosts(withArtifact.appMount, input.fileSystem);
    const shadowableExcludes = new Set<string>();
    for (const { exclude, ...check } of hostChecks) {
      shadowHostChecks.push(check);
      if (check.shadowed) shadowableExcludes.add(exclude);
    }
    const shadowResult = expandExcludesToShadows(
      input.appSlug,
      name,
      withArtifact,
      input.appRoot,
      shadowableExcludes,
    );
    if (shadowResult instanceof LandofileValidationError) {
      return yield* Effect.fail(shadowResult);
    }
    const planWithShadows = shadowResult.servicePlan;
    const appMount = planWithShadows.appMount;
    const servicePlanWithCapabilityRealization: ServicePlan = {
      ...planWithShadows,
      ...(appMount === undefined ? {} : { appMount: { ...appMount, realization } }),
      mounts: planWithShadows.mounts.map((mount) =>
        mount.type === "bind" ? { ...mount, realization: "passthrough" as const } : mount,
      ),
    };

    let gitDirectories: GitHostCheck["directories"] = null;
    if (realization === "passthrough" && appMount !== undefined) {
      const gitPath = `${appMount.source}/.git`;
      gitDirectories = yield* readGitDirectories(gitPath, appMount.target, input.fileSystem);
      gitHostChecks.push({ path: gitPath, target: appMount.target, directories: gitDirectories });
    }
    const withHome = applyServiceHome({
      servicePlan: {
        ...servicePlanWithCapabilityRealization,
        mounts: [
          ...servicePlanWithCapabilityRealization.mounts,
          ...worktreeGitMounts(servicePlanWithCapabilityRealization, gitDirectories),
        ],
      },
      serviceName: name,
      appSlug: input.appSlug,
      appRoot: input.appRoot,
      intent: homeIntent,
    });
    if (withHome instanceof HomePathCapabilityError) {
      return yield* Effect.fail(withHome);
    }
    if (withHome instanceof LandofileValidationError) {
      return yield* Effect.fail(withHome);
    }
    const servicePlanWithHome = withHome;

    const routeRefs: Array<ServicePlan["routes"][number]> = [];
    if (authoredRoutes !== undefined) {
      for (const [routeIndex, route] of authoredRoutes.entries()) {
        routeRefs.push(
          ...(yield* routeAccumulator.add(
            yield* resolveRoute(input.appRoot, name, servicePlanWithHome.endpoints, route),
            route.source ?? { key: `services.${name}.routes[${routeIndex}]` },
          )),
        );
      }
    } else {
      const selection = selectHttpEndpoint(servicePlanWithHome.endpoints);
      if (selection.status !== "none") {
        routeRefs.push(
          ...(yield* routeAccumulator.add(
            yield* resolveRoute(input.appRoot, name, servicePlanWithHome.endpoints, {
              hostname: `${name}.${input.appSlug}.${input.defaultDomain}`,
              scheme: "https",
              filters: [],
              ...(selection.status === "selected"
                ? { endpoint: selection.endpoint.names[0] ?? selection.endpoint.port }
                : {}),
            }),
            { key: `services.${name}.endpoints` },
          )),
        );
      }
    }
    const servicePlanWithRoutes: ServicePlan = {
      ...servicePlanWithHome,
      routes: routeRefs.filter(
        (ref, index) => routeRefs.findIndex((other) => other.index === ref.index) === index,
      ),
    };

    const publicationError = publicationCapabilityError(input.provider, input.providerCapabilities, {
      name,
      published: servicePlanWithRoutes.endpoints.some((endpoint) => endpoint._tag === "published"),
    });
    if (publicationError !== undefined) yield* Effect.fail(publicationError);

    for (const error of serviceResourceCapabilityErrors(input.provider, input.providerCapabilities, {
      name,
      persistentStorage: servicePlanWithRoutes.storage.length > 0,
    }))
      yield* Effect.fail(error);

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
  return {
    gitHostChecks,
    shadowHostChecks,
    services,
    serviceHostnames,
    stores,
    fileSync,
    routes: prioritizeRoutes(routeAccumulator.routes),
  };
});
