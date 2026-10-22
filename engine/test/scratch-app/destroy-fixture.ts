import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderUnavailableError, ProxyError, ScratchAppError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  LandofileShape,
  ProviderId,
  type SnapshotInfo,
  planAppIdentity,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  DataMover,
  EventService,
  type LandoEvent,
  LandofileService,
  RouterService,
  RuntimeProviderRegistry,
  ScratchAppService,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";
import { MANAGED_PROVIDER_SELECT_PLAN } from "../../src/providers/managed.ts";
import { ScratchRegistry, type ScratchRegistryEntry } from "../../src/scratch-app/registry.ts";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";
import * as Scratch from "../../src/scratch-app/service.ts";
import * as FileSystem from "../../src/services/file-system.ts";

interface DestroyFixtureOptions {
  readonly orphan?: boolean;
  readonly cwd?: boolean;
  readonly fail?: boolean;
  readonly routeFail?: boolean;
  readonly copyFail?: boolean;
  readonly registryFail?: boolean;
}

export const withDestroyFixture = async (
  options: DestroyFixtureOptions,
  use: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "scratch-destroy-"));
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = root;
  try {
    await use(await makeFixture(root, options));
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
};

const makeFixture = async (root: string, options: DestroyFixtureOptions) => {
  const id = AppId.make("scratch-demo-123456");
  const instanceRoot = AbsolutePath.make(join(root, "scratch", id));
  const planRoot = AbsolutePath.make(options.cwd ? join(root, "source-app") : join(instanceRoot, "root"));
  const plan: AppPlan = {
    ...MANAGED_PROVIDER_SELECT_PLAN,
    id,
    name: id,
    root: planRoot,
    identity: planAppIdentity({ root: planRoot }),
  };
  const calls: string[] = [];
  const events: LandoEvent[] = [];
  const rootObservations: { readonly tag: string; readonly exists: boolean }[] = [];
  const snapshots: SnapshotInfo[] = [id, AppId.make("user-app")].map((app) => ({
    owner: planAppIdentity(plan),
    id: `${app}-snapshot`,
    store: { app, store: "data" },
    digest: "digest",
    sizeBytes: 1,
    createdAt: DateTime.makeUnsafe(0),
  }));
  const removed: string[] = [];
  const entries = new Map<string, ScratchRegistryEntry>();
  const entry: ScratchRegistryEntry = {
    id,
    rootPath: planRoot,
    source: { kind: "fork" },
    isolate: options.cwd ? "cwd" : "full",
    detached: false,
    ownerPid: 999999999,
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  if (!options.orphan) entries.set(id, entry);
  await mkdir(join(instanceRoot, "root"), { recursive: true });
  if (!options.orphan)
    await writeFile(join(instanceRoot, "plan.bin"), JSON.stringify(Schema.encodeSync(AppPlan)(plan)));
  const provider = {
    ...TestRuntimeProvider,
    destroy: (_target: unknown, request: { readonly volumes: boolean; readonly removeState?: boolean }) =>
      Effect.sync(() => {
        calls.push(request.removeState ? `destroy:${request.volumes}` : "stop");
        return { kind: "destroyed" as const };
      }).pipe(
        Effect.flatMap((outcome) =>
          options.fail && request.removeState
            ? Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "destroy",
                  message: "injected",
                }),
              )
            : Effect.succeed(outcome),
        ),
      ),
  };
  const providers = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
  const dependencies = Layer.mergeAll(
    FileSystem.layer,
    providers,
    ScratchResourceScanner.layer.pipe(Layer.provide(providers)),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(
          Schema.decodeUnknownSync(LandofileShape)({ name: "demo", runtime: 4, services: {} }),
        ),
      }),
    ),
    Layer.succeed(
      Scratch.ScratchInitAppPort,
      Scratch.ScratchInitAppPort.of({ initApp: () => Promise.reject(new TypeError("unused recipe")) }),
    ),
    Layer.succeed(
      ScratchRegistry,
      ScratchRegistry.of({
        get: (key) => Effect.sync(() => entries.get(key)),
        list: () => Effect.sync(() => [...entries.values()]),
        read: () => Effect.sync(() => ({ version: 1, entries: [...entries.values()] })),
        upsert: (value) =>
          Effect.sync(() => {
            calls.push("registry:upsert");
          }).pipe(
            Effect.andThen(() =>
              options.registryFail
                ? Effect.fail(
                    new ScratchAppError({ operation: "registry.write", message: "injected write failure" }),
                  )
                : Effect.sync(() => {
                    entries.set(value.id, value);
                  }),
            ),
          ),
        remove: (key) =>
          Effect.sync(() => {
            calls.push("registry");
            entries.delete(key);
          }),
      }),
    ),
    Layer.succeed(
      RouterService,
      RouterService.of({
        ...makeTestRouterService(),
        removeRoutes: () =>
          Effect.sync(() => {
            calls.push("routes");
          }).pipe(
            Effect.andThen(
              options.routeFail
                ? Effect.fail(new ProxyError({ proxyId: "test", message: "route failure" }))
                : Effect.void,
            ),
          ),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            calls.push(event._tag);
            events.push(event);
            if ("app" in event && event.app?.kind === "scratch")
              rootObservations.push({ tag: event._tag, exists: existsSync(event.app.root) });
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.die("unused queue"),
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(
      DataMover,
      DataMover.of({
        transfer: () =>
          options.copyFail
            ? Effect.fail(new ScratchAppError({ operation: "materialize", message: "injected copy failure" }))
            : Effect.die("unused transfer"),
        transferStream: () => Stream.empty,
        snapshot: () => Effect.die("unused snapshot"),
        restore: () => Effect.die("unused restore"),
        resolveSnapshot: () => Effect.die("unused resolve"),
        listSnapshots: (filter) =>
          Effect.sync(() => {
            calls.push("snapshots:list");
            return snapshots.filter((info) => info.owner.ownerKey === filter.ownerKey);
          }),
        removeSnapshot: (handle) =>
          Effect.sync(() => {
            calls.push("snapshot:remove");
            removed.push(handle.id);
          }),
        findOrphanedSnapshots: Effect.succeed([]),
        removeOrphanedSnapshot: () => Effect.void,
        pruneSnapshots: () => Effect.succeed([]),
      }),
    ),
  );
  return {
    id,
    entry,
    plan,
    instanceRoot,
    calls,
    events,
    rootObservations,
    removed,
    entries,
    layer: Scratch.layer.pipe(Layer.provide(dependencies)),
  };
};

export const runDestroy = (fixture: Awaited<ReturnType<typeof makeFixture>>, keepVolumes = false) =>
  Effect.runPromise(
    Effect.flatMap(ScratchAppService, (scratch) => scratch.destroy(fixture.id, { keepVolumes })).pipe(
      Effect.provide(fixture.layer),
    ),
  );
