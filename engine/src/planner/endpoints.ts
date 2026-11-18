import { PROJECT_USER_MAPPING_EXTENSION_KEY } from "@lando/container-runtime/project-user-realization";
import {
  CapabilityError,
  DataTreeOwnershipCapabilityError,
  type FileSyncSelectionError,
  LandofileValidationError,
  type PublicationUnsupportedError,
  type RouteInputError,
  ServiceFeatureError,
  ServiceTypeError,
} from "@lando/sdk/errors";
import {
  type AppId,
  type FileSyncPlan,
  type FileSyncPolicy,
  type FileSyncPolicyReason,
  type LandofileShape,
  type PluginManifest,
  type ProviderCapabilities,
  type ProviderId,
  type RoutePlan,
  type ServicePlan,
  type StorageScope,
  clonedServiceParent,
  parseContainerDestination,
  routeListenerPreference,
  selectHttpEndpoint,
  serviceAppMount,
  validationIssue,
} from "@lando/sdk/schema";
import type { FileSystem, ServiceTypeHostFacts } from "@lando/sdk/services";
import { type Context, Effect, Predicate } from "effect";

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
import { dataTreeOwnershipStep, projectUserVolumeTrees, resolveDataTreeOwnership } from "./data-tree.ts";
import { resolveRoute } from "./endpoint-routes.ts";
import { LOG_SOURCES_EXTENSION_KEY, servicePlanFromDraft } from "./extensions.ts";
import { collectFileSyncEntries } from "./file-sync.ts";
import { type GitHostCheck, readGitDirectories, worktreeGitMounts } from "./git-host-checks.ts";
import { applyServiceHome } from "./home.ts";
import { deriveMountOverlays, prepareServiceMounts, realizeServiceMounts } from "./mounts.ts";
import { encodeServicePlan } from "./plan-decode.ts";
import {
  type ResolvedProjectUser,
  projectUserRenumberStep,
  projectUserTmpfsMounts,
  resolveProjectUser,
} from "./project-user.ts";
import {
  publicationCapabilityError,
  requiredLogSourceCapabilityError,
  serviceResourceCapabilityErrors,
} from "./resource-capabilities.ts";
import { stampGeneratedBackendTls } from "./route-certificate-defaults.ts";
import { makeRouteAccumulator, prioritizeRoutes } from "./route-identity.ts";
import { resolveServiceArtifact } from "./service-artifact.ts";
import { type AuthoredStorageInfo, type PlannedServiceDraft, servicePlanError } from "./service-types.ts";
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
  readonly manifests: readonly PluginManifest[];
  readonly appId: ReturnType<typeof AppId.make>;
  readonly appRoot: string;
  readonly appSlug: string;
  readonly dataSlug?: string;
  readonly appName: string;
  readonly appKind?: "user" | "global" | "scratch";
  readonly configs?: LandofileShape["configs"];
  readonly defaultDomain: string;
  readonly host?: ServiceTypeHostFacts | undefined;
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
  const projectUsers = new Map<string, ResolvedProjectUser>();
  const storeOwners = new Map<
    string,
    { readonly store: FinalizedServices["stores"][number]; readonly service: string }
  >();

  const pushStore = (
    store: FinalizedServices["stores"][number],
    service: string,
  ): LandofileValidationError | undefined => {
    const previous = storeOwners.get(store.name);
    if (previous !== undefined) {
      if (
        previous.store.scope !== store.scope ||
        previous.store.kind !== store.kind ||
        previous.store.key !== store.key
      ) {
        const message = `Store ${store.name} has conflicting scope, kind, or key definitions in services ${previous.service} and ${service}.`;
        return new LandofileValidationError({
          file: `${input.appRoot}/.lando.yml`,
          message,
          issues: [previous.service, service].map((name) => validationIssue(["services", name], message)),
          remediation:
            "Use the same scope, kind, and key for a shared store, or choose distinct store names.",
        });
      }
      return;
    }
    storeOwners.set(store.name, { store, service });
    stores.push(store);
  };

  for (const entry of input.plannedServiceDrafts) {
    const {
      name,
      hostnames,
      authored,
      authoredStorage,
      draft,
      homeIntent,
      logSources,
      routes: authoredRoutes,
      extensions,
    } = entry;
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
    const storeOwner = entry.storeOwner ?? name;
    const context = {
      appRoot: input.appRoot,
      appSlug: input.dataSlug ?? input.appSlug,
      serviceName: name,
      storeOwner,
      configs: input.configs,
    };
    const preparedMounts = prepareServiceMounts({
      context,
      servicePlan: servicePlanFromDraft(draft, [], input.metadata, extensionsForPlan),
      normalizedConfig: draft.normalizedConfig,
      storage: authoredStorage,
    });
    if (preparedMounts instanceof LandofileValidationError || preparedMounts instanceof ServiceFeatureError)
      return yield* Effect.fail(
        servicePlanError({ appRoot: input.appRoot, serviceName: name, cause: preparedMounts }),
      );
    const volumeTargets = new Set<string>(
      preparedMounts.servicePlan.mounts
        .filter((mount) => mount.type === "volume")
        .map((mount) => mount.target),
    );
    const storageOwnership = (draft.storageOwnership ?? []).filter((tree) => volumeTargets.has(tree.target));
    const redirectSteps = redirectLogSourceBuildSteps({ logSources, base: draft.base });
    const shadowResult = yield* deriveMountOverlays({
      context,
      servicePlan: preparedMounts.servicePlan,
      fileSystem: input.fileSystem,
    });
    shadowHostChecks.push(...shadowResult.shadowHostChecks);
    const planWithShadows = shadowResult.servicePlan;
    const appMount = serviceAppMount(planWithShadows);
    // A clone is a companion of its parent and shares its namespace mapping:
    // the mapping is independent of the clone's own process user and home
    // decision, so reuse the parent's resolution instead of re-deriving one
    // from the clone's overridden `user:`.
    const clonedFrom = clonedServiceParent(draft);
    const projectUserResolution =
      (clonedFrom === undefined ? undefined : projectUsers.get(clonedFrom)) ??
      resolveProjectUser({
        appKind: input.appKind ?? "user",
        serviceName: name,
        serviceTypeLabel: homeIntent.serviceType,
        appRoot: input.appRoot,
        provider: input.provider,
        capabilities: input.providerCapabilities,
        authored: draft.normalizedConfig.projectUser,
        authoredUser: draft.normalizedConfig.user,
        appSourceMounted: appMount !== undefined,
        identity: homeIntent.identity,
        host: input.host,
      });
    if (
      projectUserResolution instanceof LandofileValidationError ||
      projectUserResolution instanceof CapabilityError
    )
      return yield* Effect.fail(projectUserResolution);
    projectUsers.set(name, projectUserResolution);
    const projectUserFields = {
      ...(projectUserResolution.projectUser === undefined
        ? {}
        : { projectUser: projectUserResolution.projectUser }),
      ...(projectUserResolution.explanation === undefined
        ? {}
        : { projectUserExplanation: projectUserResolution.explanation }),
    };
    const planWithProjectUser = {
      ...planWithShadows,
      ...projectUserFields,
      mounts: projectUserTmpfsMounts(planWithShadows.mounts, projectUserResolution.projectUser),
    };
    const renumberedProjectUser =
      projectUserResolution.projectUser !== undefined &&
      input.providerCapabilities.projectUserMapping === "image-renumber";
    const extensionsForService: ServicePlan["extensions"] = {
      ...extensionsForPlan,
      ...(renumberedProjectUser ? { [PROJECT_USER_MAPPING_EXTENSION_KEY]: "image-renumber" } : {}),
    };
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
        ...planWithProjectUser,
        mounts: [...planWithProjectUser.mounts, ...worktreeGitMounts(planWithShadows, gitDirectories)],
      },
      serviceName: name,
      storeOwner,
      appSlug: input.dataSlug ?? input.appSlug,
      appRoot: input.appRoot,
      intent: homeIntent,
      ...(projectUserResolution.projectUser === undefined
        ? {}
        : { projectUser: projectUserResolution.projectUser }),
    });
    if (homePlan instanceof LandofileValidationError) return yield* Effect.fail(homePlan);
    const cacheStores = new Set<string>();
    const storageByTarget = new Map<string, AuthoredStorageInfo>();
    for (const mount of homePlan.mounts) {
      if (mount.type !== "volume") continue;
      const resolvedStorageTarget = (draft.normalizedConfig.storage ?? []).some((entry) => {
        if (typeof entry === "string") return false;
        const destination = parseContainerDestination(entry.target);
        return destination.ok && destination.value === mount.target;
      });
      const storageInfo =
        preparedMounts.storageByTarget.get(mount.target) ??
        (mount.origin !== "derived" && resolvedStorageTarget ? authored.byStore.get(mount.store) : undefined);
      if (storageInfo !== undefined) storageByTarget.set(mount.target, storageInfo);
      if (storageInfo?.kind === "cache") cacheStores.add(mount.store);
    }
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
    const catalogPreparesHome =
      home?.state === "persisted" &&
      home.user !== undefined &&
      !homeIntent.customImage &&
      homeIntent.identity?.preparedHomes?.includes(home.user) === true;
    if (catalogPreparesHome) {
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
    // A clone seeds no data of its own: it shares the parent's stores, and the
    // parent's derived image already prepares their ownership. Only an ordinary
    // service prepares the fresh volume trees its project user writes, including
    // a persisted home the catalog does not prepare (a numeric project user's).
    if (clonedFrom === undefined) {
      ownershipTrees.push(
        ...projectUserVolumeTrees({
          mounts: homePlan.mounts,
          cacheStores,
          ...(projectUserResolution.projectUser === undefined
            ? {}
            : { projectUser: projectUserResolution.projectUser }),
          ...(catalogPreparesHome ? { homeStore: home.store } : {}),
        }),
      );
    }
    const ownershipStep = dataTreeOwnershipStep(ownershipTrees);
    // Renumber before anything gives a tree to the account by name, so a
    // prepared home and every owned data tree resolve to the host ids.
    const renumberStep = projectUserRenumberStep({
      identity: homeIntent.identity,
      mapping: input.providerCapabilities.projectUserMapping,
      projectUser: projectUserResolution.projectUser,
      host: input.host,
    });
    const draftForPlan = {
      ...draft,
      storageOwnership,
      buildSteps: [
        ...(renumberStep === undefined ? [] : [renumberStep]),
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
        ...servicePlanFromDraft({ ...draftForPlan, endpoints }, [], input.metadata, extensionsForService),
        mounts: homePlan.mounts,
        home: homePlan.home,
        ...projectUserFields,
      },
      input.providerCapabilities.hostReachability,
    );
    const servicePlan = {
      ...planned,
      environment: sortRecord(planned.environment),
      ...(logSources.length === 0 ? {} : { logSources }),
    };

    const withArtifact = resolveServiceArtifact(servicePlan, entry, input.manifests);
    if (withArtifact instanceof ServiceTypeError)
      return yield* Effect.fail(
        servicePlanError({ appRoot: input.appRoot, serviceName: name, cause: withArtifact }),
      );
    for (const error of serviceResourceCapabilityErrors(input.provider, input.providerCapabilities, {
      name,
      artifactBuild: withArtifact.artifact?.kind === "build" || ownershipStep !== undefined,
      ...(withArtifact.pullPolicy === undefined ? {} : { pullPolicy: withArtifact.pullPolicy }),
    }))
      yield* Effect.fail(error);

    for (const error of serviceResourceCapabilityErrors(input.provider, input.providerCapabilities, {
      name,
      bindMounts: withArtifact.mounts.some((mount) => mount.type === "bind"),
      persistentStorage: withArtifact.mounts.some((mount) => mount.type === "volume"),
    }))
      yield* Effect.fail(error);
    const servicePlanWithHome = realizeServiceMounts(withArtifact, input.providerCapabilities, accelerate);

    const generatedCertificate = draft.normalizedConfig.certs === true;
    const tls = { certificate: draft.certs, generated: generatedCertificate };
    const routeRefs: Array<ServicePlan["routes"][number]> = [];
    if (authoredRoutes !== undefined) {
      for (const [routeIndex, route] of authoredRoutes.entries()) {
        for (const plan of stampGeneratedBackendTls(
          yield* resolveRoute(
            input.appRoot,
            name,
            servicePlanWithHome.endpoints,
            route,
            generatedCertificate,
          ),
          tls,
        )) {
          routeRefs.push(
            ...(yield* routeAccumulator.add(
              plan,
              route.source ?? { key: `services.${name}.routes[${routeIndex}]` },
            )),
          );
        }
      }
    } else {
      // Discovery uses the same preference the binder will, then records the
      // resolved endpoint on the plan for reporting; it never turns that result
      // into an authored selector before the binder chooses.
      const selection = selectHttpEndpoint(
        servicePlanWithHome.endpoints,
        undefined,
        routeListenerPreference("https", generatedCertificate),
      );
      if (selection.status !== "none") {
        for (const plan of stampGeneratedBackendTls(
          yield* resolveRoute(
            input.appRoot,
            name,
            servicePlanWithHome.endpoints,
            {
              hostname: `${name}.${input.appSlug}.${input.defaultDomain}`,
              scheme: "https",
              filters: [],
            },
            generatedCertificate,
          ),
          tls,
        )) {
          routeRefs.push(
            ...(yield* routeAccumulator.add(
              selection.status === "selected"
                ? { ...plan, endpoint: selection.endpoint.names[0] ?? selection.endpoint.port }
                : plan,
              { key: `services.${name}.endpoints` },
            )),
          );
        }
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
    services[name] = yield* encodeServicePlan(input.appRoot, name, servicePlanWithRoutes);
    for (const mount of servicePlanWithRoutes.mounts) {
      if (mount.type !== "volume") continue;
      const storageInfo = storageByTarget.get(mount.target);
      const error = pushStore(
        {
          name: mount.store,
          scope: storageInfo?.scope ?? "service",
          kind: storageInfo?.kind ?? "data",
          ...(storageInfo?.key === undefined ? {} : { key: storageInfo.key }),
        },
        name,
      );
      if (error !== undefined) return yield* Effect.fail(error);
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
