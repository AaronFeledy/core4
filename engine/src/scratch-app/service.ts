import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { migrateAppliedPlan } from "@lando/container-runtime/applied-state";
import type { UserAppResolution } from "@lando/landofile/app-resolution";
import { OperationDiscovery, discoveryCwd, withDiscoveryCwd } from "@lando/landofile/operation-discovery";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import { projectSelectedLandofileRootName } from "@lando/landofile/service";
import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
import {
  AppPlacementError,
  type DebuggerHostUnavailableError,
  type LandofileVersionConstraintError,
  type RouteUrlBindingError,
  ScratchAppError,
  type ScratchAppNotFoundError,
  type ScratchIsolationConflictError,
  ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  AppPlan as AppPlanSchema,
  type IsolateMode,
  type LandofileShape,
  type NetworkingPlan,
  type ProviderCapabilities,
  type RouterConfig,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  DataMover,
  EnvironmentValueResolver,
  EventService,
  FileSystem,
  GlobalAppService,
  ManagedFileTransactionGuard,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  type ScratchAcquireInput,
  ScratchAppService,
  type ScratchDestroyOptions,
  type ScratchHandle,
  type ScratchInfo,
  type ScratchLifetimeStatus,
  type ScratchMountPoint,
  type ScratchNetworkMembership,
  type ScratchServiceEndpoints,
  type ScratchSource,
  type ScratchSummary,
  StateStore,
} from "@lando/sdk/services";
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema, type Scope } from "effect";
import { routerEnabled } from "../config/router-config.ts";
import { globalCreateProviderId } from "../global-app/placement.ts";
import { loadUserLandofileFile, makeEngineUserAppResolution } from "../landofile/app-resolution.ts";
import { routeOwnerFromPlan } from "../lifecycle/route-owner.ts";
import { routeUrlRouterError } from "../lifecycle/route-url-bindings.ts";
import { prepareServiceCertificates } from "../lifecycle/service-certificates.ts";
import { routeAddress } from "../operations/connection-url.ts";
import {
  type GlobalConsumerAdmissionServices,
  requireSelectableRouter,
} from "../operations/global-consumer-admission.ts";
import { publishStartWarnings } from "../operations/start-warnings.ts";
import { resolveAppIdentity } from "../planner/app-identity.ts";
import { validateAppPlan } from "../planner/plan-decode.ts";
import { PluginContributionGraph } from "../plugins/contribution-graph.ts";
import { ensureAppPlacementState, requireOwningEngine } from "../providers/app-placement.ts";
import { prepareProvider } from "../providers/prepared.ts";
import { RuntimeCwd } from "../runtime/cwd.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { scopedLandofileRuntimeInputs } from "../services/landofile-live.ts";
import { prepareDebuggerOverlay } from "../subsystems/start-overlay-registry.ts";
import { withScratchAcquisition } from "./acquisition.ts";
import { makeScratchReaper } from "./destroy.ts";
import { copyScratchFork } from "./fork-copy.ts";
import { scratchIsolationConflict } from "./fork-source.ts";
import { makeScratchGc } from "./gc.ts";
import { ownerPidIsDead } from "./gc-candidates.ts";
import { applyScratchHostnames } from "./hostnames.ts";
import {
  SCRATCH_EXTENSION_KEY,
  decodeScratchExtension,
  isCanonicalScratchId,
  isUnsafeScratchId,
  scratchPathsFor,
  stampScratchExtension,
} from "./identity.ts";
import {
  assertScratchForkLandofile,
  compileScratchForkRoot,
  decodeScratchLandofile,
  selectCopiedScratchRoot,
  selectScratchForkSource,
} from "./landofile.ts";
import { makeScratchLifecycleLock } from "./lifecycle-lock.ts";
import { applyMountCwd, isolateScratchMounts } from "./mount-isolation.ts";
import { openScratchPlan } from "./plan.ts";
import { resolveScratchReference, sanitizeScratchBase, scratchAppNotFoundError } from "./reference.ts";
import { ScratchRegistry, type ScratchRegistryEntry, makeScratchRegistry } from "./registry.ts";
import { applyScratchStartup } from "./startup.ts";

export { isUnsafeScratchId, scratchProjectRoot } from "./identity.ts";
export { applyMountCwd, findPrimaryServiceName } from "./mount-isolation.ts";

export interface ScratchInitAppInput {
  readonly cwd: string;
  readonly destination: string;
  readonly full: boolean;
  readonly recipe: string;
  readonly name: string;
  readonly runPostInit: boolean;
  readonly answers?: Readonly<Record<string, string>>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
}

export interface ScratchInitAppPortShape {
  readonly initApp: (input: ScratchInitAppInput) => Promise<unknown>;
}

export class ScratchInitAppPort extends Context.Service<ScratchInitAppPort, ScratchInitAppPortShape>()(
  "@lando/engine/ScratchInitAppPort",
) {}

const RECIPE_RESOLUTION_ERROR_TAGS = new Set([
  "RecipeManifestNotFoundError",
  "RecipeManifestParseError",
  "RecipeManifestValidationError",
  "NotImplementedError",
]);

const RECIPE_PROMPT_ERROR_TAGS = new Set([
  "RecipeMissingAnswerError",
  "RecipePromptValidationError",
  "InteractionRequiredError",
  "PromptValidationError",
]);

