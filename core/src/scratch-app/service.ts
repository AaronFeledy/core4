import { createHash, randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { Cause, type Context, Effect, Layer, Schema, type Scope } from "effect";

import {
  ScratchAppError,
  ScratchAppNotFoundError,
  ScratchIsolationConflictError,
  ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  AppPlan as AppPlanSchema,
  LandofileShape,
  type NetworkingPlan,
  PortablePath,
  type ProviderCapabilities,
  ServiceName,
  landoNetworkingPlan,
  sameAppMountTarget,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  DataMover,
  FileSystem,
  LandofileService,
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
  type ScratchSummary,
} from "@lando/sdk/services";

import { initApp } from "../cli/commands/init.ts";
import { makeLandoPaths } from "../config/paths.ts";
import { parseLandofile } from "../landofile/parser.ts";
import { decodeOrFail } from "../schema/decode.ts";
import { ScratchRegistry, type ScratchRegistryEntry, makeScratchRegistry } from "./registry.ts";
import { ScratchResourceScanner } from "./scanner.ts";

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

const scratchAppError = (
  operation: string,
  message: string,
  cause: unknown,
  remediation?: string,
): ScratchAppError =>
  new ScratchAppError({ message, operation, cause, ...(remediation === undefined ? {} : { remediation }) });

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

const scratchForkUnresolvedError = (): ScratchSourceUnresolvedError =>
  new ScratchSourceUnresolvedError({
    message: "Unable to resolve scratch source fork.",
    source: "fork",
    attempts: [],
    remediation: "Run `lando apps:scratch:start --fork` from a directory containing a Landofile.",
  });

const withProcessCwd = <A, E, R>(
  dir: string,
  use: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ScratchAppError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const original = process.cwd();
        process.chdir(dir);
        return original;
      },
      catch: (cause) =>
        scratchAppError("plan", `Unable to enter the scratch app directory at ${dir}.`, cause),
    }),
    () => use(),
    (original) => Effect.sync(() => process.chdir(original)),
  );

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

const decodeScratchLandofile = (
  file: string,
  content: string,
  cwd: string,
): Effect.Effect<LandofileShape, ScratchAppError> =>
  parseLandofile({ file, content, cwd }).pipe(
    Effect.mapError((cause) =>
      scratchAppError("materialize", `Unable to parse the rendered scratch Landofile at ${file}.`, cause),
    ),
    Effect.flatMap((parsed) =>
      decodeOrFail(LandofileShape, (cause) =>
        scratchAppError("materialize", `The rendered scratch Landofile at ${file} is invalid.`, cause),
      )(parsed, { onExcessProperty: "error" }),
    ),
  );

const scratchAppNotFoundError = (id: string): ScratchAppNotFoundError =>
  new ScratchAppNotFoundError({
    message: `Scratch app ${id} was not found.`,
    id,
    suggestions: [],
    remediation: "Run `lando apps:scratch:list` to see currently registered scratch apps.",
  });

const sanitizeBase = (base: string): string => {
  const cleaned = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return cleaned.length === 0 ? "scratch" : cleaned;
};

// Security: reject ids that `join` could use to escape `<userCacheRoot>/scratch/<id>/`
// — path separators, NUL, or a pure-dot segment (`.`, `..`).
export const isUnsafeScratchId = (id: string): boolean =>
  id.length === 0 || /[/\\\0]/u.test(id) || /^\.+$/u.test(id);

const SCRATCH_EXTENSION_KEY = "@lando/core/scratch";

const scratchExtension = (plan: AppPlan): Record<string, unknown> => {
  const existing = plan.extensions[SCRATCH_EXTENSION_KEY];
  return typeof existing === "object" && existing !== null ? (existing as Record<string, unknown>) : {};
};

const markScratchPlan = (plan: AppPlan, scratchId: string): AppPlan => ({
  ...plan,
  extensions: {
    ...plan.extensions,
    [SCRATCH_EXTENSION_KEY]: { ...scratchExtension(plan), id: scratchId },
  },
});

export const findPrimaryServiceName = (plan: AppPlan): ServiceName | undefined => {
  const names = Object.keys(plan.services).map((name) => ServiceName.make(name));
  return names.find((name) => plan.services[name]?.primary === true) ?? names[0];
};

