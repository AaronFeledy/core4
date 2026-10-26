import { randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { migrateAppliedPlan } from "@lando/container-runtime/applied-state";
import { sha256Hex } from "@lando/sdk/digest";

import { Context, DateTime, Effect, Layer, Option, Predicate, Schema, type Scope } from "effect";

import {
  AppPlacementError,
  LandofileVersionConstraintError,
  ScratchAppError,
  ScratchAppNotFoundError,
  ScratchIsolationConflictError,
  ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  AppPlan as AppPlanSchema,
  type BindMountPlan,
  type IsolateMode,
  type LandofileShape,
  type NetworkingPlan,
  PortablePath,
  type ProviderCapabilities,
  type RouterConfig,
  ServiceName,
  landoNetworkingPlan,
  orderMounts,
  serviceAppMount,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  DataMover,
  FileSystem,
  GlobalAppService,
  LandofileService,
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
  type ScratchSummary,
} from "@lando/sdk/services";

import type { UserAppResolution } from "@lando/landofile/app-resolution";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import { makeLandoPaths } from "@lando/paths";
import { EnvironmentValueResolver } from "@lando/sdk/services";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { routerEnabled } from "../config/router-config.ts";
import { globalCreateProviderId } from "../global-app/placement.ts";
import {
  loadUserLandofile,
  loadUserLandofileFile,
  makeEngineUserAppResolution,
} from "../landofile/app-resolution.ts";
import { ensureAppPlacement } from "../providers/app-placement.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { makeScratchReaper } from "./destroy.ts";
import { ownerPidIsDead, scratchGcCandidates } from "./gc-candidates.ts";
import { SCRATCH_EXTENSION_KEY } from "./identity.ts";
import { decodeScratchLandofile } from "./landofile.ts";
import { ScratchRegistry, type ScratchRegistryEntry, makeScratchRegistry } from "./registry.ts";
import { ScratchResourceScanner, isCanonicalScratchId } from "./scanner.ts";
import { applyScratchStartup, withScratchAcquisition } from "./startup.ts";

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
      return "Fix permissions on the Lando scratch directory under the user cache root, then retry.";
    case "gc":
      return "Fix permissions under the scratch cache directory, then retry `lando apps:scratch:gc`.";
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
    remediation: remediation ?? scratchRemediationFor(operation),
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

const DEFAULT_SCRATCH_EXCLUDES = [".git/", "node_modules/", "vendor/", ".lando/cache/", ".DS_Store"] as const;

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

export const applyMountCwd = (
  plan: AppPlan,
  target: string | undefined,
  hostCwd: string,
): AppPlan | undefined => {
  const primaryName = findPrimaryServiceName(plan);
  if (primaryName === undefined) return undefined;
  const primary = plan.services[primaryName];
  if (primary === undefined) return undefined;
  const appMount = serviceAppMount(primary);
  const containerTarget = PortablePath.make(target ?? appMount?.target ?? "/app");
  // The cwd at the app mount's own target replaces the app source; any other
  // target adds a plain bind there and leaves the app mount alone. Either way
  // the cwd bind replaces whatever was planned at its target.
  const rebound = appMount !== undefined && appMount.target === containerTarget ? appMount : undefined;
  let cwdBind: BindMountPlan = {
    type: "bind",
    source: hostCwd,
    target: containerTarget,
    readOnly: false,
    realization: "passthrough",
  };
  if (rebound !== undefined) {
    const { mountKey: _mountKey, ...bind } = rebound;
    cwdBind = { ...bind, source: hostCwd, realization: "passthrough" };
  }
  const mounts = orderMounts([
    ...primary.mounts.flatMap((mount) => {
      if (mount.target === containerTarget) return [];
      if (rebound === undefined || mount.type !== "bind" || !mount.target.startsWith(`${containerTarget}/`))
        return [mount];
      // Binds that mirror a path of the app source (nested includes, `./vendor/x` at
      // `/app/vendor/x`) follow the app source when it moves to the host cwd.
      const rel = mount.target.slice(containerTarget.length + 1);
      return [
        relative(rebound.source, mount.source).replaceAll("\\", "/") === rel
          ? { ...mount, source: join(hostCwd, rel) }
          : mount,
      ];
    }),
    cwdBind,
  ]);
  const nextPrimary = {
    ...primary,
    mounts,
  };
  return {
    ...plan,
    services: { ...plan.services, [primaryName]: nextPrimary },
    fileSync: plan.fileSync.filter(
      (entry) =>
        !(
          entry.session.service === primaryName &&
          rebound?.mountKey !== undefined &&
          entry.session.mountKey === rebound.mountKey
        ),
    ),
  };
};

const applyShareGlobalStorage = (plan: AppPlan): AppPlan => {
  const built = landoNetworkingPlan({
    slug: plan.slug,
    serviceNames: Object.keys(plan.services),
    sharedCrossAppNetwork: true,
  });
  const sharedNetworkMembership = plan.networking?.sharedNetworkMembership ?? built.sharedNetworkMembership;
  const networking: NetworkingPlan = {
    perAppBridge: plan.networking?.perAppBridge ?? built.perAppBridge,
    ...(sharedNetworkMembership === undefined ? {} : { sharedNetworkMembership }),
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

export const suffixScratchHostname = (hostname: string, scratchId: string): string => {
  const labels = hostname.split(".");
  if (labels.length < 3) return hostname;
  const targetIndex = labels.length - 3;
  const target = labels[targetIndex];
  if (target === undefined || target.endsWith(`--${scratchId}`)) return hostname;
  return labels.map((label, index) => (index === targetIndex ? `${label}--${scratchId}` : label)).join(".");
};

const applyScratchHostnames = (plan: AppPlan, input: ScratchAcquireInput): AppPlan => {
  if (input.noHostnameSuffix === true) return plan;
  const preserved = new Set(input.hostnames ?? []);
  const scratchId = String(plan.id);
  return {
    ...plan,
    routes: plan.routes.map((route) =>
      preserved.has(route.hostname)
        ? route
        : { ...route, hostname: suffixScratchHostname(route.hostname, scratchId) },
    ),
  };
};

const applyScratchStartFlags = Effect.fnUntraced(function* (
  plan: AppPlan,
  input: ScratchAcquireInput,
  capabilities: ProviderCapabilities,
  hostCwd: string,
): Effect.fn.Return<AppPlan, ScratchAppError> {
  let next = plan;
  const mountCwd = resolveScratchAcquireIsolation(input) === "cwd" ? (input.mountCwd ?? {}) : input.mountCwd;
  if (mountCwd !== undefined) {
    const mounted = applyMountCwd(next, mountCwd.target, hostCwd);
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
  return applyScratchHostnames(next, input);
});

const scratchIsolationConflict = (flags: ReadonlyArray<string>): ScratchIsolationConflictError =>
  new ScratchIsolationConflictError({
    message: `${flags.join(" and ")} cannot be combined.`,
    flags,
    remediation:
      "Pass --mount-cwd on its own to serve your current directory, or drop it to keep --isolate=full.",
  });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const makeRegistryEntry = Effect.fnUntraced(function* (input: {
  readonly id: string;
  readonly source: ScratchAcquireInput["source"];
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
  resolution: Pick<UserAppResolution, "loadUserLandofile" | "loadUserLandofileFile">,
) {
  const fileSystem = yield* FileSystem;
  const landofileService = yield* LandofileService;
  const environmentResolver = yield* EnvironmentValueResolver;
  const planner = yield* AppPlanner;
  const providerRegistry = yield* RuntimeProviderRegistry;
  const scratchRegistry = yield* ScratchRegistry;
  const scanner = yield* ScratchResourceScanner;
  const dataMover = yield* DataMover;
  const buildOrchestrator = yield* Effect.serviceOption(BuildOrchestrator);
  const proxy = yield* Effect.serviceOption(RouterService);
  const initAppPort = yield* ScratchInitAppPort;
  const reapScratch = yield* makeScratchReaper;
  const startupOwnership = {
    registry: scratchRegistry,
    fileSystem,
    reap: reapScratch,
    retainedIds: retainedScratchIds,
  };
  const globalApp = yield* Effect.serviceOption(GlobalAppService);
  const context = yield* Effect.context<never>();
  const preflightGlobalPlacement: Effect.Effect<void, AppPlacementError | ScratchAppError> =
    globalApp._tag === "None"
      ? Effect.void
      : globalCreateProviderId().pipe(
          Effect.provideService(GlobalAppService, globalApp.value),
          Effect.provideService(RuntimeProviderRegistry, providerRegistry),
          Effect.provide(context),
          Effect.asVoid,
          Effect.mapError((cause) =>
            cause instanceof AppPlacementError
              ? cause
              : scratchAppError("start", "Unable to resolve global app placement.", cause),
          ),
        );
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
      const suffix = sha256Hex(`${base}:${process.pid}:${randomBytes(8).toString("hex")}`).slice(0, 6);
      return `scratch-${sanitizeBase(base)}-${suffix}`;
    });

  const unlessKeepOnFailure = (
    input: ScratchAcquireInput,
    effect: Effect.Effect<void, ScratchAppError>,
  ): Effect.Effect<void, ScratchAppError> => (input.keepOnFailure === true ? Effect.void : effect);

  const paths = (id: string) =>
    isUnsafeScratchId(id) || !isCanonicalScratchId(id)
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
          try: () => decodeScratchPlan(JSON.parse(content)),
          catch: () => undefined,
        }),
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    );

  const removeExcludedPaths = (destination: string, excludes: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: async () => {
        const patterns = [...DEFAULT_SCRATCH_EXCLUDES, ...excludes].map((pattern) =>
          pattern.replace(/^\.\//u, ""),
        );
        const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
          const entries = await readdir(directory, { withFileTypes: true });
          for (const entry of entries) {
            const relative =
              relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
            const excluded = patterns.some((pattern) => {
              const directoryOnly = pattern.endsWith("/");
              const normalized = directoryOnly ? pattern.slice(0, -1) : pattern;
              if (directoryOnly && normalized === ".git") return entry.name === ".git";
              if (directoryOnly && !entry.isDirectory()) return false;
              if (!normalized.includes("/") && !normalized.includes("*")) return entry.name === normalized;
              return new Bun.Glob(normalized).match(relative);
            });
            const path = join(directory, entry.name);
            if (excluded) {
              await rm(path, { recursive: true, force: true });
            } else if (entry.isDirectory()) {
              await visit(path, relative);
            }
          }
        };
        await visit(destination, "");
      },
      catch: (cause) =>
        scratchAppError(
          "materialize",
          `Unable to apply scratch copy exclusions under ${destination}.`,
          cause,
        ),
    });

  const removeLocalOverrides = (destination: string) =>
    Effect.tryPromise({
      try: () =>
        Promise.all(
          [".lando.local.yml", ".lando.user.yml"].map((file) => rm(join(destination, file), { force: true })),
        ),
      catch: (cause) =>
        scratchAppError(
          "materialize",
          `Unable to remove local Landofile overrides under ${destination}.`,
          cause,
        ),
    }).pipe(Effect.asVoid);

  const copyAppRoot = (source: string, destination: string, input: ScratchAcquireInput) =>
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
      Effect.andThen(removeExcludedPaths(destination, input.excludes ?? [])),
      Effect.andThen(input.noLocalOverrides === true ? removeLocalOverrides(destination) : Effect.void),
    );

  const startScratchPlan = Effect.fn("ScratchAppService.startScratchPlan")(function* (request: {
    readonly id: string;
    readonly plan: AppPlan;
    readonly planCache: AbsolutePath;
    readonly landofileRouter?: RouterConfig;
  }) {
    const { id: scratchId, plan, planCache, landofileRouter } = request;
    const markedPlan = markScratchPlan(plan, scratchId);
    yield* ensureAppPlacement(
      { kind: "scratch", id: scratchId, root: markedPlan.root },
      markedPlan.provider,
    ).pipe(
      Effect.provideService(RuntimeProviderRegistry, providerRegistry),
      Effect.mapError((cause) =>
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
    const provider = yield* providerRegistry
      .select(markedPlan)
      .pipe(
        Effect.mapError((cause) =>
          scratchAppError("start", `Unable to select a provider for scratch app ${scratchId}.`, cause),
        ),
      );
    yield* writeCachedPlan(planCache, markedPlan);
    const builtPlan = yield* Option.match(buildOrchestrator, {
      onNone: () => Effect.succeed(markedPlan),
      onSome: (orchestrator) =>
        withBuildProvider(orchestrator.build(markedPlan), provider).pipe(
          Effect.mapError((cause) =>
            scratchAppError("start", `Unable to build scratch app ${scratchId}.`, cause),
          ),
        ),
    });
    yield* applyScratchStartup(
      {
        id: scratchId,
        plan: builtPlan,
        ...(landofileRouter === undefined ? {} : { landofileRouter }),
      },
      {
        provider,
        environmentResolver,
        ...(Option.isSome(proxy) ? { router: proxy.value } : {}),
      },
    );
    return {
      id: scratchId,
      app: { kind: "scratch", id: scratchId, root: markedPlan.root },
    } satisfies ScratchHandle;
  });

  const acquireFork = Effect.fn("ScratchAppService.acquireFork")(function* (input: ScratchAcquireInput) {
    const hostCwd = yield* Effect.sync(() => process.cwd());
    const landofile = yield* resolution
      .loadUserLandofile(landofileService)
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof LandofileVersionConstraintError ? cause : scratchForkUnresolvedError(),
        ),
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
    const base = input.name ?? landofile.document.name ?? sourcePlan.name;
    const scratchId = yield* synthesizeId(base);
    const scratchPaths = yield* paths(scratchId);
    const isolate = resolveScratchAcquireIsolation(input);
    const registryEntry = yield* makeRegistryEntry({
      id: scratchId,
      source: input.source,
      isolate,
      detached: input.detached,
      shareGlobalStorage: input.shareGlobalStorage ?? false,
      rootPath: String(scratchPaths.root),
      status: "acquiring",
    });
    yield* scratchRegistry.upsert(registryEntry);

    yield* materializeDir(scratchPaths.instanceRoot).pipe(
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );
    yield* materializeDir(scratchPaths.root).pipe(
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );

    const forkLandofile = {
      ...landofile,
      document: { ...landofile.document, name: scratchId },
      pendingSites: landofile.pendingSites.filter((site) => site.path[0] !== "name"),
      context: {
        ...landofile.context,
        appRoot: isolate === "full" ? scratchPaths.root : landofile.context.appRoot,
      },
    };
    const planForkPlan =
      isolate === "full"
        ? copyAppRoot(String(sourcePlan.root), String(scratchPaths.root), input).pipe(
            Effect.andThen(
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
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );
    const startPlan = yield* applyScratchStartFlags(forkPlan, input, capabilities, hostCwd).pipe(
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );
    return yield* startScratchPlan({
      id: scratchId,
      plan: startPlan,
      planCache: scratchPaths.planCache,
      ...(landofile.document.router === undefined ? {} : { landofileRouter: landofile.document.router }),
    }).pipe(
      Effect.tap(() =>
        nowIso.pipe(
          Effect.flatMap((updatedAt) =>
            scratchRegistry.upsert({
              ...registryEntry,
              rootPath: String(startPlan.root),
              status: "running",
              updatedAt,
            }),
          ),
        ),
      ),
      (effect) =>
        withScratchAcquisition(
          effect,
          {
            id: scratchId,
            instanceRoot: scratchPaths.instanceRoot,
            plan: markScratchPlan(startPlan, scratchId),
            keepOnFailure: input.keepOnFailure === true,
            detached: input.detached,
          },
          startupOwnership,
        ),
    );
  });

  const acquireRecipe = Effect.fn("ScratchAppService.acquireRecipe")(function* (
    input: ScratchAcquireInput,
    recipeRef: string,
  ) {
    const hostCwd = yield* Effect.sync(() => process.cwd());
    const ref = recipeRef.trim();
    if (ref.length === 0) return yield* Effect.fail(scratchSourceUnresolvedError(input));

    const base = input.name ?? ref;
    const scratchId = yield* synthesizeId(base);
    const scratchPaths = yield* paths(scratchId);
    const registryEntry = yield* makeRegistryEntry({
      id: scratchId,
      source: input.source,
      isolate: resolveScratchAcquireIsolation(input),
      detached: input.detached,
      shareGlobalStorage: input.shareGlobalStorage ?? false,
      rootPath: String(scratchPaths.root),
      status: "acquiring",
    });
    yield* scratchRegistry.upsert(registryEntry);

    yield* materializeDir(scratchPaths.instanceRoot).pipe(
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );
    yield* materializeDir(scratchPaths.root).pipe(
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );

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
    }).pipe(
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );

    const landofilePath = join(scratchPaths.root, ".lando.yml");
    const landofile = yield* resolution.loadUserLandofileFile(landofilePath).pipe(
      Effect.mapError((cause) =>
        scratchAppError(
          "materialize",
          `Unable to load the rendered scratch Landofile at ${landofilePath}.`,
          cause,
        ),
      ),
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );
    const recipeLandofile = {
      ...landofile,
      document: { ...landofile.document, name: scratchId },
      pendingSites: landofile.pendingSites.filter((site) => site.path[0] !== "name"),
    };

    const capabilities = yield* providerRegistry.capabilities.pipe(
      Effect.mapError((cause) =>
        scratchAppError("acquire", "Unable to resolve provider capabilities for the scratch app.", cause),
      ),
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );
    const recipePlan = yield* withProcessCwd(scratchPaths.root, () =>
      planner.plan(recipeLandofile, capabilities),
    ).pipe(
      Effect.mapError((cause) => scratchAppError("start", `Unable to plan scratch app ${scratchId}.`, cause)),
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );
    const startPlan = yield* applyScratchStartFlags(recipePlan, input, capabilities, hostCwd).pipe(
      Effect.tapError(() =>
        unlessKeepOnFailure(input, reapScratch({ id: scratchId, instanceRoot: scratchPaths.instanceRoot })),
      ),
    );
    return yield* startScratchPlan({
      id: scratchId,
      plan: startPlan,
      planCache: scratchPaths.planCache,
      ...(landofile.document.router === undefined ? {} : { landofileRouter: landofile.document.router }),
    }).pipe(
      Effect.tap(() =>
        nowIso.pipe(
          Effect.flatMap((updatedAt) =>
            scratchRegistry.upsert({
              ...registryEntry,
              rootPath: String(startPlan.root),
              status: "running",
              updatedAt,
            }),
          ),
        ),
      ),
      (effect) =>
        withScratchAcquisition(
          effect,
          {
            id: scratchId,
            instanceRoot: scratchPaths.instanceRoot,
            plan: markScratchPlan(startPlan, scratchId),
            keepOnFailure: input.keepOnFailure === true,
            detached: input.detached,
          },
          startupOwnership,
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

  const info = Effect.fn("ScratchAppService.info")(function* (
    id: string,
  ): Effect.fn.Return<ScratchInfo, ScratchAppNotFoundError | ScratchAppError> {
    const entry = yield* scratchRegistry.get(id);
    if (entry === undefined) return yield* Effect.fail(scratchAppNotFoundError(id));
    const scratchPaths = yield* paths(id);
    const cachedPlan = yield* readCachedPlan(scratchPaths.planCache);
    return { ...summaryFromEntry(entry), ...scratchPlanDetail(cachedPlan) };
  });

  const start = (id: string) => resolveById(id);

  const destroy = Effect.fn("ScratchAppService.destroy")(function* (
    id: string,
    options: ScratchDestroyOptions = {},
  ) {
    const entry = yield* scratchRegistry.get(id);
    if (entry === undefined && options.reason !== "poweroff")
      return yield* Effect.fail(scratchAppNotFoundError(id));
    const scratchPaths = yield* paths(id);
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

  const gc = Effect.fn("ScratchAppService.gc")(function* (options?: { readonly prune?: boolean }) {
    const entries = yield* scratchRegistry.list();
    const { inspected, candidates } = scratchGcCandidates(
      entries,
      yield* diskScratchIds,
      yield* scanner.listScratchIds,
    );

    if (options?.prune !== true) return { inspected, reaped: [], errors: [] };

    const reaped: string[] = [];
    const errors: string[] = [];
    for (const id of candidates) {
      if (isUnsafeScratchId(id) || !isCanonicalScratchId(id)) {
        errors.push(`${id}: unsafe scratch id`);
        continue;
      }
      const scratchPaths = yield* paths(id);
      const cachedPlan = yield* readCachedPlan(scratchPaths.planCache);
      const result = yield* reapScratch({
        id,
        instanceRoot: scratchPaths.instanceRoot,
        reason: "gc",
        ...(cachedPlan === undefined ? {} : { plan: cachedPlan }),
      }).pipe(Effect.result);
      if (result._tag === "Success") reaped.push(id);
      else errors.push(`${id}: ${result.failure.message}`);
    }
    return { inspected, reaped, errors };
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

const makeScratchAppServiceLayer = (
  resolution: Pick<UserAppResolution, "loadUserLandofile" | "loadUserLandofileFile">,
) => Layer.effect(ScratchAppService, makeScratchAppService(resolution));

export const layerWith = (inputs: LandofileRuntimeInputs) =>
  makeScratchAppServiceLayer(makeEngineUserAppResolution(inputs));

export const layer = makeScratchAppServiceLayer({ loadUserLandofile, loadUserLandofileFile });

/**
 * Converts a live foreground scratch app to a detached one
 * (`apps:scratch:run --keep`): the registry entry drops its owner pid and the
 * acquire scope's destroy finalizer observes `detached: true` and skips the
 * teardown, leaving lifecycle ownership to `apps:scratch:*` and gc.
 */
export const detachScratchApp = Effect.fnUntraced(function* (
  id: string,
  privateFileAccess: PrivateFileAccess,
): Effect.fn.Return<void, ScratchAppNotFoundError | ScratchAppError> {
  const registry = makeScratchRegistry(privateFileAccess);
  const entry = yield* registry.get(id);
  if (entry === undefined) return yield* Effect.fail(scratchAppNotFoundError(id));
  const { ownerPid: _ownerPid, ...rest } = entry;
  yield* registry.upsert({ ...rest, detached: true, updatedAt: yield* nowIso });
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
  | ScratchIsolationConflictError
  | ScratchAppError
  | AppPlacementError
  | LandofileVersionConstraintError,
  ScratchAppService | FileSystem | Scope.Scope
> {
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
    try: () => decodeScratchPlan(JSON.parse(content)),
    catch: (cause) =>
      scratchAppError("acquire", `Unable to decode the cached plan for scratch app ${handle.id}.`, cause),
  });
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
      Effect.mapError((cause) =>
        scratchAppError("run", `Unable to read the rendered scratch Landofile at ${landofilePath}.`, cause),
      ),
    );
  return (yield* decodeScratchLandofile(landofilePath, content, scratchPaths.root)).document;
});