export { ScratchAppService } from "@lando/sdk/services";

export const SCRATCH_DIR = "scratch";

const retainedScratchIds = new Set<string>();

const scratchRemediationFor = (operation: string): string => {
  switch (operation) {
    case "plan":
    case "planCache":
      return "Correct the scratch source Landofile, then retry `lando apps:scratch:start`.";
    case "materialize":
      return "Fix recipe answers and the source Landofile, then retry scratch acquisition.";
    case "start":
    case "acquire":
      return "Run `lando doctor`, fix the reported provider or plan failure, then retry scratch start.";
    case "ensureRoot":
    case "paths":
      return "Fix permissions on the Lando scratch directory under the user data root, then retry.";
    case "gc":
      return "Fix permissions under the scratch directory, then retry `lando apps:scratch:gc`.";
    case "run":
      return "Pass a valid scratch id and tool command after `--`, e.g. `lando run -- composer install`.";
    case "destroy":
    case "cleanup":
      return "Repair the failed provider or filesystem operation, then retry scratch destroy.";
    default:
      return `Resolve the scratch "${operation}" failure, then retry the scratch command.`;
  }
};

const scratchAppError = (
  operation: string,
  message: string,
  cause: unknown,
  remediation?: string,
): ScratchAppError =>
  new ScratchAppError({
    message,
    operation,
    cause,
    remediation: remediation ?? causeRemediation(cause) ?? scratchRemediationFor(operation),
  });

export const decodeScratchPlan = (raw: unknown): AppPlan => {
  if (
    Predicate.isObject(raw) &&
    Predicate.isObject(raw.services) &&
    Object.values(raw.services).some(
      (service) => Predicate.isObject(service) && ("appMount" in service || "storage" in service),
    )
  ) {
    const migrated = migrateAppliedPlan(raw, 1);
    if (migrated === null)
      throw scratchAppError(
        "planCache",
        "Unable to migrate the saved scratch plan's mount layout.",
        undefined,
        "Recover the saved scratch plan before retrying teardown.",
      );
    return migrated;
  }
  return Schema.decodeUnknownSync(AppPlanSchema)(raw);
};

const scratchSourceLabel = (input: ScratchAcquireInput): string => {
  if (input.source === undefined) return "unresolved";
  if (input.source.kind === "fork") return "fork";
  return `recipe:${input.source.ref}`;
};

const scratchSourceRemediation = (input: ScratchAcquireInput): string =>
  input.source?.kind === "recipe"
    ? "Verify the recipe reference and try again, e.g. `lando apps:scratch:start --from empty`."
    : "Scratch source resolution is not available in this build yet, so no scratch app was created.";

const scratchSourceUnresolvedError = (input: ScratchAcquireInput): ScratchSourceUnresolvedError =>
  new ScratchSourceUnresolvedError({
    message: `Unable to resolve scratch source ${scratchSourceLabel(input)}.`,
    source: scratchSourceLabel(input),
    attempts: [],
    remediation: scratchSourceRemediation(input),
  });

export const resolveScratchAcquireIsolation = (input: ScratchAcquireInput): IsolateMode => {
  if (input.isolate === "none") return "cwd";
  return (
    input.isolate ?? (input.mountCwd !== undefined ? "cwd" : input.source.kind === "fork" ? "full" : "baked")
  );
};

const causeRecord = (cause: unknown): Record<string, unknown> | undefined =>
  typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : undefined;

const causeTag = (cause: unknown): string | undefined => {
  const record = causeRecord(cause);
  return record !== undefined && "_tag" in record ? String(record._tag) : undefined;
};

const promptInitError = (input: ScratchAcquireInput, cause: unknown): ScratchAppError => {
  const record = causeRecord(cause);
  const promptName = typeof record?.promptName === "string" ? record.promptName : undefined;
  const causeMessage = typeof record?.message === "string" ? record.message : "Recipe prompt failed.";
  const promptLabel = promptName === undefined ? "recipe prompt" : `recipe prompt "${promptName}"`;
  const remediation =
    promptName === undefined
      ? "Provide required recipe prompt values with --answer key=value or --option key=value."
      : `Provide it with --answer ${promptName}=<value> or --option ${promptName}=<value>.`;
  return scratchAppError(
    "materialize",
    `Unable to answer ${promptLabel} for scratch source ${scratchSourceLabel(input)}: ${causeMessage}`,
    cause,
    remediation,
  );
};

const mapInitError = (
  input: ScratchAcquireInput,
  cause: unknown,
): ScratchSourceUnresolvedError | ScratchAppError => {
  const tag = causeTag(cause);
  if (tag !== undefined && RECIPE_RESOLUTION_ERROR_TAGS.has(tag)) {
    return scratchSourceUnresolvedError(input);
  }
  if (tag !== undefined && RECIPE_PROMPT_ERROR_TAGS.has(tag)) {
    return promptInitError(input, cause);
  }
  return scratchAppError("materialize", "Unable to render the recipe into the scratch app root.", cause);
};

