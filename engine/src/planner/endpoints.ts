import type { FileSystem } from "@lando/sdk/services";
import { type Context, Effect, Predicate, Schema } from "effect";

import {
  type CapabilityError,
  DataTreeOwnershipCapabilityError,
  type FileSyncSelectionError,
  LandofileValidationError,
  type PublicationUnsupportedError,
  type RouteInputError,
  ServiceFeatureError,
} from "@lando/sdk/errors";
import {
  type AppId,
  type FileSyncPlan,
  type FileSyncPolicy,
  type FileSyncPolicyReason,
  type LandofileShape,
  type ProviderCapabilities,
  type ProviderId,
  type RoutePlan,
  ServicePlan,
  type StorageScope,
  selectHttpEndpoint,
  serviceAppMount,
} from "@lando/sdk/schema";

import {
  type SelectedFileSyncPolicy,
  recordFileSyncPolicy,
  serviceFileSyncPolicy,
} from "../plugins/file-sync-policy.ts";
import { validateServiceDependencies } from "../services/dependency-validation.ts";
import { sortRecord } from "../services/draft.ts";
import { endpointValidationError, normalizeEndpoints } from "../services/endpoint-normalizer.ts";
import { redirectLogSourceBuildSteps, runtimeFollowLogSources } from "../services/redirect-log-sources.ts";
import { applyHostReachability } from "../subsystems/networking.ts";
import { missingCapability } from "./compose-capabilities.ts";
import { dataTreeOwnershipStep, resolveDataTreeOwnership } from "./data-tree.ts";
import { resolveRoute } from "./endpoint-routes.ts";
import { LOG_SOURCES_EXTENSION_KEY, servicePlanFromDraft } from "./extensions.ts";
import { collectFileSyncEntries } from "./file-sync.ts";
import { type GitHostCheck, readGitDirectories, worktreeGitMounts } from "./git-host-checks.ts";
import { applyServiceHome } from "./home.ts";
import { deriveMountOverlays, prepareServiceMounts, realizeServiceMounts } from "./mounts.ts";
import {
  publicationCapabilityError,
  requiredLogSourceCapabilityError,
  serviceResourceCapabilityErrors,
} from "./resource-capabilities.ts";
import { makeRouteAccumulator, prioritizeRoutes } from "./route-identity.ts";
import { type PlannedServiceDraft, servicePlanError } from "./service-types.ts";
import type { ShadowHostCheck } from "./shadow-host-checks.ts";
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
  readonly fileSyncPolicy: FileSyncPolicy;
  readonly routes: ReadonlyArray<RoutePlan>;
}

