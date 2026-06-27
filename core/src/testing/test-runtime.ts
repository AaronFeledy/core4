/**
 * `@lando/core/testing` — deterministic Effect service test fixtures.
 */
import { isAbsolute, relative, resolve } from "node:path";
import {
  Cause,
  Clock,
  type Context,
  DateTime,
  type Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Schema,
  Stream,
} from "effect";

import {
  CacheError,
  EventError,
  PluginLoadError,
  ScratchAppNotFoundError,
  SecretNotFoundError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  GlobalConfig,
  LandofileShape,
  type PlanMetadata,
  ProviderId,
  ServiceName,
  ServicePlan,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  CacheService,
  CommandRegistry,
  ConfigService,
  DeprecationService,
  type EventFor,
  EventService,
  type EventWaitSpec,
  FileSyncEngine,
  FileSystem,
  GlobalAppService,
  type LandoEvent,
  LandofileService,
  Logger,
  PluginRegistry,
  type PluginTrustState,
  PluginTrustStore,
  PrivilegeService,
  ProcessRunner,
  type ProcessSpawnOptions,
  Renderer,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ScratchAppService,
  type ScratchInfo,
  type ScratchSummary,
  SecretStore,
  Telemetry,
  ToolingEngine,
} from "@lando/sdk/services";
/**
 * Re-export of the SDK's contract-valid deterministic runtime provider fixture.
 */
export { TestRuntimeProvider } from "@lando/sdk/test";
/**
 * Re-export of Effect's deterministic test clock utilities for callers using this test runtime.
 */
export { TestClock, TestContext } from "effect";
import { TestRuntimeProvider } from "@lando/sdk/test";

import {
  ScratchRegistry,
  type ScratchRegistryEntry,
  type ScratchRegistryEnvelope,
} from "../scratch-app/registry.ts";
import { ScratchResourceScanner } from "../scratch-app/scanner.ts";

type TestBootstrapLevel = "minimal" | "provider" | "global" | "scratch" | "app";

/**
 * Recorded structured logger call emitted through the deterministic test logger.
 */
export interface LoggerCall {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Recorded raw renderer output written to the in-memory stdout or stderr channel.
 */
export interface RendererCall {
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

/**
 * Recorded in-memory file-system operation performed by the deterministic test file system.
 */
export interface FileSystemCall {
  readonly operation:
    | "read"
    | "readText"
    | "write"
    | "writeAtomic"
    | "exists"
    | "stat"
    | "lstat"
    | "mkdir"
    | "remove"
    | "readDir"
    | "readFile"
    | "writeFile";
  readonly path: string;
  readonly content?: string;
}

/**
 * Mutable call buckets exposed by a test runtime for assertions about side effects.
 */
export interface TestRuntimeCalls {
  readonly logger: LoggerCall[];
  readonly renderer: RendererCall[];
  readonly events: LandoEvent[];
  readonly fileSystem: FileSystemCall[];
  readonly processRunner: ProcessSpawnOptions[];
  readonly config: Array<"load" | `get:${string}`>;
}

/**
 * Options for constructing an isolated deterministic runtime layer.
 */
export interface TestRuntimeOptions<Bootstrap extends TestBootstrapLevel = TestBootstrapLevel> {
  readonly bootstrap?: Bootstrap;
  readonly config?: GlobalConfig;
  readonly files?: Readonly<Record<string, string>>;
  readonly with?: {
    readonly RuntimeProvider?: RuntimeProviderShape;
  };
}

type MinimalTestRuntimeServices =
  | Logger
  | Renderer
  | Telemetry
  | ConfigService
  | EventService
  | DeprecationService
  | PluginTrustStore
  | CacheService
  | FileSystem
  | PrivilegeService
  | SecretStore
  | ProcessRunner;
type ProviderTestRuntimeServices =
  | MinimalTestRuntimeServices
  | PluginRegistry
  | RuntimeProviderRegistry
  | RuntimeProvider
  | GlobalAppService;
type GlobalTestRuntimeServices = ProviderTestRuntimeServices | AppPlanner;
type ScratchTestRuntimeServices =
  | ProviderTestRuntimeServices
  | AppPlanner
  | LandofileService
  | ScratchAppService
  | ScratchRegistry
  | ScratchResourceScanner;
type AppTestRuntimeServices =
  | ProviderTestRuntimeServices
  | AppPlanner
  | LandofileService
  | CommandRegistry
  | ToolingEngine
  | FileSyncEngine;

type TestRuntimeServicesFor<Bootstrap extends TestBootstrapLevel> = Bootstrap extends unknown
  ? Bootstrap extends "minimal"
    ? MinimalTestRuntimeServices
    : Bootstrap extends "provider"
      ? ProviderTestRuntimeServices
      : Bootstrap extends "global"
        ? GlobalTestRuntimeServices
        : Bootstrap extends "scratch"
          ? ScratchTestRuntimeServices
          : AppTestRuntimeServices
  : never;

interface TestRuntimeFor<Bootstrap extends TestBootstrapLevel> {
  readonly layer: Layer.Layer<TestRuntimeServicesFor<Bootstrap>>;
  readonly calls: TestRuntimeCalls;
  readonly files: Map<string, string>;
}

/**
 * Fresh deterministic runtime instance returned by `makeTestRuntime`.
 */
export type TestRuntime = {
  readonly [Bootstrap in TestBootstrapLevel]: TestRuntimeFor<Bootstrap>;
}[TestBootstrapLevel];

type MinimalTestRuntimeOptions = TestRuntimeOptions<"minimal"> & { readonly bootstrap?: "minimal" };
type RuntimeProviderRegistryService = Context.Tag.Service<typeof RuntimeProviderRegistry>;

const fixedDateTime = DateTime.unsafeMake("2026-06-01T00:00:00.000Z");
const fixedMetadata: PlanMetadata = {
  resolvedAt: fixedDateTime,
  source: "@lando/core/testing",
  runtime: 4,
};

const defaultGlobalConfig: GlobalConfig = Schema.decodeUnknownSync(GlobalConfig)({
  telemetry: { enabled: false },
});

const textFromContent = (content: string | Uint8Array): string =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

const uniqueSorted = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)].sort();