const dropAppMountFileSync = (fileSync: AppPlan["fileSync"], serviceName: ServiceName): AppPlan["fileSync"] =>
  fileSync.filter(
    (entry) => !(entry.session.service === serviceName && entry.session.mountKey === "app-mount"),
  );

const applyMountCwd = (plan: AppPlan, target: string | undefined, hostCwd: string): AppPlan | undefined => {
  const primaryName = findPrimaryServiceName(plan);
  if (primaryName === undefined) return undefined;
  const primary = plan.services[primaryName];
  if (primary === undefined) return undefined;
  const source = AbsolutePath.make(hostCwd);
  const appMount = primary.appMount;
  if (appMount !== undefined && (target === undefined || target === appMount.target)) {
    const nextPrimary = {
      ...primary,
      appMount: { ...appMount, source, realization: "passthrough" as const },
      // Drop redundant app-root binds a service type mirrored into `mounts`
      // (e.g. `type: lando`): after the source rewrite they no longer match
      // the appMount, so providers would realize two mounts at one target.
      mounts: primary.mounts.filter((mount) => !sameAppMountTarget(appMount, mount)),
    };
    return {
      ...plan,
      services: { ...plan.services, [primaryName]: nextPrimary },
      fileSync: dropAppMountFileSync(plan.fileSync, primaryName),
    };
  }
  const containerTarget = PortablePath.make(target ?? appMount?.target ?? "/app");
  const nextPrimary = {
    ...primary,
    mounts: [
      ...primary.mounts,
      {
        type: "bind" as const,
        source: String(source),
        target: containerTarget,
        readOnly: false,
        realization: "passthrough" as const,
      },
    ],
  };
  return { ...plan, services: { ...plan.services, [primaryName]: nextPrimary } };
};

const applyShareGlobalStorage = (plan: AppPlan): AppPlan => {
  const built = landoNetworkingPlan({
    slug: plan.slug,
    serviceNames: Object.keys(plan.services),
    sharedCrossAppNetwork: true,
  });
  const networking: NetworkingPlan = {
    perAppBridge: plan.networking?.perAppBridge ?? built.perAppBridge,
    sharedNetworkMembership: plan.networking?.sharedNetworkMembership ?? built.sharedNetworkMembership,
  };
  return {
    ...plan,
    networking,
    extensions: {
      ...plan.extensions,
      [SCRATCH_EXTENSION_KEY]: { ...scratchExtension(plan), shareGlobalStorage: true },
    },
  };
};