export const finalizeServices = Effect.fn("AppPlanner.finalizeServices")(function* (input: {
  readonly plannedServiceDrafts: ReadonlyArray<PlannedServiceDraft>;
  readonly appId: ReturnType<typeof AppId.make>;
  readonly appRoot: string;
  readonly appSlug: string;
  readonly appName: string;
  readonly configs?: LandofileShape["configs"];
  readonly defaultDomain: string;
  readonly provider: ProviderId;
  readonly providerCapabilities: ProviderCapabilities;
  readonly metadata: ServicePlan["metadata"];
  readonly ordinaryFileSyncReason: FileSyncPolicyReason;
  readonly selectFileSyncEngine: Effect.Effect<SelectedFileSyncPolicy | undefined, FileSyncSelectionError>;
  readonly fileSystem?: Context.Service.Shape<typeof FileSystem> | undefined;
}): Effect.fn.Return<
  FinalizedServices,
  | LandofileValidationError
  | FileSyncSelectionError
  | CapabilityError
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
  const servicePolicies: Record<string, FileSyncPolicy["services"][string]> = {};
  let selectedEngine: SelectedFileSyncPolicy | undefined;
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
    authoredStorage,
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
    const context = {
      appRoot: input.appRoot,
      appSlug: input.appSlug,
      serviceName: name,
      configs: input.configs,
    };
    const preparedMounts = prepareServiceMounts({
      context,
      servicePlan: servicePlanFromDraft(draft, [], input.metadata, extensionsForPlan),
      normalizedConfig: draft.normalizedConfig,
      storage: authoredStorage,
    });
    if (preparedMounts instanceof LandofileValidationError || preparedMounts instanceof ServiceFeatureError)
      return yield* Effect.fail(servicePlanError(input.appRoot, name, preparedMounts));
    const volumeTargets = new Set<string>(
      preparedMounts.mounts.filter((mount) => mount.type === "volume").map((mount) => mount.target),
    );
    const storageOwnership = (draft.storageOwnership ?? []).filter((tree) => volumeTargets.has(tree.target));
    const redirectSteps = redirectLogSourceBuildSteps({ logSources, base: draft.base });
    const shadowResult = yield* deriveMountOverlays({
      context,
      servicePlan: preparedMounts,
      fileSystem: input.fileSystem,
    });
    shadowHostChecks.push(...shadowResult.shadowHostChecks);
    const planWithShadows = shadowResult.servicePlan;
    const appMount = serviceAppMount(planWithShadows);
    const engine =
      appMount !== undefined &&
      input.providerCapabilities.bindMountPerformance === "slow" &&
      draft.normalizedConfig.appMount !== false &&
      draft.normalizedConfig.appMount?.accelerate !== false
        ? yield* input.selectFileSyncEngine
        : undefined;
    const accelerate = engine !== undefined;
    if (engine !== undefined) {
      selectedEngine = engine;
    }
    servicePolicies[name] = serviceFileSyncPolicy({
      mounted: appMount !== undefined,
      optedOut:
        draft.normalizedConfig.appMount !== false && draft.normalizedConfig.appMount?.accelerate === false,
      selected: engine,
      ordinaryReason: input.ordinaryFileSyncReason,
    });
    let gitDirectories: GitHostCheck["directories"] = null;
    if (!accelerate && appMount !== undefined) {
      const gitPath = `${appMount.source}/.git`;
      gitDirectories = yield* readGitDirectories(gitPath, appMount.target, input.fileSystem);
      gitHostChecks.push({ path: gitPath, target: appMount.target, directories: gitDirectories });
    }
    const homePlan = applyServiceHome({
      servicePlan: {
        ...planWithShadows,
        mounts: [...planWithShadows.mounts, ...worktreeGitMounts(planWithShadows, gitDirectories)],
      },
      serviceName: name,
      appSlug: input.appSlug,
      appRoot: input.appRoot,
      intent: homeIntent,
    });
    if (homePlan instanceof LandofileValidationError) return yield* Effect.fail(homePlan);
    // Data-tree ownership resolves here, where the composed `draft.user` and
    // the service type's image identity are both final. The step it produces
    // prepares the tree during the image build, so the planned user owns the
    // named volume the runtime seeds from that path.
    const ownedTrees = resolveDataTreeOwnership({
      serviceName: name,
      serviceType: homeIntent.serviceType,
      identity: homeIntent.identity,
      hasCustomImage: homeIntent.customImage === true,
      trees: storageOwnership,
      plannedUser: draft.user,
    });
    if (ownedTrees instanceof DataTreeOwnershipCapabilityError) {
      return yield* Effect.fail(ownedTrees);
    }
    const ownershipTrees = [...ownedTrees];
    const home = homePlan.home;
    if (
      home?.state === "persisted" &&
      home.user !== undefined &&
      !homeIntent.customImage &&
      homeIntent.identity?.preparedHomes?.includes(home.user)
    ) {
      const preparedHome = resolveDataTreeOwnership({
        serviceName: name,
        serviceType: homeIntent.serviceType,
        identity: homeIntent.identity,
        hasCustomImage: false,
        trees: [{ target: home.target, seededOwners: [] }],
        plannedUser: home.user,
      });
      if (preparedHome instanceof DataTreeOwnershipCapabilityError) return yield* Effect.fail(preparedHome);
      ownershipTrees.push(...preparedHome);
    }
    const ownershipStep = dataTreeOwnershipStep(ownershipTrees);
    const draftForPlan = {
      ...draft,
      storageOwnership,
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
      {
        ...servicePlanFromDraft({ ...draftForPlan, endpoints }, [], input.metadata, extensionsForPlan),
        mounts: homePlan.mounts,
        home: homePlan.home,
      },
      input.providerCapabilities.hostReachability,
    );
    const servicePlan = {
      ...planned,
      environment: sortRecord(planned.environment),
      ...(logSources.length === 0 ? {} : { logSources }),
    };

    const withArtifact =
      authoredArtifact === undefined ? servicePlan : { ...servicePlan, artifact: authoredArtifact };
    for (const error of serviceResourceCapabilityErrors(input.provider, input.providerCapabilities, {
      name,
      artifactBuild: withArtifact.artifact?.kind === "build" || ownershipStep !== undefined,
    }))
      yield* Effect.fail(error);

    for (const error of serviceResourceCapabilityErrors(input.provider, input.providerCapabilities, {
      name,
      bindMounts: withArtifact.mounts.some((mount) => mount.type === "bind"),
      persistentStorage: withArtifact.mounts.some((mount) => mount.type === "volume"),
    }))
      yield* Effect.fail(error);
    const servicePlanWithHome = realizeServiceMounts(withArtifact, input.providerCapabilities, accelerate);

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
    for (const mount of servicePlanWithRoutes.mounts) {
      if (mount.type !== "volume") continue;
      const authoredInfo = authored.byStore.get(mount.store);
      pushStore(
        mount.store,
        authoredInfo?.scope ?? "service",
        authoredInfo?.kind ?? "data",
        authoredInfo?.key,
      );
    }
    if (engine !== undefined) {
      fileSync.push(
        ...collectFileSyncEntries({
          appId: input.appId,
          appRoot: input.appRoot,
          appName: input.appName,
          serviceName: name,
          servicePlan: servicePlanWithRoutes,
          engineId: engine.id,
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
    fileSyncPolicy: recordFileSyncPolicy({
      selected: selectedEngine,
      services: servicePolicies,
      ordinaryReason: input.ordinaryFileSyncReason,
    }),
    routes: prioritizeRoutes(routeAccumulator.routes),
  };
});