const providerIdFrom = (provider: RuntimeProviderShape): ProviderId => ProviderId.make(provider.id);

const slugFromName = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length === 0 ? "test-runtime-app" : slug;
};

const recordLoggerCall = (
  calls: TestRuntimeCalls,
  level: LoggerCall["level"],
  message: string,
  data: Readonly<Record<string, unknown>> | undefined,
) => {
  if (data === undefined) {
    calls.logger.push({ level, message });
    return;
  }

  calls.logger.push({ level, message, data });
};

const serviceNotRegistered = (id: string): PluginLoadError =>
  new PluginLoadError({ message: `Plugin service ${id} is not registered in TestRuntime.`, pluginName: id });

const scratchNotFound = (id: string): ScratchAppNotFoundError =>
  new ScratchAppNotFoundError({
    message: `Scratch app ${id} is not present in TestRuntime.`,
    id,
    suggestions: [],
    remediation: "Acquire the scratch app before resolving it.",
  });

const makeServicePlan = (providerId: ProviderId): ServicePlan =>
  Schema.decodeUnknownSync(ServicePlan)({
    name: ServiceName.make("appserver"),
    type: "test-runtime",
    provider: providerId,
    primary: true,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata: fixedMetadata,
    extensions: {},
  });

const makeAppPlan = (input: {
  readonly name: string;
  readonly root: string;
  readonly providerId: ProviderId;
}): AppPlan => {
  const service = makeServicePlan(input.providerId);
  return Schema.decodeUnknownSync(AppPlan)({
    id: AppId.make(slugFromName(input.name)),
    name: input.name,
    slug: slugFromName(input.name),
    root: AbsolutePath.make(input.root),
    provider: input.providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: fixedMetadata,
    extensions: {},
  });
};

const makeLandofile = (providerId: ProviderId) =>
  Schema.decodeUnknownSync(LandofileShape)({
    name: "test-runtime-app",
    runtime: 4,
    provider: providerId,
    services: {},
  });

const appRefForScratch = (id: string, root: AbsolutePath) => ({
  kind: "scratch" as const,
  id,
  root,
});