const applyScratchStartFlags = (
  plan: AppPlan,
  input: ScratchAcquireInput,
  capabilities: ProviderCapabilities,
  hostCwd: string,
): Effect.Effect<AppPlan, ScratchAppError> =>
  Effect.gen(function* () {
    let next = plan;
    if (input.mountCwd !== undefined) {
      const mounted = applyMountCwd(next, input.mountCwd.target, hostCwd);
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
    return next;
  });

const scratchIsolationConflict = (flags: ReadonlyArray<string>): ScratchIsolationConflictError =>
  new ScratchIsolationConflictError({
    message: `${flags.join(" and ")} cannot be combined.`,
    flags,
    remediation:
      "Pass --mount-cwd on its own to serve your current directory, or drop it to keep --isolate=full.",
  });

const nowIso = (): string => new Date().toISOString();

const makeRegistryEntry = (input: {
  readonly id: string;
  readonly source: ScratchAcquireInput["source"];
  readonly isolate: ScratchRegistryEntry["isolate"];
  readonly detached: boolean;
  readonly rootPath: string;
  readonly status: ScratchRegistryEntry["status"];
  readonly createdAt?: string;
}): ScratchRegistryEntry => {
  const timestamp = nowIso();
  return {
    id: input.id,
    source: input.source,
    isolate: input.isolate,
    detached: input.detached,
    ...(input.detached ? {} : { ownerPid: process.pid }),
    rootPath: input.rootPath,
    status: input.status,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
};

const ownerPidIsDead = (entry: ScratchRegistryEntry): boolean => {
  if (entry.detached || entry.ownerPid === undefined) return false;
  try {
    process.kill(entry.ownerPid, 0);
    return false;
  } catch (cause) {
    return (cause as { readonly code?: unknown }).code === "ESRCH";
  }
};

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
    if (service.appMount !== undefined) {
      points.push({
        service: name,
        target: String(service.appMount.target),
        source: String(service.appMount.source),
        kind: "app",
        readOnly: service.appMount.readOnly,
      });
    }
    for (const mount of service.mounts) {
      points.push({
        service: name,
        target: String(mount.target),
        ...(mount.source === undefined ? {} : { source: mount.source }),
        kind: mount.type,
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
        ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
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

const makeScratchAppService = (
  fileSystem: Context.Tag.Service<typeof FileSystem>,
  landofileService: Context.Tag.Service<typeof LandofileService>,
  planner: Context.Tag.Service<typeof AppPlanner>,
  providerRegistry: Context.Tag.Service<typeof RuntimeProviderRegistry>,
  scratchRegistry: Context.Tag.Service<typeof ScratchRegistry>,
  scanner: Context.Tag.Service<typeof ScratchResourceScanner>,
  dataMover: Context.Tag.Service<typeof DataMover>,
): Context.Tag.Service<typeof ScratchAppService> => {
  const root = Effect.sync(() => AbsolutePath.make(makeLandoPaths().scratchDir));

  const ensureRoot = root.pipe(
    Effect.flatMap((path) =>
      fileSystem.mkdir(path).pipe(
        Effect.as(path),
        Effect.mapError((cause) =>
          scratchAppError("ensureRoot", `Unable to create the scratch app directory at ${path}.`, cause),
        ),
      ),
    ),
  );

  const synthesizeId = (base: string) =>
    Effect.sync(() => {
      const suffix = createHash("sha256")
        .update(`${base}:${Date.now()}:${process.pid}:${randomBytes(8).toString("hex")}`)
        .digest("hex")
        .slice(0, 6);
      return `scratch-${sanitizeBase(base)}-${suffix}`;
    });

  const paths = (id: string) =>
    isUnsafeScratchId(id)
      ? Effect.fail(
          scratchAppError("paths", `Refusing to resolve scratch paths for unsafe id "${id}".`, undefined),
        )
      : root.pipe(
          Effect.map((base) => {
            const instanceRoot = AbsolutePath.make(join(base, id));
            return {
              base,
              instanceRoot,
              root: AbsolutePath.make(join(instanceRoot, "root")),
              planCache: AbsolutePath.make(join(instanceRoot, "plan.bin")),
              infoCache: AbsolutePath.make(join(instanceRoot, "info.json")),
              buildResults: AbsolutePath.make(join(instanceRoot, "build-results.bin")),
            };
          }),
        );

  const materializeDir = (path: AbsolutePath) =>
    fileSystem
      .mkdir(path)
      .pipe(
        Effect.mapError((cause) =>
          scratchAppError("materialize", `Unable to create the scratch app directory at ${path}.`, cause),
        ),
      );

  const cleanupScratchInstance = (path: AbsolutePath) =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (cause) =>
        scratchAppError("cleanup", `Unable to remove the failed scratch app directory at ${path}.`, cause),
    });

  const writeCachedPlan = (planCache: AbsolutePath, plan: AppPlan) =>
    Effect.try({
      try: () => `${JSON.stringify(Schema.encodeSync(AppPlanSchema)(plan))}\n`,
      catch: (cause) =>
        scratchAppError("planCache", `Unable to encode scratch plan cache at ${planCache}.`, cause),
    }).pipe(
      Effect.flatMap((content) => fileSystem.writeAtomic(planCache, content)),
      Effect.mapError((cause) =>
        cause instanceof ScratchAppError
          ? cause
          : scratchAppError("planCache", `Unable to write scratch plan cache at ${planCache}.`, cause),
      ),
    );

  const readCachedPlan = (planCache: AbsolutePath): Effect.Effect<AppPlan | undefined, never> =>
    fileSystem.readText(planCache).pipe(
      Effect.flatMap((content) =>
        Effect.try({
          try: () => Schema.decodeUnknownSync(AppPlanSchema)(JSON.parse(content)),
          catch: () => undefined,
        }),
      ),
      Effect.catchAll(() => Effect.succeed(undefined)),
    );

  const reapScratch = (input: {
    readonly id: string;
    readonly instanceRoot: AbsolutePath;
    readonly keepVolumes?: boolean;
    readonly plan?: AppPlan;
  }): Effect.Effect<void, ScratchAppError> => {
    const pruneProvider =
      input.plan === undefined
        ? scanner.pruneScratch(input.id)
        : providerRegistry.select(input.plan).pipe(
            Effect.mapError((cause) =>
              scratchAppError("destroy", `Unable to select a provider for scratch app ${input.id}.`, cause),
            ),
            Effect.flatMap((provider) => {
              const plan = input.plan;
              if (plan === undefined) return Effect.void;
              return provider.destroy(
                { app: plan.id, plan },
                { volumes: input.keepVolumes !== true, removeState: true },
              );
            }),
            Effect.mapError((cause) =>
              scratchAppError(
                "destroy",
                `Unable to destroy provider resources for scratch app ${input.id}.`,
                cause,
              ),
            ),
          );

    return pruneProvider.pipe(
      Effect.catchAll(() => Effect.void),
      Effect.zipRight(cleanupScratchInstance(input.instanceRoot).pipe(Effect.catchAll(() => Effect.void))),
      Effect.zipRight(scratchRegistry.remove(input.id)),
    );
  };

  const copyAppRoot = (source: string, destination: string) =>
    Effect.scoped(
      dataMover.transfer({
        from: { _tag: "hostPath", path: AbsolutePath.make(source) },
        to: { _tag: "hostPath", path: AbsolutePath.make(destination) },
        overwrite: true,
      }),
    ).pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        cause instanceof ScratchAppError
          ? cause
          : scratchAppError(
              "materialize",
              `Unable to copy the source app root into the scratch app at ${destination}.`,
              cause,
            ),
      ),
    );

  const startScratchPlan = (
    scratchId: string,
    plan: AppPlan,
    instanceRoot: AbsolutePath,
    planCache: AbsolutePath,
    detached: boolean,
  ) =>
    Effect.gen(function* () {
      const markedPlan = markScratchPlan(plan, scratchId);
      const provider = yield* providerRegistry
        .select(markedPlan)
        .pipe(
          Effect.mapError((cause) =>
            scratchAppError("start", `Unable to select a provider for scratch app ${scratchId}.`, cause),
          ),
        );
      // Security: tears down `instanceRoot` (always under `<userCacheRoot>/scratch/<id>/`),
      // never `plan.root` — an `--isolate=none` fork plans against the source cwd, so removing
      // `plan.root` would delete the user's own app.
      const destroyScratchResources = reapScratch({ id: scratchId, instanceRoot, plan: markedPlan }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`Unable to reap scratch app ${scratchId} during cleanup: ${Cause.pretty(cause)}`),
        ),
      );
      yield* writeCachedPlan(planCache, markedPlan);
      yield* Effect.scoped(provider.apply(markedPlan, { reconcile: false })).pipe(
        // A failed start can leave a materialized dir and partial provider state; the scope
        // finalizer only covers a successful start, so reclaim on the failure path too.
        Effect.tapError(() => destroyScratchResources),
        Effect.mapError((cause) =>
          scratchAppError("start", `Unable to start scratch app ${scratchId}.`, cause),
        ),
      );
      if (!detached) {
        // Skip the destroy when the entry was converted to detached mid-scope
        // (`apps:scratch:run --keep`): the registry owns the scratch from there.
        yield* Effect.addFinalizer(() =>
          scratchRegistry.get(scratchId).pipe(
            Effect.catchAll(() => Effect.succeed(undefined)),
            Effect.flatMap((entry) => (entry?.detached === true ? Effect.void : destroyScratchResources)),
          ),
        );
      }
      return {
        id: scratchId,
        app: { kind: "scratch", id: scratchId, root: markedPlan.root },
      } satisfies ScratchHandle;
    });

  const acquireFork = (input: ScratchAcquireInput) =>
    Effect.gen(function* () {
      const hostCwd = yield* Effect.sync(() => process.cwd());
      const landofile = yield* landofileService.discover.pipe(
        Effect.mapError(() => scratchForkUnresolvedError()),
      );
      const capabilities = yield* providerRegistry.capabilities.pipe(
        Effect.mapError((cause) =>
          scratchAppError("acquire", "Unable to resolve provider capabilities for the scratch app.", cause),
        ),
      );
      const sourcePlan = yield* planner
        .plan(landofile, capabilities)
        .pipe(
          Effect.mapError((cause) =>
            scratchAppError("acquire", "Unable to plan the source app for the scratch fork.", cause),
          ),
        );
      const base = input.name ?? landofile.name ?? sourcePlan.name;
      const scratchId = yield* synthesizeId(base);
      const scratchPaths = yield* paths(scratchId);
      const registryEntry = makeRegistryEntry({
        id: scratchId,
        source: input.source,
        isolate: input.isolate ?? (input.source.kind === "fork" ? "full" : "baked"),
        detached: input.detached,
        rootPath: String(scratchPaths.root),
        status: "acquiring",
      });
      yield* scratchRegistry.upsert(registryEntry);

      yield* materializeDir(scratchPaths.instanceRoot).pipe(
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );
      yield* materializeDir(scratchPaths.root).pipe(
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );

      const forkLandofile = { ...landofile, name: scratchId };
      const planForkPlan =
        input.isolate === "full"
          ? copyAppRoot(String(sourcePlan.root), String(scratchPaths.root)).pipe(
              Effect.tapError(() => Effect.ignore(cleanupScratchInstance(scratchPaths.instanceRoot))),
              Effect.zipRight(
                withProcessCwd(scratchPaths.root, () => planner.plan(forkLandofile, capabilities)),
              ),
            )
          : planner.plan(forkLandofile, capabilities);
      const forkPlan = yield* planForkPlan.pipe(
        Effect.mapError((cause) =>
          cause instanceof ScratchAppError
            ? cause
            : scratchAppError("start", `Unable to plan scratch app ${scratchId}.`, cause),
        ),
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );
      const startPlan = yield* applyScratchStartFlags(forkPlan, input, capabilities, hostCwd).pipe(
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );
      return yield* startScratchPlan(
        scratchId,
        startPlan,
        scratchPaths.instanceRoot,
        scratchPaths.planCache,
        input.detached,
      ).pipe(
        Effect.tap(() =>
          scratchRegistry.upsert({
            ...registryEntry,
            rootPath: String(startPlan.root),
            status: "running",
            updatedAt: nowIso(),
          }),
        ),
        Effect.tapError(() =>
          reapScratch({
            id: scratchId,
            instanceRoot: scratchPaths.instanceRoot,
            plan: markScratchPlan(startPlan, scratchId),
          }),
        ),
      );
    });

  const acquireRecipe = (input: ScratchAcquireInput, recipeRef: string) =>
    Effect.gen(function* () {
      const hostCwd = yield* Effect.sync(() => process.cwd());
      const ref = recipeRef.trim();
      if (ref.length === 0) return yield* Effect.fail(scratchSourceUnresolvedError(input));

      const base = input.name ?? ref;
      const scratchId = yield* synthesizeId(base);
      const scratchPaths = yield* paths(scratchId);
      const registryEntry = makeRegistryEntry({
        id: scratchId,
        source: input.source,
        isolate: input.isolate ?? (input.source.kind === "fork" ? "full" : "baked"),
        detached: input.detached,
        rootPath: String(scratchPaths.root),
        status: "acquiring",
      });
      yield* scratchRegistry.upsert(registryEntry);

      yield* materializeDir(scratchPaths.instanceRoot).pipe(
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );
      yield* materializeDir(scratchPaths.root).pipe(
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );

      yield* Effect.tryPromise({
        try: () =>
          initApp({
            cwd: scratchPaths.instanceRoot,
            destination: scratchPaths.root,
            full: false,
            recipe: ref,
            name: scratchId,
            runPostInit: false,
            ...(input.answers === undefined ? {} : { answers: input.answers }),
            ...(input.yes === undefined ? {} : { yes: input.yes }),
            ...(input.nonInteractive === undefined ? {} : { nonInteractive: input.nonInteractive }),
          }),
        catch: (cause) => mapInitError(input, cause),
      }).pipe(Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })));

      const landofilePath = join(scratchPaths.root, ".lando.yml");
      const content = yield* fileSystem.readText(landofilePath).pipe(
        Effect.mapError((cause) =>
          scratchAppError(
            "materialize",
            `Unable to read the rendered scratch Landofile at ${landofilePath}.`,
            cause,
          ),
        ),
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );
      const landofile = yield* decodeScratchLandofile(landofilePath, content, scratchPaths.root).pipe(
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );
      const recipeLandofile = { ...landofile, name: scratchId };

      const capabilities = yield* providerRegistry.capabilities.pipe(
        Effect.mapError((cause) =>
          scratchAppError("acquire", "Unable to resolve provider capabilities for the scratch app.", cause),
        ),
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );
      const recipePlan = yield* withProcessCwd(scratchPaths.root, () =>
        planner.plan(recipeLandofile, capabilities),
      ).pipe(
        Effect.mapError((cause) =>
          scratchAppError("start", `Unable to plan scratch app ${scratchId}.`, cause),
        ),
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );
      const startPlan = yield* applyScratchStartFlags(recipePlan, input, capabilities, hostCwd).pipe(
        Effect.tapError(() => reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      );
      return yield* startScratchPlan(
        scratchId,
        startPlan,
        scratchPaths.instanceRoot,
        scratchPaths.planCache,
        input.detached,
      ).pipe(
        Effect.tap(() =>
          scratchRegistry.upsert({
            ...registryEntry,
            rootPath: String(startPlan.root),
            status: "running",
            updatedAt: nowIso(),
          }),
        ),
        Effect.tapError(() =>
          reapScratch({
            id: scratchId,
            instanceRoot: scratchPaths.instanceRoot,
            plan: markScratchPlan(startPlan, scratchId),
          }),
        ),
      );
    });

  const acquire = (input: ScratchAcquireInput) => {
    if (input.mountCwd !== undefined && input.isolate === "full") {
      return Effect.fail(scratchIsolationConflict(["--mount-cwd", "--isolate=full"]));
    }
    return input.source.kind === "fork" ? acquireFork(input) : acquireRecipe(input, input.source.ref);
  };
  const handleFromEntry = (entry: ScratchRegistryEntry): ScratchHandle => ({
    id: entry.id,
    app: { kind: "scratch", id: entry.id, root: AbsolutePath.make(entry.rootPath) },
  });

  const resolveById = (id: string) =>
    scratchRegistry
      .get(id)
      .pipe(
        Effect.flatMap((entry) =>
          entry === undefined
            ? Effect.fail(scratchAppNotFoundError(id))
            : Effect.succeed(handleFromEntry(entry)),
        ),
      );

  const list = (): Effect.Effect<ReadonlyArray<ScratchSummary>, ScratchAppError> =>
    scratchRegistry.list().pipe(Effect.map((entries) => entries.map(summaryFromEntry)));

  const info = (id: string): Effect.Effect<ScratchInfo, ScratchAppNotFoundError | ScratchAppError> =>
    Effect.gen(function* () {
      const entry = yield* scratchRegistry.get(id);
      if (entry === undefined) return yield* Effect.fail(scratchAppNotFoundError(id));
      const scratchPaths = yield* paths(id);
      const cachedPlan = yield* readCachedPlan(scratchPaths.planCache);
      return { ...summaryFromEntry(entry), ...scratchPlanDetail(cachedPlan) };
    });

  const start = (id: string) => resolveById(id);

  const destroy = (id: string, options: ScratchDestroyOptions = {}) =>
    Effect.gen(function* () {
      const entry = yield* scratchRegistry.get(id);
      if (entry === undefined) return yield* Effect.fail(scratchAppNotFoundError(id));
      const scratchPaths = yield* paths(id);
      const handle = handleFromEntry(entry);
      const cachedPlan = yield* readCachedPlan(scratchPaths.planCache);
      yield* scratchRegistry.upsert({ ...entry, status: "stopping", updatedAt: nowIso() }).pipe(
        Effect.zipRight(
          reapScratch({
            id,
            instanceRoot: scratchPaths.instanceRoot,
            ...(options.keepVolumes === undefined ? {} : { keepVolumes: options.keepVolumes }),
            ...(cachedPlan === undefined ? {} : { plan: cachedPlan }),
          }),
        ),
      );
      return handle;
    });

  const stop = (id: string) => destroy(id);

  const diskScratchIds = root.pipe(
    Effect.flatMap((base) =>
      Effect.tryPromise({
        try: async () => {
          const entries = await readdir(base, { withFileTypes: true });
          return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((id) => !isUnsafeScratchId(id));
        },
        catch: (cause) =>
          scratchAppError("gc", `Unable to inspect scratch app directories under ${base}.`, cause),
      }).pipe(
        Effect.catchIf(
          (error) =>
            typeof error.cause === "object" &&
            error.cause !== null &&
            (error.cause as { readonly code?: unknown }).code === "ENOENT",
          () => Effect.succeed([]),
        ),
      ),
    ),
  );

  const gc = (options?: { readonly prune?: boolean }) =>
    Effect.gen(function* () {
      const entries = yield* scratchRegistry.list();
      const registryIds = new Set(entries.map((entry) => entry.id));
      const dirIds = new Set(yield* diskScratchIds);
      const labelIds = new Set(yield* scanner.listScratchIds);
      const allIds = [...new Set([...registryIds, ...dirIds, ...labelIds])].sort();
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const candidates = allIds.filter((id) => {
        const entry = byId.get(id);
        const hasRegistry = entry !== undefined;
        const hasDir = dirIds.has(id);
        const hasLabel = labelIds.has(id);
        const registryStale = hasRegistry && !hasDir;
        const directoryOrphan = hasDir && !hasRegistry;
        const providerLabelOrphan = hasLabel && !hasRegistry;
        const deadOwner = entry !== undefined && ownerPidIsDead(entry);
        return registryStale || directoryOrphan || providerLabelOrphan || deadOwner;
      });

      if (options?.prune !== true) return { inspected: allIds.length, reaped: [], errors: [] };

      const reaped: string[] = [];
      const errors: string[] = [];
      for (const id of candidates) {
        if (isUnsafeScratchId(id)) {
          errors.push(`${id}: unsafe scratch id`);
          continue;
        }
        const scratchPaths = yield* paths(id);
        const cachedPlan = yield* readCachedPlan(scratchPaths.planCache);
        const result = yield* reapScratch({
          id,
          instanceRoot: scratchPaths.instanceRoot,
          ...(cachedPlan === undefined ? {} : { plan: cachedPlan }),
        }).pipe(Effect.either);
        if (result._tag === "Right") reaped.push(id);
        else errors.push(`${id}: ${result.left.message}`);
      }
      return { inspected: allIds.length, reaped, errors };
    });

  return {
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
  };
};