const applyShareGlobalStorage = (plan: AppPlan): AppPlan => {
  const built = landoNetworkingPlan({
    slug: plan.slug,
    identity: plan.identity,
    serviceNames: Object.keys(plan.services),
    sharedCrossAppNetwork: true,
  });
  const sharedNetworkMembership = plan.networking?.sharedNetworkMembership ?? built.sharedNetworkMembership;
  const networking: NetworkingPlan = {
    ...plan.networking,
    perAppBridge: plan.networking?.perAppBridge ?? built.perAppBridge,
    ...(sharedNetworkMembership === undefined ? {} : { sharedNetworkMembership }),
  };
  return {
    ...plan,
    networking,
    extensions: {
      ...plan.extensions,
      [SCRATCH_EXTENSION_KEY]: { ...decodeScratchExtension(plan), shareGlobalStorage: true },
    },
  };
};

const applyScratchStartFlags = Effect.fnUntraced(function* (
  plan: AppPlan,
  input: ScratchAcquireInput,
  capabilities: ProviderCapabilities,
  hostCwd: string,
  sourceRoot: AbsolutePath,
): Effect.fn.Return<AppPlan, ScratchAppError, EventService> {
  // The planner resolved mount sources against the canonical project root; compare against the same path.
  const { appRoot: projectRoot } = yield* resolveAppIdentity(sourceRoot).pipe(
    mapFailures((cause) => scratchAppError("plan", cause.message, cause, cause.remediation)),
  );
  let next = plan;
  const isolation = resolveScratchAcquireIsolation(input);
  const mountCwd = isolation === "cwd" ? (input.mountCwd ?? {}) : input.mountCwd;
  if (mountCwd !== undefined) {
    const mounted = applyMountCwd(next, mountCwd.target, hostCwd, projectRoot);
    if (mounted === undefined) {
      return yield* Effect.fail(
        scratchAppError(
          "start",
          "Unable to mount the current working directory: the scratch app has no primary service.",
          undefined,
          "Use a recipe or app that declares a primary service before passing --mount-cwd.",
        ),
      );
    }
    next = mounted;
  } else {
    next = yield* isolateScratchMounts(
      next,
      input.source.kind === "fork" && isolation === "baked",
      projectRoot,
    ).pipe(
      mapFailures((cause) =>
        cause instanceof ScratchAppError
          ? cause
          : scratchAppError("acquire", "Unable to publish scratch mount isolation warnings.", cause),
      ),
    );
  }
  if (input.shareGlobalStorage === true) {
    if (!capabilities.sharedCrossAppNetwork) {
      return yield* Effect.fail(
        scratchAppError(
          "start",
          "The active provider does not support shared cross-app networking, so --share-global-storage cannot be honored.",
          undefined,
          "Switch to a provider that supports shared cross-app networking, or omit --share-global-storage.",
        ),
      );
    }
    next = applyShareGlobalStorage(next);
  }
  const routed = yield* applyScratchHostnames(next, input);
  const final = stampScratchExtension(routed, { id: plan.id, projectRoot });
  yield* validateAppPlan(final.root, final).pipe(
    mapFailures((cause) => scratchAppError("plan", cause.message, cause)),
  );
  return final;
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const makeRegistryEntry = Effect.fnUntraced(function* (input: {
  readonly id: string;
  readonly source: ScratchSource;
  readonly isolate: ScratchRegistryEntry["isolate"];
  readonly detached: boolean;
  readonly rootPath: string;
  readonly status: ScratchRegistryEntry["status"];
  readonly createdAt?: string;
  readonly shareGlobalStorage?: boolean;
}): Effect.fn.Return<ScratchRegistryEntry> {
  const timestamp = yield* nowIso;
  return {
    id: input.id,
    source: input.source,
    isolate: input.isolate,
    detached: input.detached,
    shareGlobalStorage: input.shareGlobalStorage ?? false,
    ...(input.detached ? {} : { ownerPid: process.pid }),
    rootPath: input.rootPath,
    layout: "managed",
    status: input.status,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
});

const lifetimeStatus = (entry: ScratchRegistryEntry): ScratchLifetimeStatus => {
  if (entry.detached) return "detached";
  return ownerPidIsDead(entry) ? "orphan" : "attached";
};

const summaryFromEntry = (entry: ScratchRegistryEntry): ScratchSummary => ({
  id: entry.id,
  app: { kind: "scratch", id: entry.id, root: AbsolutePath.make(entry.rootPath) },
  source: entry.source,
  mode: entry.isolate,
  created: entry.createdAt,
  status: lifetimeStatus(entry),
});

const planMountPoints = (plan: AppPlan): ReadonlyArray<ScratchMountPoint> => {
  const points: ScratchMountPoint[] = [];
  for (const [name, service] of Object.entries(plan.services)) {
    if (service === undefined) continue;
    for (const mount of service.mounts) {
      points.push({
        service: name,
        target: String(mount.target),
        ...(mount.type === "bind"
          ? { source: mount.source }
          : mount.type === "volume"
            ? { source: mount.store }
            : {}),
        kind: mount.type === "bind" && mount.role === "app" ? "app" : mount.type,
        readOnly: mount.readOnly,
      });
    }
  }
  return points;
};

const planNetworkMembership = (plan: AppPlan): ScratchNetworkMembership => ({
  ...(plan.networking?.perAppBridge?.name === undefined
    ? {}
    : { perAppBridge: plan.networking.perAppBridge.name }),
  ...(plan.networking?.sharedNetworkMembership?.name === undefined
    ? {}
    : { sharedNetwork: plan.networking.sharedNetworkMembership.name }),
});

const planServiceEndpoints = (plan: AppPlan): ReadonlyArray<ScratchServiceEndpoints> =>
  Object.entries(plan.services)
    .filter(([, service]) => service !== undefined)
    .map(([name, service]) => ({
      service: name,
      endpoints: (service?.endpoints ?? []).map((endpoint) => ({
        protocol: endpoint.protocol,
        ...(endpoint.protocol === "unix" ? {} : { port: endpoint.port }),
        ...(endpoint.name === undefined ? {} : { name: endpoint.name }),
      })),
    }));

const scratchPlanDetail = (
  plan: AppPlan | undefined,
): Pick<ScratchInfo, "mounts" | "network" | "endpoints"> =>
  plan === undefined
    ? { mounts: [], network: {}, endpoints: [] }
    : {
        mounts: planMountPoints(plan),
        network: planNetworkMembership(plan),
        endpoints: planServiceEndpoints(plan),
      };

const makeScratchAppService = Effect.fnUntraced(function* (
  resolution: Pick<UserAppResolution, "loadUserLandofileFile"> & {
    readonly inputs: Effect.Effect<LandofileRuntimeInputs>;
  },
) {
  const fileSystem = yield* FileSystem;
  const configuredPaths = yield* PathsService;
  const stateStore = yield* StateStore;
  const transactionGuard = yield* Effect.serviceOption(ManagedFileTransactionGuard);
  const events = yield* EventService;
  const environmentResolver = yield* EnvironmentValueResolver;
  const planner = yield* AppPlanner;
  const providerRegistry = yield* RuntimeProviderRegistry;
  const scratchRegistry = yield* ScratchRegistry;
  const dataMover = yield* DataMover;
  const buildOrchestrator = yield* Effect.serviceOption(BuildOrchestrator);
  const pluginGraph = Option.getOrUndefined(yield* Effect.serviceOption(PluginContributionGraph));
  const initAppPort = yield* ScratchInitAppPort;
  const reapScratch = yield* makeScratchReaper;
  const router = yield* RouterService;
  const withLifecycleLock = yield* makeScratchLifecycleLock;
  const startupOwnership = {
    registry: scratchRegistry,
    fileSystem,
    events,
    reap: reapScratch,
    retainedIds: retainedScratchIds,
    withLock: withLifecycleLock,
  };
  const globalApp = yield* Effect.serviceOption(GlobalAppService);
  const context = yield* Effect.context<never>();
  const admissionContext = Context.makeUnsafe<GlobalConsumerAdmissionServices>(context.mapUnsafe);
  const preflightGlobalPlacement: Effect.Effect<void, AppPlacementError | ScratchAppError> =
    globalApp._tag === "None"
      ? Effect.void
      : globalCreateProviderId().pipe(
          Effect.provideService(GlobalAppService, globalApp.value),
          Effect.provideService(RuntimeProviderRegistry, providerRegistry),
          Effect.provide(context),
          Effect.asVoid,
          mapFailures((cause) =>
            cause instanceof AppPlacementError
              ? cause
              : scratchAppError("start", "Unable to resolve global app placement.", cause),
          ),
        );
  const root = Effect.succeed(AbsolutePath.make(configuredPaths.scratchDir));

  const ensureRoot = root.pipe(
    Effect.flatMap((path) =>
      fileSystem.mkdir(path).pipe(
        Effect.as(path),
        mapFailures((cause) =>
          scratchAppError("ensureRoot", `Unable to create the scratch app directory at ${path}.`, cause),
        ),
      ),
    ),
  );

  const synthesizeId = (base: string) =>
    Effect.sync(() => {
      const suffix = sha256Hex(`${base}:${process.pid}:${randomBytes(8).toString("hex")}`).slice(0, 6);
      return `scratch-${sanitizeScratchBase(base)}-${suffix}`;
    });

  const paths = (id: string) =>
    isUnsafeScratchId(id) || !isCanonicalScratchId(id)
      ? Effect.fail(
          scratchAppError("paths", `Refusing to resolve scratch paths for unsafe id "${id}".`, undefined),
        )
      : root.pipe(
          Effect.map((base) => ({
            base,
            ...scratchPathsFor(base, id),
          })),
        );

  const materializeDir = (path: AbsolutePath) =>
    fileSystem
      .mkdir(path)
      .pipe(
        mapFailures((cause) =>
          scratchAppError("materialize", `Unable to create the scratch app directory at ${path}.`, cause),
        ),
      );

  const writeCachedPlan = (planCache: AbsolutePath, plan: AppPlan) =>
    openScratchPlan(planCache).pipe(
      Effect.provideService(StateStore, stateStore),
      Effect.flatMap((bucket) => bucket.set(plan)),
      mapFailures((cause) =>
        scratchAppError("planCache", `Unable to write scratch plan cache at ${planCache}.`, cause),
      ),
    );

  const readCachedPlan = (planCache: AbsolutePath): Effect.Effect<AppPlan | undefined, never> =>
    openScratchPlan(planCache).pipe(
      Effect.provideService(StateStore, stateStore),
      Effect.flatMap((bucket) => bucket.get),
      Effect.map((plan) => plan ?? undefined),
      Effect.catch(() => Effect.succeed(undefined)),
    );

  const startScratchPlan = Effect.fn("ScratchAppService.startScratchPlan")(function* (
    request: {
      readonly id: string;
      readonly plan: AppPlan;
      readonly planCache: AbsolutePath;
      readonly landofileRouter?: RouterConfig;
    },
    recordPlan: (plan: AppPlan) => void,
  ) {
    const { id: scratchId, plan: markedPlan, planCache, landofileRouter } = request;
    // A routed scratch start without a selectable router refuses before placement, builds, or certificates.
    yield* requireSelectableRouter(markedPlan).pipe(
      Effect.provideService(RouterService, router),
      mapFailures((cause) => scratchAppError("start", cause.message, cause)),
    );
    const routeError = routeUrlRouterError(markedPlan, router);
    if (routeError !== undefined) return yield* routeError;
    yield* publishStartWarnings(markedPlan).pipe(
      Effect.provideService(EventService, events),
      mapFailures((cause) =>
        scratchAppError("start", `Unable to report start warnings for scratch app ${scratchId}.`, cause),
      ),
    );
    const preparedOverlays = yield* prepareDebuggerOverlay(markedPlan);
    const placement = yield* ensureAppPlacementState(
      { kind: "scratch", id: scratchId, root: markedPlan.root },
      markedPlan.provider,
    ).pipe(
      Effect.provideService(RuntimeProviderRegistry, providerRegistry),
      mapFailures((cause) =>
        cause instanceof AppPlacementError
          ? cause
          : scratchAppError("start", `Unable to place scratch app ${scratchId}.`, cause),
      ),
    );
    if (
      (markedPlan.routes.length > 0 && routerEnabled(markedPlan)) ||
      (markedPlan.requires?.globalServices.length ?? 0) > 0
    )
      yield* preflightGlobalPlacement;
    const provider = yield* providerRegistry.select(markedPlan).pipe(
      Effect.tap((selected) => requireOwningEngine(selected, "scratch", [placement.plan])),
      Effect.flatMap(prepareProvider),
      mapFailures((cause) =>
        cause instanceof AppPlacementError
          ? cause
          : scratchAppError("start", `Unable to select a provider for scratch app ${scratchId}.`, cause),
      ),
    );
    yield* writeCachedPlan(planCache, markedPlan);
    // From the first build onward, compensation may need to clean up provider-owned resources.
    recordPlan(markedPlan);
    const builtPlan = yield* Option.match(buildOrchestrator, {
      onNone: () => Effect.succeed(markedPlan),
      onSome: (orchestrator) =>
        withBuildProvider(orchestrator.build(markedPlan), provider).pipe(
          mapFailures((cause) =>
            scratchAppError("start", `Unable to build scratch app ${scratchId}.`, cause),
          ),
        ),
    });
    const { plan: certifiedPlan, certificates } = yield* prepareServiceCertificates(builtPlan).pipe(
      Effect.provide(context),
      mapFailures((cause) =>
        scratchAppError(
          "start",
          `Unable to prepare certificates for scratch app ${scratchId}: ${cause.message}`,
          cause,
        ),
      ),
    );
    const credentialChanges = yield* applyScratchStartup(
      {
        id: scratchId,
        plan: certifiedPlan,
        certificates,
        preparedOverlays,
        ...(landofileRouter === undefined ? {} : { landofileRouter }),
      },
      {
        provider,
        environmentResolver,
        stateStore,
        router,
      },
    ).pipe(Effect.provide(admissionContext), Effect.provideService(RouterService, router));
    return {
      id: scratchId,
      app: { kind: "scratch", id: scratchId, root: markedPlan.root },
      ...(credentialChanges === undefined ? {} : { credentialChanges }),
    } satisfies ScratchHandle;
  });

  const acquireRegistered = <E, R>(
    request: Parameters<typeof withScratchAcquisition>[0],
    prepare: Effect.Effect<Parameters<typeof startScratchPlan>[0], E, R>,
  ) =>
    withScratchAcquisition(request, startupOwnership, (recordPlan) =>
      Effect.gen(function* () {
        yield* materializeDir(request.instanceRoot);
        yield* materializeDir(AbsolutePath.make(request.entry.rootPath));
        const startup = yield* prepare;
        const handle = yield* startScratchPlan(startup, recordPlan);
        yield* scratchRegistry.upsert("mark-running", {
          ...request.entry,
          rootPath: String(startup.plan.root),
          updatedAt: yield* nowIso,
        });
        return handle;
      }),
    );

  const acquireFork = Effect.fn("ScratchAppService.acquireFork")(function* (
    input: ScratchAcquireInput,
    hostCwd: string,
    source: Extract<ScratchAcquireInput["source"], { readonly kind: "fork" }>,
  ) {
    const isolate = resolveScratchAcquireIsolation(input);
    const provided = yield* resolution.inputs;
    const inputs = {
      ...provided,
      stateStore,
      ...(provided.transactionGuard === undefined && Option.isSome(transactionGuard)
        ? { transactionGuard: transactionGuard.value }
        : {}),
    };
    const { selection, admitted } = yield* selectScratchForkSource(
      { source, cwd: hostCwd, graph: pluginGraph },
      { inputs, noLocalOverrides: input.noLocalOverrides, full: isolate === "full" },
    ).pipe(
      Effect.provideService(FileSystem, fileSystem),
      Effect.provideService(PathsService, configuredPaths),
    );
    const atSource = <A, E>(effect: Effect.Effect<A, E>) =>
      admitted === undefined
        ? effect
        : effect.pipe(Effect.provideService(OperationDiscovery, admitted.discovery));
    const sourceConfig =
      isolate === "full" ? undefined : yield* atSource(compileScratchForkRoot(selection, inputs, "defer"));
    const base =
      input.name ??
      (sourceConfig === undefined
        ? yield* atSource(projectSelectedLandofileRootName(selection, inputs)).pipe(
            Effect.orElseSucceed(() => undefined),
          )
        : sourceConfig.document.name) ??
      "app";
    if (admitted !== undefined) yield* admitted.verify;
    const scratchId = yield* synthesizeId(base);
    const scratchPaths = yield* paths(scratchId);
    const registryEntry = yield* makeRegistryEntry({
      id: scratchId,
      source: { kind: "fork" },
      isolate,
      detached: input.detached,
      shareGlobalStorage: input.shareGlobalStorage ?? false,
      rootPath: String(scratchPaths.root),
      status: "acquiring",
    });
    return yield* acquireRegistered(
      {
        entry: registryEntry,
        instanceRoot: scratchPaths.instanceRoot,
        keepOnFailure: input.keepOnFailure === true,
      },
      Effect.gen(function* () {
        const loadFork = Effect.gen(function* () {
          if (sourceConfig !== undefined) return sourceConfig;
          const omitLocalOverrides = input.noLocalOverrides === true;
          yield* copyScratchFork(
            selection,
            { root: scratchPaths.root, excludes: input.excludes ?? [], omitLocalOverrides, admitted },
            dataMover,
          );
          const copied = yield* selectCopiedScratchRoot({
            source: selection,
            appRoot: scratchPaths.root,
            inputs,
            omitLocalOverrides,
          });
          return yield* compileScratchForkRoot(copied, inputs, "publish");
        });
        const landofile = yield* loadFork;
        yield* assertScratchForkLandofile(landofile);
        const forkLandofile = {
          ...landofile,
          document: { ...landofile.document, name: scratchId },
          pendingSites: landofile.pendingSites.filter((site) => site.path[0] !== "name"),
        };
        const capabilities = yield* providerRegistry.capabilities.pipe(
          mapFailures((cause) =>
            scratchAppError("acquire", "Unable to resolve provider capabilities for the scratch app.", cause),
          ),
        );
        const planFork = withDiscoveryCwd(
          forkLandofile.context.appRoot,
          planner.plan(forkLandofile, capabilities, { kind: "scratch" }),
        );
        const forkPlan = yield* planFork.pipe(
          mapFailures((cause) =>
            cause instanceof ScratchAppError
              ? cause
              : scratchAppError("start", `Unable to plan scratch app ${scratchId}.`, cause),
          ),
        );
        if (admitted !== undefined && isolate !== "full") yield* admitted.verify;
        const startPlan = yield* applyScratchStartFlags(
          forkPlan,
          input,
          capabilities,
          hostCwd,
          AbsolutePath.make(String(forkLandofile.context.appRoot)),
        ).pipe(Effect.provideService(EventService, events), Effect.provide(context));
        return {
          id: scratchId,
          plan: startPlan,
          planCache: scratchPaths.planCache,
          ...(landofile.document.router === undefined ? {} : { landofileRouter: landofile.document.router }),
        };
      }),
    );
  });

  const acquireRecipe = Effect.fn("ScratchAppService.acquireRecipe")(function* (
    input: ScratchAcquireInput,
    recipeRef: string,
    hostCwd: string,
  ) {
    const ref = recipeRef.trim();
    if (ref.length === 0) return yield* Effect.fail(scratchSourceUnresolvedError(input));

    const base = input.name ?? ref;
    const scratchId = yield* synthesizeId(base);
    const scratchPaths = yield* paths(scratchId);
    const registryEntry = yield* makeRegistryEntry({
      id: scratchId,
      source: { kind: "recipe", ref: recipeRef },
      isolate: resolveScratchAcquireIsolation(input),
      detached: input.detached,
      shareGlobalStorage: input.shareGlobalStorage ?? false,
      rootPath: String(scratchPaths.root),
      status: "acquiring",
    });
    return yield* acquireRegistered(
      {
        entry: registryEntry,
        instanceRoot: scratchPaths.instanceRoot,
        keepOnFailure: input.keepOnFailure === true,
      },
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () =>
            initAppPort.initApp({
              cwd: scratchPaths.instanceRoot,
              destination: scratchPaths.root,
              full: false,
              recipe: ref,
              name: scratchId,
              runPostInit: input.runPostInit === true,
              ...(input.answers === undefined ? {} : { answers: input.answers }),
              ...(input.yes === undefined ? {} : { yes: input.yes }),
              ...(input.nonInteractive === undefined ? {} : { nonInteractive: input.nonInteractive }),
            }),
          catch: (cause) => mapInitError(input, cause),
        });

        const landofilePath = join(scratchPaths.root, ".lando.yml");
        const landofile = yield* resolution
          .loadUserLandofileFile(landofilePath)
          .pipe(
            mapFailures((cause) =>
              scratchAppError(
                "materialize",
                `Unable to load the rendered scratch Landofile at ${landofilePath}.`,
                cause,
              ),
            ),
          );
        const recipeLandofile = {
          ...landofile,
          document: { ...landofile.document, name: scratchId },
          pendingSites: landofile.pendingSites.filter((site) => site.path[0] !== "name"),
        };

        const capabilities = yield* providerRegistry.capabilities.pipe(
          mapFailures((cause) =>
            scratchAppError("acquire", "Unable to resolve provider capabilities for the scratch app.", cause),
          ),
        );
        const recipePlan = yield* withDiscoveryCwd(
          scratchPaths.root,
          planner.plan(recipeLandofile, capabilities, { kind: "scratch" }),
        ).pipe(
          mapFailures((cause) => scratchAppError("start", `Unable to plan scratch app ${scratchId}.`, cause)),
        );
        const startPlan = yield* applyScratchStartFlags(
          recipePlan,
          input,
          capabilities,
          hostCwd,
          scratchPaths.root,
        ).pipe(Effect.provideService(EventService, events), Effect.provide(context));
        return {
          id: scratchId,
          plan: startPlan,
          planCache: scratchPaths.planCache,
          ...(landofile.document.router === undefined ? {} : { landofileRouter: landofile.document.router }),
        };
      }),
    );
  });

  const acquire = (input: ScratchAcquireInput) => {
    const conflict = scratchIsolationConflict(input);
    if (conflict !== undefined) return Effect.fail(conflict);
    // The runtime's cwd is authoritative; an engine caller without one falls back to discovery.
    return Effect.gen(function* () {
      const runtimeCwd = yield* Effect.serviceOption(RuntimeCwd);
      const hostCwd = Option.isSome(runtimeCwd) ? runtimeCwd.value : yield* discoveryCwd();
      return yield* withDiscoveryCwd(
        hostCwd,
        input.source.kind === "fork"
          ? acquireFork(input, hostCwd, input.source)
          : acquireRecipe(input, input.source.ref, hostCwd),
      );
    });
  };
  const handleFromEntry = (entry: ScratchRegistryEntry): ScratchHandle => ({
    id: entry.id,
    app: { kind: "scratch", id: entry.id, root: AbsolutePath.make(entry.rootPath) },
  });

  const resolveEntry = (reference: string) =>
    scratchRegistry
      .list()
      .pipe(Effect.flatMap((entries) => Effect.fromResult(resolveScratchReference(entries, reference))));

  const resolveById = (reference: string) => resolveEntry(reference).pipe(Effect.map(handleFromEntry));

  const list = (): Effect.Effect<ReadonlyArray<ScratchSummary>, ScratchAppError> =>
    scratchRegistry.list().pipe(Effect.map((entries) => entries.map(summaryFromEntry)));

  const info = Effect.fn("ScratchAppService.info")(function* (
    reference: string,
  ): Effect.fn.Return<ScratchInfo, ScratchAppNotFoundError | ScratchAppError> {
    const entry = yield* resolveEntry(reference);
    const scratchPaths = yield* paths(entry.id);
    const plan =
      (yield* readCachedPlan(scratchPaths.planCache)) ??
      (yield* providerRegistry
        .resolveAppliedPlan(AbsolutePath.make(entry.rootPath), { kind: "scratch", id: entry.id }, "exact")
        .pipe(Effect.catch(() => Effect.succeed(undefined))));
    const info = { ...summaryFromEntry(entry), ...scratchPlanDetail(plan) };
    if (plan === undefined || plan.routes.length === 0 || !routerEnabled(plan)) return info;
    const observation = yield* router.observeRoutes(routeOwnerFromPlan(plan), plan.routes).pipe(
      Effect.map((evidence) => evidence.observation),
      Effect.catchTag("ProxyError", () => Effect.succeed(undefined)),
    );
    // Declared routes always report a list, so an empty one means none are confirmed yet.
    if (observation?.status !== "present") return { ...info, routes: [] };
    return {
      ...info,
      routes: observation.publications.map(({ route, authority }) => ({
        service: route.service,
        ...routeAddress(route, authority.scheme, authority.port),
      })),
    };
  });

  const start = (id: string) => resolveById(id);

  const destroy = Effect.fn("ScratchAppService.destroy")(function* (
    reference: string,
    options: ScratchDestroyOptions = {},
  ) {
    // Poweroff reaps discovered ids exactly, including ones whose registry entry is gone.
    const id = options.reason === "poweroff" ? reference : (yield* resolveEntry(reference)).id;
    if (options.reason !== "poweroff" && (isUnsafeScratchId(id) || !isCanonicalScratchId(id)))
      return yield* Effect.fail(scratchAppNotFoundError(id));
    const scratchPaths = yield* paths(id);
    return yield* withLifecycleLock(
      { id, instanceRoot: scratchPaths.instanceRoot },
      Effect.gen(function* () {
        const entry = yield* scratchRegistry.get(id);
        if (entry === undefined && options.reason !== "poweroff")
          return yield* Effect.fail(scratchAppNotFoundError(id));
        const handle: ScratchHandle =
          entry === undefined
            ? { id, app: { kind: "scratch", id, root: scratchPaths.instanceRoot } }
            : handleFromEntry(entry);
        const cachedPlan = yield* readCachedPlan(scratchPaths.planCache);
        yield* reapScratch({
          id,
          instanceRoot: scratchPaths.instanceRoot,
          reason: options.reason ?? "explicit",
          ...(options.keepVolumes === undefined ? {} : { keepVolumes: options.keepVolumes }),
          ...(cachedPlan === undefined ? {} : { plan: cachedPlan }),
        });
        return handle;
      }),
    );
  });

  const stop = (id: string) => destroy(id);

  const gc = yield* makeScratchGc({
    paths,
    readCachedPlan,
    reap: reapScratch,
    withLock: withLifecycleLock,
    isUnsafeId: isUnsafeScratchId,
  });

  return ScratchAppService.of({
    kind: "scratch",
    root,
    ensureRoot,
    synthesizeId,
    paths,
    acquire,
    resolveById,
    info,
    list,
    start,
    stop,
    destroy,
    gc,
  });
});