const matchesTrustedRoot = (trustedRoot: string, candidate: string): boolean => {
  const resolvedRoot = resolve(trustedRoot);
  const resolvedCandidate = resolve(candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
};

const makeScratchId = (base: string): string => {
  const normalized = slugFromName(base).replace(/^scratch-+/u, "");
  return `scratch-${normalized}-000000`;
};

const primaryServiceName = (plan: AppPlan): string => {
  const service =
    Object.values(plan.services).find((candidate) => candidate.primary) ?? Object.values(plan.services)[0];
  return service?.name ?? "appserver";
};

const registryEntriesFrom = (
  entries: ReadonlyMap<string, ScratchRegistryEntry>,
): ReadonlyArray<ScratchRegistryEntry> =>
  Array.from(entries.values()).sort((left, right) => left.id.localeCompare(right.id));

interface TestCacheEntry {
  readonly value: unknown;
  readonly expiresAtMs?: number;
}

const isExpiredCacheEntry = (entry: TestCacheEntry, nowMs: number): boolean =>
  entry.expiresAtMs !== undefined && entry.expiresAtMs <= nowMs;

const eventError = (event: string, message: string, cause?: unknown): EventError =>
  new EventError({ message, event, ...(cause === undefined ? {} : { cause }) });

const decodeCacheValue = <A, I>(key: string, value: unknown, schema?: Schema.Schema<A, I>) => {
  if (schema === undefined) {
    return Effect.succeed(value as A);
  }

  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(
      (decodeError) =>
        new CacheError({
          message: `Cached value for ${key} failed schema decode.`,
          key,
          decodeError,
        }),
    ),
  );
};

/**
 * Creates a fresh deterministic Effect layer, call recorder, and in-memory file map.
 */
