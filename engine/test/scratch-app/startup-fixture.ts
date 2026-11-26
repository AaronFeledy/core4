import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import type { EventError, LandofileValidationError, ScratchAppError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, GlobalConfig, type ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  ConfigService,
  EventService,
  type LandoEvent,
  LandofileService,
  PathsService,
  RouterService,
  type RouterServiceShape,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer, Schema, Stream } from "effect";
import {
  ScratchRegistry,
  type ScratchRegistryEntry,
  planScratchRegistryWrite,
} from "../../src/scratch-app/registry.ts";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";
import * as Scratch from "../../src/scratch-app/service.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import { layerUnavailable } from "../../src/subsystems/proxy/api.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
import { emptySnapshotsLayer } from "../operations/data-mover-support.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

interface StartupFixtureOptions {
  readonly onEvent?: (event: LandoEvent) => void;
  readonly eventFailure?: EventError;
  readonly planScratch?: Effect.Effect<void, LandofileValidationError>;
  /** Runs before the registry records the scratch app as running. */
  readonly registration?: Effect.Effect<void, ScratchAppError>;
  /** Publishes a route for `web` and starts through this router. */
  readonly router?: RouterServiceShape;
  readonly routes?: AppPlan["routes"];
  readonly defaultDomain?: string | undefined;
  /** Fields merged into the source app's `web` service. */
  readonly web?: Partial<Pick<ServicePlan, "user" | "endpoints">>;
}

export const withStartupFixture = async (
  overrides: Partial<Pick<RuntimeProviderShape, "inspect" | "exec" | "apply" | "ensureReady">>,
  use: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
  options: StartupFixtureOptions = {},
) => {
  const base = await mkdtemp(join(tmpdir(), "scratch-startup-"));
  const root = join(base, "data");
  const cacheRoot = join(base, "cache");
  await mkdir(root, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousCache = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_DATA_ROOT = root;
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  try {
    await use(await makeFixture(root, overrides, options));
  } finally {
    if (process.env.LANDO_USER_DATA_ROOT === root) {
      if (previousData === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousData;
    }
    if (process.env.LANDO_USER_CACHE_ROOT === cacheRoot) {
      if (previousCache === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
      else process.env.LANDO_USER_CACHE_ROOT = previousCache;
    }
    await rm(base, { recursive: true, force: true });
  }
};

const makeFixture = async (
  root: string,
  overrides: Partial<RuntimeProviderShape>,
  {
    registration = Effect.void,
    router,
    routes,
    defaultDomain,
    onEvent,
    eventFailure,
    planScratch,
    web: webOverrides,
  }: StartupFixtureOptions,
) => {
  const sourceRoot = AbsolutePath.make(join(root, "source"));
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, "keep.txt"), "source survives");
  const entries = new Map<string, ScratchRegistryEntry>();
  const events: LandoEvent[] = [];
  const destroyed: string[] = [];
  const applied: AppPlan[] = [];
  const source: AppPlan = {
    ...plan,
    root: sourceRoot,
    routes:
      routes ??
      (router === undefined
        ? []
        : [
            {
              hostname: "web.source.lndo.site",
              priority: 2,
              scheme: "http",
              service: web.name,
              endpoint: 3000,
              backend: { service: web.name, protocol: "http", port: 3000 },
            },
          ]),
    router: { enabled: router !== undefined },
    services: {
      [web.name]: {
        ...web,
        ...webOverrides,
        healthcheck: {
          kind: "command",
          command: ["probe"],
          retries: 1,
          intervalSeconds: 0,
          timeoutSeconds: 10,
        },
      },
    },
  };
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    setup: () => Effect.die("Host setup is forbidden in scratch startup tests"),
    planSetup: () => Effect.die("Host setup planning is forbidden in scratch startup tests"),
    apply: (plan, options) =>
      Effect.sync(() => {
        applied.push(plan);
      }).pipe(Effect.andThen(TestRuntimeProvider.apply(plan, options))),
    bringDown: (target, options) =>
      Effect.sync(() => {
        if (options.removeState === true) destroyed.push(String(target.app));
        return { kind: "removed" as const, containers: [], volumesRemoved: { data: 0, cache: 0 } };
      }),
    ...overrides,
  };
  const providers = Layer.succeed(
    RuntimeProviderRegistry,
    makeTestRuntimeProviderRegistry({
      list: Effect.succeed([source.provider]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
  const registry = ScratchRegistry.of({
    get: (id) => Effect.sync(() => entries.get(id)),
    list: () => Effect.sync(() => [...entries.values()]),
    read: () => Effect.sync(() => ({ version: 2, entries: [...entries.values()] })),
    upsert: (...write) =>
      (write[0] === "mark-running" ? registration : Effect.void).pipe(
        Effect.andThen(planScratchRegistryWrite(entries.get(write[1].id), ...write)),
        Effect.map((plan) => {
          if (plan._tag === "Set") entries.set(plan.value.id, plan.value);
          return undefined;
        }),
      ),
    remove: (id) =>
      Effect.sync(() => {
        entries.delete(id);
      }),
  });
  const config = Schema.decodeUnknownSync(GlobalConfig)(
    defaultDomain === undefined ? {} : { proxy: { defaultDomain } },
  );
  const dependencies = Layer.mergeAll(
    PrivateFileAccessService.layer,
    router === undefined ? layerUnavailable : Layer.succeed(RouterService, router),
    Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: (key) => Effect.succeed(config[key]),
      }),
    ),
    FileSystem.layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(StateStore, makeStateStore({ privateFileAccess: ownerOnlyFileAccess })),
    testEnvironmentResolverLayer,
    emptySnapshotsLayer,
    providers,
    ScratchResourceScanner.layer.pipe(Layer.provide(providers)),
    Layer.succeed(ScratchRegistry, registry),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: (landofile, _capabilities, options) =>
          (options?.kind === "scratch" ? (planScratch ?? Effect.void) : Effect.void).pipe(
            Effect.as({
              ...source,
              id: AppId.make(landofile.document.name ?? source.name),
              name: landofile.document.name ?? source.name,
              valueModel: 1 as const,
            }),
          ),
      }),
    ),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(
          literalTestLandofile(
            {
              name: "source",
              runtime: 4,
              services: {},
            },
            sourceRoot,
          ),
        ),
      }),
    ),
    Layer.succeed(
      Scratch.ScratchInitAppPort,
      Scratch.ScratchInitAppPort.of({
        initApp: () => Promise.reject(new TypeError("Recipe acquisition is not used")),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
            onEvent?.(event);
          }).pipe(
            Effect.andThen(eventFailure?.event === event._tag ? Effect.fail(eventFailure) : Effect.void),
          ),
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.die("unused"),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
  );
  return {
    root,
    sourceRoot,
    entries,
    events,
    destroyed,
    applied,
    layer: Scratch.layer.pipe(Layer.provideMerge(dependencies)),
  };
};
