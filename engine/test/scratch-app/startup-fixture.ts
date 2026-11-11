import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import type { ScratchAppError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan } from "@lando/sdk/schema";
import {
  AppPlanner,
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
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer, Stream } from "effect";
import {
  ScratchRegistry,
  type ScratchRegistryEntry,
  planScratchRegistryWrite,
} from "../../src/scratch-app/registry.ts";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";
import * as Scratch from "../../src/scratch-app/service.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
import { emptySnapshotsLayer } from "../operations/data-mover-support.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

interface StartupFixtureOptions {
  /** Runs before the registry records the scratch app as running. */
  readonly registration?: Effect.Effect<void, ScratchAppError>;
  /** Publishes a route for `web` and starts through this router. */
  readonly router?: RouterServiceShape;
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
  { registration = Effect.void, router }: StartupFixtureOptions,
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
      router === undefined
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
          ],
    router: { enabled: router !== undefined },
    services: {
      [web.name]: {
        ...web,
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
    destroy: (target, options) =>
      Effect.sync(() => {
        if (options.removeState === true) destroyed.push(String(target.app));
        return { kind: "destroyed" as const };
      }),
    ...overrides,
  };
  const providers = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      appliedPlansFor: () => Effect.succeed([]),
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
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
  const dependencies = Layer.mergeAll(
    router === undefined ? Layer.empty : Layer.succeed(RouterService, router),
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
        plan: (landofile) =>
          Effect.succeed({
            ...source,
            id: AppId.make(landofile.document.name ?? source.name),
            name: landofile.document.name ?? source.name,
            valueModel: 1 as const,
          }),
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
          }),
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