export function makeTestRuntime(options?: MinimalTestRuntimeOptions): TestRuntimeFor<"minimal">;
export function makeTestRuntime<const Bootstrap extends TestBootstrapLevel>(
  options: TestRuntimeOptions<Bootstrap> & { readonly bootstrap: Bootstrap },
): TestRuntimeFor<Bootstrap>;
export function makeTestRuntime(options: TestRuntimeOptions): TestRuntime;
export function makeTestRuntime(options: TestRuntimeOptions = {}): TestRuntime {
  const calls: TestRuntimeCalls = {
    logger: [],
    renderer: [],
    events: [],
    fileSystem: [],
    processRunner: [],
    config: [],
  };
  const files = new Map(Object.entries(options.files ?? {}));
  const directories = new Set<string>();
  const config = options.config ?? defaultGlobalConfig;
  const runtimeProvider = options.with?.RuntimeProvider ?? TestRuntimeProvider;
  const providerId = providerIdFrom(runtimeProvider);
  let pluginTrustState: PluginTrustState = { trustedPlugins: [], trustedAuthoringRoots: [] };
  const secrets = new Map<string, string>();
  const cacheEntries = new Map<string, TestCacheEntry>();
  const scratchSummaries = new Map<string, ScratchSummary>();
  const scratchRegistryEntries = new Map<string, ScratchRegistryEntry>();
  const fileSyncSessions = new Map<FileSyncSessionRef, FileSyncSessionInfo>();

  const loggerService: Context.Tag.Service<typeof Logger> = {
    debug: (message: string, data?: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => recordLoggerCall(calls, "debug", message, data)),
    info: (message: string, data?: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => recordLoggerCall(calls, "info", message, data)),
    warn: (message: string, data?: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => recordLoggerCall(calls, "warn", message, data)),
    error: (message: string, data?: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => recordLoggerCall(calls, "error", message, data)),
  };

  const rendererService: Context.Tag.Service<typeof Renderer> = {
    id: "test",
    message: {
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
    },
    output: {
      stdout: (chunk) =>
        Effect.sync(() => {
          calls.renderer.push({ stream: "stdout", chunk });
        }),
      stderr: (chunk) =>
        Effect.sync(() => {
          calls.renderer.push({ stream: "stderr", chunk });
        }),
    },
  };

  const telemetryService: Context.Tag.Service<typeof Telemetry> = {
    enabled: false,
    record: () => Effect.void,
  };

  const eventPubSub = Effect.runSync(PubSub.unbounded<LandoEvent>());
  const matchesEventName = (name: string, event: LandoEvent): boolean => name === "*" || event._tag === name;
  const waitForEventMatch = <A>(
    label: string,
    predicate: (event: LandoEvent) => boolean,
    timeout: Duration.DurationInput | undefined,
  ): Effect.Effect<A, EventError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* PubSub.subscribe(eventPubSub);
        const awaited = Stream.fromQueue(queue).pipe(
          Stream.filter(predicate),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(eventError(label, `Event stream ended before receiving event: ${label}`)),
              onSome: (event) => Effect.succeed(event as A),
            }),
          ),
        );
        return yield* timeout === undefined
          ? awaited
          : awaited.pipe(
              Effect.timeoutFail({
                duration: timeout,
                onTimeout: () =>
                  new EventError({
                    message: `Timed out waiting for event: ${label}`,
                    event: label,
                    reason: "timeout",
                  }),
              }),
            );
      }),
    );
  const eventService: Context.Tag.Service<typeof EventService> = {
    publish: (event) =>
      Effect.sync(() => {
        calls.events.push(event);
      }).pipe(
        Effect.zipRight(PubSub.publish(eventPubSub, event)),
        Effect.asVoid,
        Effect.catchSomeCause((cause) =>
          Cause.isDie(cause)
            ? Option.some(
                Effect.fail(eventError(event._tag, `Failed to publish event: ${event._tag}`, cause)),
              )
            : Option.none(),
        ),
      ),
    subscribe: <Name extends string>(name: Name) =>
      Stream.fromPubSub(eventPubSub).pipe(
        Stream.filter((event): event is EventFor<Name> => matchesEventName(name, event)),
      ),
    subscribeQueue: PubSub.subscribe(eventPubSub),
    waitFor: (name, options) =>
      waitForEventMatch<EventFor<typeof name>>(
        name,
        (event) => matchesEventName(name, event) && (options?.filter?.(event as never) ?? true),
        options?.timeout,
      ),
    waitForAny: (specs, options) =>
      waitForEventMatch(
        "*",
        (event) =>
          specs.some(
            (spec: EventWaitSpec) =>
              matchesEventName(spec.name, event) && (spec.filter?.(event as never) ?? true),
          ),
        options?.timeout,
      ),
    query: <Name extends string>(name: Name, filter?: (event: EventFor<Name>) => boolean) =>
      Effect.sync(() =>
        calls.events.filter(
          (event): event is EventFor<Name> =>
            matchesEventName(name, event) && (filter?.(event as EventFor<Name>) ?? true),
        ),
      ),
  };

  const deprecationService: Context.Tag.Service<typeof DeprecationService> = {
    use: () => Effect.void,
    summary: () => Effect.succeed([]),
    lookup: () => Effect.succeed(Option.none()),
    register: () => Effect.void,
    registerAlias: () => Effect.void,
  };

  const pluginTrustStoreService: Context.Tag.Service<typeof PluginTrustStore> = {
    read: Effect.sync(() => pluginTrustState),
    isPluginTrusted: (name) => Effect.sync(() => pluginTrustState.trustedPlugins.includes(name)),
    trustPlugin: (name) =>
      Effect.sync(() => {
        pluginTrustState = {
          ...pluginTrustState,
          trustedPlugins: uniqueSorted([...pluginTrustState.trustedPlugins, name]),
        };
      }),
    untrustPlugin: (name) =>
      Effect.sync(() => {
        pluginTrustState = {
          ...pluginTrustState,
          trustedPlugins: pluginTrustState.trustedPlugins.filter((entry) => entry !== name),
        };
      }),
    isAuthoringRootTrusted: (path) =>
      Effect.sync(() =>
        pluginTrustState.trustedAuthoringRoots.some((root) => matchesTrustedRoot(root, path)),
      ),
    trustAuthoringRoot: (path) =>
      Effect.sync(() => {
        pluginTrustState = {
          ...pluginTrustState,
          trustedAuthoringRoots: uniqueSorted([...pluginTrustState.trustedAuthoringRoots, path]),
        };
      }),
  };

  const cacheService: Context.Tag.Service<typeof CacheService> = {
    read: (key, schema) =>
      Effect.gen(function* () {
        const entry = cacheEntries.get(key);
        if (entry === undefined) return null;

        const nowMs = yield* Clock.currentTimeMillis;
        if (isExpiredCacheEntry(entry, nowMs)) {
          cacheEntries.delete(key);
          return null;
        }

        return yield* decodeCacheValue(key, entry.value, schema);
      }),
    write: (key, value, ttlMs) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        cacheEntries.set(key, {
          value,
          ...(ttlMs === undefined ? {} : { expiresAtMs: nowMs + ttlMs }),
        });
      }),
    writeAtomic: (path, content) =>
      Effect.sync(() => {
        directories.delete(path);
        files.set(path, textFromContent(content));
      }),
    invalidate: (key) =>
      Effect.sync(() => {
        cacheEntries.delete(key);
      }),
  };

  const fileSystemService: Context.Tag.Service<typeof FileSystem> = {
    read: (path: string) => {
      calls.fileSystem.push({ operation: "read", path });
      const content = files.get(path) ?? "";
      return Stream.fromIterable([new TextEncoder().encode(content)]);
    },
    readText: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "readText", path });
        return files.get(path) ?? "";
      }),
    write: (path: string, content: string | Uint8Array) =>
      Effect.sync(() => {
        const text = textFromContent(content);
        calls.fileSystem.push({ operation: "write", path, content: text });
        directories.delete(path);
        files.set(path, text);
      }),
    writeAtomic: (path: string, content: string | Uint8Array) =>
      Effect.sync(() => {
        const text = textFromContent(content);
        calls.fileSystem.push({ operation: "writeAtomic", path, content: text });
        directories.delete(path);
        files.set(path, text);
      }),
    exists: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "exists", path });
        return files.has(path) || directories.has(path);
      }),
    stat: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "stat", path });
        const fileContent = files.get(path);
        const isDirectory = directories.has(path);
        return {
          size: isDirectory ? 0 : (fileContent?.length ?? 0),
          mtimeMs: 0,
          isFile: !isDirectory && fileContent !== undefined,
          isDirectory,
        };
      }),
    lstat: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "lstat", path });
        const fileContent = files.get(path);
        const isDirectory = directories.has(path);
        return {
          size: isDirectory ? 0 : (fileContent?.length ?? 0),
          mtimeMs: 0,
          isFile: !isDirectory && fileContent !== undefined,
          isDirectory,
          isSymbolicLink: false,
        };
      }),
    mkdir: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "mkdir", path });
        files.delete(path);
        directories.add(path);
      }),
    remove: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "remove", path });
        files.delete(path);
        directories.delete(path);
      }),
    readDir: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "readDir", path });
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const entries = [...files.keys(), ...directories.values()]
          .filter((entryPath) => entryPath.startsWith(prefix))
          .flatMap((entryPath) => {
            const entry = entryPath.slice(prefix.length).split("/")[0];
            return entry === undefined || entry.length === 0 ? [] : [entry];
          });

        return uniqueSorted(entries);
      }),
    readFile: (path: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "readFile", path });
        return files.get(path) ?? "";
      }),
    writeFile: (path: string, content: string) =>
      Effect.sync(() => {
        calls.fileSystem.push({ operation: "writeFile", path, content });
        directories.delete(path);
        files.set(path, content);
      }),
  };

  const privilegeService: Context.Tag.Service<typeof PrivilegeService> = {
    elevate: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  };

  const secretStoreService: Context.Tag.Service<typeof SecretStore> = {
    id: "test",
    get: (secret) => {
      const value = secrets.get(secret);
      return value === undefined
        ? Effect.fail(
            new SecretNotFoundError({
              message: `Secret '${secret}' is not present in TestRuntime.`,
              secret,
              remediation: "Seed the TestRuntime secret map before reading this secret.",
            }),
          )
        : Effect.succeed(value);
    },
    has: (secret) => Effect.sync(() => secrets.has(secret)),
    list: Effect.sync(() => uniqueSorted([...secrets.keys()])),
  };

  const processRunnerService: Context.Tag.Service<typeof ProcessRunner> = {
    run: (spawnOptions) =>
      Effect.sync(() => {
        calls.processRunner.push(spawnOptions);
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    stream: (spawnOptions) => {
      calls.processRunner.push(spawnOptions);
      return Stream.empty;
    },
  };

  const configService: Context.Tag.Service<typeof ConfigService> = {
    load: Effect.sync(() => {
      calls.config.push("load");
      return config;
    }),
    get: <Key extends keyof GlobalConfig>(key: Key) =>
      Effect.sync(() => {
        calls.config.push(`get:${String(key)}`);
        return config[key];
      }),
  };

  const pluginRegistryService: Context.Tag.Service<typeof PluginRegistry> = {
    list: Effect.succeed([]),
    load: (name) => Effect.fail(serviceNotRegistered(name)),
    loadServiceType: (id) => Effect.fail(serviceNotRegistered(id)),
    loadServiceFeature: (id) => Effect.fail(serviceNotRegistered(id)),
    loadAppFeature: (id) => Effect.fail(serviceNotRegistered(id)),
  };

  const commandRegistryService: Context.Tag.Service<typeof CommandRegistry> = {
    list: Effect.succeed([]),
  };

  const runtimeProviderRegistryService: RuntimeProviderRegistryService = {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(runtimeProvider.capabilities),
    select: () => Effect.succeed(runtimeProvider),
  };

  const globalPaths = {
    root: AbsolutePath.make("/test-runtime/global"),
    distLandofile: AbsolutePath.make("/test-runtime/global/.lando.dist.yml"),
    userLandofile: AbsolutePath.make("/test-runtime/global/.lando.yml"),
  };
  const globalAppService: Context.Tag.Service<typeof GlobalAppService> = {
    id: "global",
    root: Effect.succeed(globalPaths.root),
    ensureRoot: Effect.void,
    paths: Effect.succeed(globalPaths),
    ensureUserLandofile: Effect.succeed({ path: globalPaths.userLandofile, created: false }),
    regenerateDist: (input) =>
      Effect.succeed({
        path: globalPaths.distLandofile,
        status: "unchanged" as const,
        serviceIds: uniqueSorted(Object.keys(input?.services ?? {})),
      }),
  };

  const appPlannerService: Context.Tag.Service<typeof AppPlanner> = {
    plan: (landofile) =>
      Effect.succeed(
        makeAppPlan({
          name: landofile.name ?? "test-runtime-app",
          root: "/test-runtime/app",
          providerId: landofile.provider ?? providerId,
        }),
      ),
  };

  const landofileService: Context.Tag.Service<typeof LandofileService> = {
    discover: Effect.succeed(makeLandofile(providerId)),
  };

  const scratchPaths = (id: string) => {
    const instanceRoot = AbsolutePath.make(`/test-runtime/scratch/${id}`);
    return {
      base: AbsolutePath.make("/test-runtime/scratch"),
      instanceRoot,
      root: AbsolutePath.make(`${instanceRoot}/root`),
      planCache: AbsolutePath.make(`${instanceRoot}/plan.json`),
      infoCache: AbsolutePath.make(`${instanceRoot}/info.json`),
      buildResults: AbsolutePath.make(`${instanceRoot}/build-results`),
    };
  };
  const scratchRegistryEntryFromSummary = (
    summary: ScratchSummary,
    paths: ReturnType<typeof scratchPaths>,
  ): ScratchRegistryEntry => ({
    id: summary.id,
    source: summary.source,
    isolate: summary.mode,
    detached: summary.status === "detached",
    rootPath: String(paths.root),
    status: "running",
    createdAt: summary.created,
    updatedAt: summary.created,
  });
  const scratchHandle = (summary: ScratchSummary) => ({ id: summary.id, app: summary.app });
  const scratchInfo = (summary: ScratchSummary): ScratchInfo => ({
    ...summary,
    mounts: [],
    network: {},
    endpoints: [],
  });
  const scratchService: Context.Tag.Service<typeof ScratchAppService> = {
    kind: "scratch",
    root: Effect.succeed(AbsolutePath.make("/test-runtime/scratch")),
    ensureRoot: Effect.succeed(AbsolutePath.make("/test-runtime/scratch")),
    synthesizeId: (base) => Effect.succeed(makeScratchId(base)),
    paths: (id) => Effect.succeed(scratchPaths(id)),
    acquire: (input) =>
      Effect.sync(() => {
        const id = makeScratchId(input.name ?? (input.source.kind === "recipe" ? input.source.ref : "fork"));
        const paths = scratchPaths(id);
        const summary: ScratchSummary = {
          id,
          app: appRefForScratch(id, paths.root),
          source: input.source,
          mode: input.isolate ?? "none",
          created: "2026-06-01T00:00:00.000Z",
          status: input.detached ? "detached" : "attached",
        };
        scratchSummaries.set(id, summary);
        scratchRegistryEntries.set(id, scratchRegistryEntryFromSummary(summary, paths));
        return scratchHandle(summary);
      }),
    resolveById: (id) =>
      Effect.flatMap(
        Effect.sync(() => scratchSummaries.get(id)),
        (summary) =>
          summary === undefined ? Effect.fail(scratchNotFound(id)) : Effect.succeed(scratchHandle(summary)),
      ),
    info: (id) =>
      Effect.flatMap(
        Effect.sync(() => scratchSummaries.get(id)),
        (summary) =>
          summary === undefined ? Effect.fail(scratchNotFound(id)) : Effect.succeed(scratchInfo(summary)),
      ),
    list: () =>
      Effect.sync(() =>
        Array.from(scratchSummaries.values()).sort((left, right) => left.id.localeCompare(right.id)),
      ),
    start: (id) => scratchService.resolveById(id),
    stop: (id) => scratchService.resolveById(id),
    destroy: (id) =>
      Effect.flatMap(scratchService.resolveById(id), (handle) =>
        Effect.sync(() => {
          scratchSummaries.delete(id);
          scratchRegistryEntries.delete(id);
          return handle;
        }),
      ),
    gc: () => Effect.sync(() => ({ inspected: scratchSummaries.size, reaped: [], errors: [] })),
  };

  const scratchRegistryService: Context.Tag.Service<typeof ScratchRegistry> = {
    read: () =>
      Effect.succeed({
        version: 1,
        entries: registryEntriesFrom(scratchRegistryEntries),
      } satisfies ScratchRegistryEnvelope),
    upsert: (entry) =>
      Effect.sync(() => {
        scratchRegistryEntries.set(entry.id, entry);
      }),
    remove: (id) =>
      Effect.sync(() => {
        scratchRegistryEntries.delete(id);
      }),
    list: () => Effect.succeed(registryEntriesFrom(scratchRegistryEntries)),
    get: (id) => Effect.sync(() => scratchRegistryEntries.get(id)),
  };

  const scratchResourceScannerService: Context.Tag.Service<typeof ScratchResourceScanner> = {
    listScratchIds: Effect.succeed([]),
    pruneScratch: () => Effect.void,
  };

  const toolingEngineService: Context.Tag.Service<typeof ToolingEngine> = {
    id: "test",
    run: (invocation, plan) =>
      Effect.succeed({
        tool: invocation.tool,
        service: invocation.service ?? primaryServiceName(plan),
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
  };

  const fileSyncEngineService: Context.Tag.Service<typeof FileSyncEngine> = {
    id: "test",
    displayName: "Test Runtime File Sync",
    capabilities: {
      modes: ["two-way-safe"],
      remoteAgentDeployment: "none",
      exclusionPatterns: true,
      conflictReporting: false,
      progressReporting: false,
    },
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    createSession: (spec) =>
      Effect.sync(() => {
        const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
        fileSyncSessions.set(ref, {
          ref,
          app: spec.app,
          service: spec.service,
          mountKey: spec.mountKey,
          status: "running",
          lastUpdatedAt: fixedDateTime,
        });
        return ref;
      }),
    pauseSession: (ref) =>
      Effect.sync(() => {
        const current = fileSyncSessions.get(ref);
        if (current !== undefined) fileSyncSessions.set(ref, { ...current, status: "paused" });
      }),
    resumeSession: (ref) =>
      Effect.sync(() => {
        const current = fileSyncSessions.get(ref);
        if (current !== undefined) fileSyncSessions.set(ref, { ...current, status: "running" });
      }),
    terminateSession: (ref) =>
      Effect.sync(() => {
        fileSyncSessions.delete(ref);
      }),
    listSessions: (filter) =>
      Effect.sync(() =>
        Array.from(fileSyncSessions.values()).filter((session) => {
          if (filter.app !== undefined) {
            const appMatches =
              session.app.kind === filter.app.kind &&
              session.app.id === filter.app.id &&
              session.app.root === filter.app.root;
            if (!appMatches) return false;
          }
          if (filter.service !== undefined && session.service !== filter.service) return false;
          if (filter.mountKey !== undefined && session.mountKey !== filter.mountKey) return false;
          return true;
        }),
      ),
    streamEvents: () => Stream.empty,
  };

  const minimalLayer: Layer.Layer<MinimalTestRuntimeServices> = Layer.mergeAll(
    Layer.succeed(Logger, loggerService),
    Layer.succeed(Renderer, rendererService),
    Layer.succeed(Telemetry, telemetryService),
    Layer.succeed(ConfigService, configService),
    Layer.succeed(EventService, eventService),
    Layer.succeed(DeprecationService, deprecationService),
    Layer.succeed(PluginTrustStore, pluginTrustStoreService),
    Layer.succeed(CacheService, cacheService),
    Layer.succeed(FileSystem, fileSystemService),
    Layer.succeed(PrivilegeService, privilegeService),
    Layer.succeed(SecretStore, secretStoreService),
    Layer.succeed(ProcessRunner, processRunnerService),
  );

  const providerLayer: Layer.Layer<ProviderTestRuntimeServices> = Layer.mergeAll(
    minimalLayer,
    Layer.succeed(PluginRegistry, pluginRegistryService),
    Layer.succeed(RuntimeProviderRegistry, runtimeProviderRegistryService),
    Layer.succeed(RuntimeProvider, runtimeProvider),
    Layer.succeed(GlobalAppService, globalAppService),
  );

  const globalLayer: Layer.Layer<GlobalTestRuntimeServices> = Layer.mergeAll(
    providerLayer,
    Layer.succeed(AppPlanner, appPlannerService),
  );

  const scratchLayer: Layer.Layer<ScratchTestRuntimeServices> = Layer.mergeAll(
    providerLayer,
    Layer.succeed(AppPlanner, appPlannerService),
    Layer.succeed(LandofileService, landofileService),
    Layer.succeed(ScratchAppService, scratchService),
    Layer.succeed(ScratchRegistry, scratchRegistryService),
    Layer.succeed(ScratchResourceScanner, scratchResourceScannerService),
  );

  const appLayer: Layer.Layer<AppTestRuntimeServices> = Layer.mergeAll(
    providerLayer,
    Layer.succeed(AppPlanner, appPlannerService),
    Layer.succeed(LandofileService, landofileService),
    Layer.succeed(CommandRegistry, commandRegistryService),
    Layer.succeed(ToolingEngine, toolingEngineService),
    Layer.succeed(FileSyncEngine, fileSyncEngineService),
  );

  switch (options.bootstrap ?? "minimal") {
    case "minimal":
      return { layer: minimalLayer, calls, files };
    case "provider":
      return { layer: providerLayer, calls, files };
    case "global":
      return { layer: globalLayer, calls, files };
    case "scratch":
      return { layer: scratchLayer, calls, files };
    case "app":
      return { layer: appLayer, calls, files };
  }
}

/**
 * Returns only the deterministic Effect layer for the selected test bootstrap level.
 */
export function provideTestRuntime(
  options?: MinimalTestRuntimeOptions,
): Layer.Layer<MinimalTestRuntimeServices>;
export function provideTestRuntime<const Bootstrap extends TestBootstrapLevel>(
  options: TestRuntimeOptions<Bootstrap> & { readonly bootstrap: Bootstrap },
): Layer.Layer<TestRuntimeServicesFor<Bootstrap>>;
export function provideTestRuntime(options: TestRuntimeOptions = {}): TestRuntime["layer"] {
  return makeTestRuntime(options).layer;
}

/**
 * Builds a one-service Layer override for tests that need to replace a runtime double.
 */
export const withService = <I, S>(tag: Context.Tag<I, S>, service: S): Layer.Layer<I> =>
  Layer.succeed(tag, service);

/**
 * A pre-built Effect `Layer` providing all test service doubles with `bootstrap: "provider"`.
 *
 * **⚠ WARNING — shared mutable state:** This export is a module-level singleton. The `calls`
 * object and `files` map created inside the single `makeTestRuntime()` call that backs this
 * layer are shared across every test that uses it. Spy arrays and in-memory file entries
 * accumulate across test cases and are **never reset between tests**, which can lead to
 * order-dependent failures and false positives.
 *
 * **Prefer `makeTestRuntime()`** to get a fresh, isolated runtime (with its own `calls` and
 * `files`) for each test. Only use `TestRuntimeLayer` when you explicitly want a shared layer
 * and understand that its internal state is not isolated.
 *
 * @see makeTestRuntime
 * @see provideTestRuntime
 */
export const TestRuntimeLayer = provideTestRuntime({ bootstrap: "provider" });