const makeScratchAppServiceLayer = (resolution: Parameters<typeof makeScratchAppService>[0]) =>
  Layer.effect(ScratchAppService, makeScratchAppService(resolution));

export const layerWith = (inputs: LandofileRuntimeInputs) =>
  makeScratchAppServiceLayer({ ...makeEngineUserAppResolution(inputs), inputs: Effect.succeed(inputs) });

export const layer = makeScratchAppServiceLayer({
  inputs: scopedLandofileRuntimeInputs,
  loadUserLandofileFile,
});

/**
 * Converts a live foreground scratch app to a detached one
 * (`apps:scratch:run --keep`): the registry entry drops its owner pid and the
 * acquire scope's destroy finalizer observes `detached: true` and skips the
 * teardown, leaving lifecycle ownership to `apps:scratch:*` and gc.
 */
export const detachScratchApp = Effect.fnUntraced(function* (
  id: string,
): Effect.fn.Return<void, ScratchAppNotFoundError | ScratchAppError, StateStore> {
  const registry = makeScratchRegistry(yield* StateStore);
  const entry = yield* registry.get(id);
  if (entry === undefined) return yield* Effect.fail(scratchAppNotFoundError(id));
  const { ownerPid: _ownerPid, ...rest } = entry;
  yield* registry.upsert("detach", { ...rest, updatedAt: yield* nowIso });
  retainedScratchIds.add(id);
});

