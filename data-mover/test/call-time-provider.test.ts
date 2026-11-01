import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import { runtimeProviderService } from "@lando/engine/runtime/bootstrap-layer-support";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type VolumeSnapshotArtifact,
} from "@lando/sdk/schema";
import {
  DataMover,
  EventService,
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as StateStoreLayer from "@lando/state-store/service";
import { layer as dataMoverLayer } from "../src/service.ts";
import * as BunDataMover from "./support.ts";
const stateStoreLayer = StateStoreLayer.layer.pipe(Layer.provide(BunProcessRunner.layer));

const app = AppId.make("data-app");
const service = ServiceName.make("web");
const absolute = (path: string) => Schema.decodeUnknownSync(AbsolutePath)(path);

const silentEvents = Layer.succeed(
  EventService,
  EventService.of({
    publish: () => Effect.void,
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.never,
    waitFor: () => Effect.never,
    subscribeWithHistory: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  }),
);

const passthroughRedaction = RedactionService.layer;

describe("BunDataMover.layer call-time provider", () => {
  test.each(["none", "select", "appliedPlans"] as const)(
    "selects the app plan past an unrelated provider's %s failure instead of accepting the bootstrap stub",
    async (broken) => {
      const dir = await mkdtemp(resolve(process.cwd(), ".tmp-data-selected-"));
      const target = resolve(dir, "selected.txt");
      const plan: AppPlan = {
        valueModel: 1,
        id: app,
        name: "Data app",
        slug: "data-app",
        root: absolute(dir),
        provider: ProviderId.make("selected"),
        services: {},
        routes: [],
        stores: [],
        fileSync: [],
        metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 },
        extensions: {},
      };
      const selected = RuntimeProvider.of({
        ...TestRuntimeProvider,
        id: "selected",
        appliedPlans: Effect.succeed([plan]),
        execStream: () =>
          Stream.make(
            { kind: "stdout" as const, chunk: new TextEncoder().encode("registry-output") },
            { exitCode: 0 },
          ),
      });
      const targets: Array<AppPlan | ProviderId | undefined> = [];
      const registry = RuntimeProviderRegistry.of({
        list: Effect.succeed(
          broken === "none"
            ? [ProviderId.make("selected")]
            : [ProviderId.make("broken"), ProviderId.make("selected")],
        ),
        capabilities: Effect.succeed(selected.capabilities),
        appliedPlansFor: () => Effect.succeed([plan]),
        resolveAppliedPlan: () => Effect.succeed(plan),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        select: (target) => {
          const failure = new ProviderUnavailableError({
            providerId: "broken",
            operation: broken,
            message: "Unrelated provider is offline.",
            remediation: "Repair the unrelated provider.",
          });
          if (target === "broken")
            return broken === "select"
              ? Effect.fail(failure)
              : Effect.succeed({ ...TestRuntimeProvider, appliedPlans: Effect.fail(failure) });
          return Effect.sync(() => {
            targets.push(target);
            return selected;
          });
        },
      });
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.flatMap(DataMover, (mover) =>
              mover.transfer({
                from: { _tag: "serviceCmd", app, service, command: ["export"] },
                to: { _tag: "hostPath", path: absolute(target) },
                overwrite: true,
              }),
            ),
          ).pipe(
            Effect.provideService(RuntimeProvider, runtimeProviderService),
            Effect.provide(
              dataMoverLayer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    stateStoreLayer,
                    silentEvents,
                    passthroughRedaction,
                    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: dir })),
                    Layer.succeed(RuntimeProviderRegistry, registry),
                  ),
                ),
              ),
            ),
          ),
        );
        expect(await readFile(target, "utf8")).toBe("registry-output");
        expect(targets).toContain(plan);
        expect(targets).not.toContain(undefined);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("discovers and removes orphan images through the call-time provider", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".tmp-snapshot-call-time-"));
    const removed: string[] = [];
    const image: VolumeSnapshotArtifact = {
      ref: { provider: "selected", id: "legacy", digest: "sha256:legacy", sizeBytes: 1, format: "native" },
      createdAt: DateTime.makeUnsafe(0),
      labels: {},
    };
    const selected = RuntimeProvider.of({
      ...TestRuntimeProvider,
      id: "selected",
      listVolumeSnapshots: () => Effect.succeed([image]),
      removeVolumeSnapshot: (ref) =>
        Effect.sync(() => {
          removed.push(ref.id);
        }),
    });
    try {
      const found = await Effect.runPromise(
        Effect.gen(function* () {
          const mover = yield* DataMover;
          const images = yield* mover.findOrphanedSnapshots;
          yield* Effect.forEach(images, mover.removeOrphanedSnapshot);
          return images;
        }).pipe(
          Effect.provideService(RuntimeProvider, selected),
          Effect.provide(
            BunDataMover.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  stateStoreLayer,
                  silentEvents,
                  passthroughRedaction,
                  Layer.succeed(PathsService, PathsService.of(makeLandoPaths({ userDataRoot: dir }))),
                  Layer.succeed(RuntimeProvider, {
                    ...TestRuntimeProvider,
                    listVolumeSnapshots: () => Effect.die("construction stub used"),
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      expect(found).toEqual([image]);
      expect(removed).toEqual(["legacy"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("uses the RuntimeProvider provided at call time, not the construction stub", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".tmp-data-mover-call-time-"));
    const target = resolve(dir, "out.txt");
    try {
      const stub = RuntimeProvider.of({
        ...TestRuntimeProvider,
        execStream: () => Stream.empty,
      });
      const selected = RuntimeProvider.of({
        ...TestRuntimeProvider,
        execStream: () =>
          Stream.fromIterable([
            { kind: "stdout" as const, chunk: new TextEncoder().encode("selected-output") },
            { exitCode: 0 },
          ]),
      });

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dataMover = yield* DataMover;
            yield* dataMover.transfer({
              from: { _tag: "serviceCmd", app, service, command: ["export-db"] },
              to: { _tag: "hostPath", path: absolute(target) },
              overwrite: true,
            });
          }),
        ).pipe(
          Effect.provideService(RuntimeProvider, selected),
          Effect.provide(
            BunDataMover.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  stateStoreLayer,
                  Layer.succeed(PathsService, PathsService.of(makeLandoPaths())),
                  Layer.succeed(RuntimeProvider, stub),
                  silentEvents,
                  passthroughRedaction,
                ),
              ),
            ),
          ),
        ),
      );

      expect(await readFile(target, "utf8")).toBe("selected-output");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