export const ScratchAppServiceLive = Layer.effect(
  ScratchAppService,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const landofileService = yield* LandofileService;
    const planner = yield* AppPlanner;
    const providerRegistry = yield* RuntimeProviderRegistry;
    const scratchRegistry = yield* ScratchRegistry;
    const scanner = yield* ScratchResourceScanner;
    const dataMover = yield* DataMover;
    return makeScratchAppService(
      fileSystem,
      landofileService,
      planner,
      providerRegistry,
      scratchRegistry,
      scanner,
      dataMover,
    );
  }),
);

/**
 * Converts a live foreground scratch app to a detached one
 * (`apps:scratch:run --keep`): the registry entry drops its owner pid and the
 * acquire scope's destroy finalizer observes `detached: true` and skips the
 * teardown, leaving lifecycle ownership to `apps:scratch:*` and gc.
 */
export const detachScratchApp = (
  id: string,
): Effect.Effect<void, ScratchAppNotFoundError | ScratchAppError> =>
  Effect.gen(function* () {
    const registry = makeScratchRegistry();
    const entry = yield* registry.get(id);
    if (entry === undefined) return yield* Effect.fail(scratchAppNotFoundError(id));
    const { ownerPid: _ownerPid, ...rest } = entry;
    yield* registry.upsert({ ...rest, detached: true, updatedAt: nowIso() });
  });