/**
 * Acquires a scratch app and also returns its planned `AppPlan`. The plan is
 * read from the scratch instance's own plan cache written during acquisition;
 * the public {@link ScratchAppService.acquire} stays plan-free (returns only the
 * handle). Core-private: keeps plan-cache coupling inside the scratch module.
 */
export const acquireScratchAppWithPlan = Effect.fn("ScratchAppService.acquireScratchAppWithPlan")(function* (
  input: ScratchAcquireInput,
): Effect.fn.Return<
  { readonly handle: ScratchHandle; readonly plan: AppPlan },
  | ScratchSourceUnresolvedError
  | RouteUrlBindingError
  | ScratchIsolationConflictError
  | ScratchAppError
  | AppPlacementError
  | DebuggerHostUnavailableError
  | LandofileVersionConstraintError,
  ScratchAppService | StateStore | Scope.Scope
> {
  const service = yield* ScratchAppService;
  const handle = yield* service.acquire(input);
  const scratchPaths = yield* service.paths(handle.id);
  const plan = yield* openScratchPlan(scratchPaths.planCache).pipe(
    Effect.flatMap((bucket) => bucket.get),
    mapFailures((cause) =>
      scratchAppError("acquire", `Unable to read the cached plan for scratch app ${handle.id}.`, cause),
    ),
  );
  if (plan === null)
    return yield* Effect.fail(
      scratchAppError("acquire", `Unable to read the cached plan for scratch app ${handle.id}.`, undefined),
    );
  return { handle, plan };
});

/**
 * Read and decode the rendered Landofile at a scratch instance's root.
 *
 * Exec surfaces (`apps:scratch:run`) use this to honor Landofile-level
 * policy such as the `agentEnv: false` forwarding opt-out; the plan cache
 * intentionally does not carry those fields. Core-private: keeps the
 * rendered-Landofile coupling inside the scratch module.
 */
export const readScratchLandofile = Effect.fnUntraced(function* (
  scratchId: string,
): Effect.fn.Return<LandofileShape, ScratchAppError, ScratchAppService | FileSystem> {
  const service = yield* ScratchAppService;
  const fileSystem = yield* FileSystem;
  const scratchPaths = yield* service.paths(scratchId);
  const landofilePath = join(scratchPaths.root, ".lando.yml");
  const content = yield* fileSystem
    .readText(landofilePath)
    .pipe(
      mapFailures((cause) =>
        scratchAppError("run", `Unable to read the rendered scratch Landofile at ${landofilePath}.`, cause),
      ),
    );
  return (yield* decodeScratchLandofile(landofilePath, content, scratchPaths.root)).document;
});
