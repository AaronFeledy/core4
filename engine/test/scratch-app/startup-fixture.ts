import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScratchAppError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  type LandoEvent,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Stream } from "effect";
import { ScratchRegistry, type ScratchRegistryEntry } from "../../src/scratch-app/registry.ts";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";
import * as Scratch from "../../src/scratch-app/service.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
import { emptySnapshotsLayer } from "../operations/data-mover-support.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";

export const withStartupFixture = async (
  overrides: Partial<Pick<RuntimeProviderShape, "inspect" | "exec" | "apply">>,
  use: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
  registration: Effect.Effect<void, ScratchAppError> = Effect.void,
) => {
  const root = await mkdtemp(join(tmpdir(), "scratch-startup-"));
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = root;
  try {
    await use(await makeFixture(root, overrides, registration));
  } finally {
    if (process.env.LANDO_USER_CACHE_ROOT === root) {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
      else process.env.LANDO_USER_CACHE_ROOT = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
};

const makeFixture = async (
  root: string,
  overrides: Partial<RuntimeProviderShape>,
  registration: Effect.Effect<void, ScratchAppError>,
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
    routes: [],
    router: { enabled: false },
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
    read: () => Effect.sync(() => ({ version: 1, entries: [...entries.values()] })),
    upsert: (entry) =>
      (entry.status === "running" ? registration : Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            entries.set(entry.id, entry);
          }),
        ),
      ),
    remove: (id) =>
      Effect.sync(() => {
        entries.delete(id);
      }),
  });
  const dependencies = Layer.mergeAll(
    FileSystem.layer,
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