/**
 * Acquires a scratch app and also returns its planned `AppPlan`. The plan is
 * read from the scratch instance's own plan cache written during acquisition;
 * the public {@link ScratchAppService.acquire} stays plan-free (returns only the
 * handle). Core-private: keeps plan-cache coupling inside the scratch module.
 */
export const acquireScratchAppWithPlan = (
  input: ScratchAcquireInput,
): Effect.Effect<
  { readonly handle: ScratchHandle; readonly plan: AppPlan },
  ScratchSourceUnresolvedError | ScratchIsolationConflictError | ScratchAppError,
  ScratchAppService | FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const service = yield* ScratchAppService;
    const fileSystem = yield* FileSystem;
    const handle = yield* service.acquire(input);
    const scratchPaths = yield* service.paths(handle.id);
    const content = yield* fileSystem
      .readText(scratchPaths.planCache)
      .pipe(
        Effect.mapError((cause) =>
          scratchAppError("acquire", `Unable to read the cached plan for scratch app ${handle.id}.`, cause),
        ),
      );
    const plan = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(AppPlanSchema)(JSON.parse(content)),
      catch: (cause) =>
        scratchAppError("acquire", `Unable to decode the cached plan for scratch app ${handle.id}.`, cause),
    });
    return { handle, plan };
  });
