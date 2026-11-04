import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { dataHelperImage } from "@lando/container-runtime/data-plane";
import {
  APP_LABEL,
  APP_ROOT_LABEL,
  PROVIDER_LABEL,
  SNAPSHOT_ID_LABEL,
  SNAPSHOT_STORE_LABEL,
  STORE_LABEL,
  VOLUME_OWNER_LABEL,
  VOLUME_SELECTOR_LABEL,
  VOLUME_SNAPSHOT_LABEL,
} from "@lando/container-runtime/labels";
import * as BunDataMover from "@lando/data-mover/service";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeLandoPaths } from "@lando/paths";
import { makePodmanApiClient, layer as providerLayer } from "@lando/provider-lando";
import { RedactionService } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  PortablePath,
  ProviderId,
  type VolumeSnapshotRef,
  appIdentityKey,
} from "@lando/sdk/schema";
import {
  DataMover,
  EventService,
  type LandoEvent,
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import * as StateStoreLayer from "@lando/state-store/service";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

// Live proof for the provider data plane (#1448): snapshot, restore, and removal run against the
// real engine behind the live socket, with every resource uniquely named and removed on exit.
// The provider attaches to the already-running engine through its API client only; the test never
// starts, stops, or reconfigures the runtime.

const live = resolveLiveProviderSocket();
const textEncoder = new TextEncoder();
const unique = () => crypto.randomUUID().slice(0, 8);
const absolute = (path: string) => Schema.decodeUnknownSync(AbsolutePath)(path);
const nativeSnapshotImage = (id: string) => `localhost/lando-volume-snapshot:${id.toLowerCase()}`;

const stdinOf = (text: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield textEncoder.encode(text);
  },
});

const imageLabels = Schema.fromJsonString(
  Schema.Struct({
    Config: Schema.optionalKey(
      Schema.Struct({
        Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
      }),
    ),
    Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  }),
);

const silentEvents = Layer.succeed(
  EventService,
  EventService.of({
    publish: () => Effect.void,
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.die("live snapshot test does not wait for events"),
    subscribeWithHistory: () => Effect.never,
    waitForAny: () => Effect.die("live snapshot test does not wait for events"),
    query: () => Effect.succeed([]),
  }),
);

const passthroughRedaction = RedactionService.layer;

const stateStoreLayer = StateStoreLayer.layer.pipe(Layer.provide(BunProcessRunner.layer));

/**
 * The live provider for one test: a uniquely named app and volume, an applied-plan-free owner plan
 * injected into every helper run, and scoped finalizers that remove the volume and temp directory.
 */
const liveFixture = Effect.gen(function* () {
  const socketPath = live?.socketPath ?? "";
  const base = yield* RuntimeProvider.pipe(
    Effect.provide(
      providerLayer({
        sanitizeAppliedPlan: stripHostProxyRunLando,
        platform: "linux",
        podmanApi: makePodmanApiClient(socketPath),
        appliedPlanState: makePluginStateStore(
          makeTestStateStore().service,
          AbsolutePath.make(join(tmpdir(), `lando-vol-snapshot-${crypto.randomUUID()}`)),
          ownerOnlyFileAccess,
        ),
      }),
    ),
  );
  const suffix = unique();
  const app = AppId.make(`snaprt-${suffix}`);
  const store = `snaprt-data-${suffix}`;
  const appRoot = absolute(`/tmp/lando-snaprt-${suffix}`);
  const plan = Schema.decodeUnknownSync(AppPlan)({
    id: app,
    name: String(app),
    slug: String(app),
    root: appRoot,
    provider: base.id,
    services: {},
    routes: [],
    stores: [{ name: store, scope: "app", kind: "data" }],
    fileSync: [],
    identity: { appRoot, ownerKey: appIdentityKey("owner", appRoot) },
    extensions: {},
    metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: join(appRoot, ".lando.yml"), runtime: 4 },
  });
  const helperImages: string[] = [];
  const pulledDigests: Array<string | undefined> = [];
  // Mounted data-store runs need the owning plan; supply it instead of applying (and starting) an app.
  const provider = RuntimeProvider.of({
    ...base,
    pullArtifact: (spec) =>
      base.pullArtifact(spec).pipe(Effect.tap((ref) => Effect.sync(() => pulledDigests.push(ref.digest)))),
    run: (spec) => {
      helperImages.push(spec.image);
      return base.run({ ...spec, owner: { ...spec.owner, app, plan } });
    },
    runStream: (spec) => {
      helperImages.push(spec.image);
      return base.runStream({ ...spec, owner: { ...spec.owner, app, plan } });
    },
  });
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lando-vol-snapshot-roundtrip-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  yield* Effect.addFinalizer(() =>
    provider.listVolumes({ app, store }).pipe(
      Effect.flatMap((volumes) =>
        Effect.forEach(
          volumes.filter((volume) => volume.ref.store === store && volume.instanceId !== undefined),
          (volume) => provider.removeVolume(volume.ref, volume.instanceId ?? ""),
          { discard: true },
        ),
      ),
      Effect.catch((cause) => Effect.logWarning("live volume cleanup failed", { store, cause })),
    ),
  );
  const helper = yield* provider.pullArtifact({ ref: dataHelperImage.ref, policy: "missing" });
  const write = (text: string) =>
    provider
      .run({
        image: helper.ref,
        command: ["sh", "-c", "cat > /data/payload"],
        mounts: [{ type: "volume", store, target: PortablePath.make("/data"), readOnly: false }],
        stdinStream: stdinOf(text),
        remove: true,
      })
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result.exitCode).toBe(0))));
  const read = provider
    .run({
      image: helper.ref,
      command: ["sh", "-c", "cat /data/payload"],
      mounts: [{ type: "volume", store, target: PortablePath.make("/data"), readOnly: true }],
      captureStdout: true,
      remove: true,
    })
    .pipe(Effect.map((result) => result.stdout));
  const removeSnapshot = (snapshot: VolumeSnapshotRef) =>
    provider.removeVolumeSnapshot === undefined
      ? Effect.die(new Error("provider cannot remove volume snapshots"))
      : provider.removeVolumeSnapshot(snapshot);
  const generation = provider.listVolumes({ app, store }).pipe(
    Effect.map((volumes) => volumes.find((volume) => volume.ref.store === store)?.instanceId),
    Effect.flatMap((instanceId) =>
      instanceId === undefined
        ? Effect.die(new Error(`volume ${store} has no generation`))
        : Effect.succeed(instanceId),
    ),
  );
  return {
    socketPath,
    provider,
    app,
    store,
    appRoot,
    root,
    helperImages,
    pulledDigests,
    write,
    read,
    removeSnapshot,
    generation,
  };
});

describe("live volume snapshot round trip", () => {
  test.skipIf(live === undefined)(
    "native snapshot labels, restore, and idempotent removal against the live engine",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fx = yield* liveFixture;
            const api = makePodmanApiClient(fx.socketPath);
            const snapshotId = `snaprt-${unique()}`;
            const inspectLabels = Effect.gen(function* () {
              if (api.request === undefined)
                return yield* Effect.die(new Error("engine API has no request client"));
              const response = yield* api.request({
                method: "GET",
                path: `/images/${encodeURIComponent(nativeSnapshotImage(snapshotId))}/json`,
              });
              if (response.status === 404) return undefined;
              expect(response.status).toBe(200);
              const decoded = Schema.decodeUnknownSync(imageLabels)(response.body);
              return decoded.Config?.Labels ?? decoded.Labels ?? {};
            });

            // Given: a volume holding known bytes.
            yield* fx.write("original-bytes");
            expect(yield* fx.read).toBe("original-bytes");
            const generation = yield* fx.generation;

            // Provider labels come from the data plane; the caller adds DataMover's own labels and
            // tries to forge reserved ones.
            const snapshot = yield* fx.provider.snapshotVolume({
              volume: { app: fx.app, store: fx.store },
              snapshotId,
              labels: {
                "dev.lando.test": "caller-value",
                [SNAPSHOT_STORE_LABEL]: "store-key",
                [APP_ROOT_LABEL]: fx.appRoot,
                [VOLUME_SNAPSHOT_LABEL]: "FALSE",
                [SNAPSHOT_ID_LABEL]: "forged-id",
                [APP_LABEL]: "forged-app",
                [STORE_LABEL]: "forged-store",
                [PROVIDER_LABEL]: "forged-provider",
                [VOLUME_OWNER_LABEL]: "/forged/root",
                [VOLUME_SELECTOR_LABEL]: "forged",
              },
            });
            yield* Effect.addFinalizer(() =>
              fx
                .removeSnapshot(snapshot)
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("live snapshot cleanup failed", { snapshotId, cause }),
                  ),
                ),
            );

            // Then: the committed image carries the provider's labels, DataMover's pass through, and
            // no ownership proof leaks onto it.
            expect(snapshot).toMatchObject({ provider: "lando", id: snapshotId, format: "native" });
            const labels = yield* inspectLabels;
            expect(labels).toMatchObject({
              [VOLUME_SNAPSHOT_LABEL]: "TRUE",
              [SNAPSHOT_ID_LABEL]: snapshotId,
              [APP_LABEL]: String(fx.app),
              [STORE_LABEL]: fx.store,
              [PROVIDER_LABEL]: "lando",
              [SNAPSHOT_STORE_LABEL]: "store-key",
              [APP_ROOT_LABEL]: fx.appRoot,
              "dev.lando.test": "caller-value",
            });
            expect(labels).not.toHaveProperty(VOLUME_OWNER_LABEL);
            expect(labels).not.toHaveProperty(VOLUME_SELECTOR_LABEL);

            // When: the volume changes and the snapshot is restored over it.
            yield* fx.write("mutated-bytes");
            expect(yield* fx.read).toBe("mutated-bytes");
            yield* fx.provider.restoreVolume({
              snapshot,
              target: { app: fx.app, store: fx.store },
              expectedTargetGeneration: generation,
              overwrite: true,
            });

            // Then: the original bytes are back.
            expect(yield* fx.read).toBe("original-bytes");

            // When: the snapshot is removed twice.
            yield* fx.removeSnapshot(snapshot);
            yield* fx.removeSnapshot(snapshot);

            // Then: the second removal was a no-op and the image is gone.
            expect(yield* inspectLabels).toBeUndefined();
          }),
        ),
      );
    },
    180_000,
  );

  test.skipIf(live === undefined)(
    "DataMover copy-mode snapshot and restore run the pinned data helper",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fx = yield* liveFixture;
            const volume = { app: fx.app, store: fx.store };
            const paths = makeLandoPaths({
              userDataRoot: join(fx.root, "data"),
              userCacheRoot: join(fx.root, "cache"),
              userConfRoot: join(fx.root, "conf"),
              env: {},
            });

            const mover = yield* DataMover.pipe(
              Effect.provide(
                BunDataMover.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      stateStoreLayer,
                      silentEvents,
                      passthroughRedaction,
                      Layer.succeed(PathsService, PathsService.of(paths)),
                      Layer.succeed(RuntimeProviderRegistry, {
                        appliedPlansFor: () => Effect.succeed([]),
                        resolveAppliedPlan: () => Effect.succeed(undefined),
                        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
                        list: Effect.succeed([ProviderId.make(fx.provider.id)]),
                        capabilities: Effect.succeed(fx.provider.capabilities),
                        select: () => Effect.succeed(fx.provider),
                      }),
                    ),
                  ),
                ),
              ),
            );

            // Given: a volume seeded through the provider. Host paths stay out of this case:
            // DataMover confines them to a discovered app root, and this temp tree has none.
            yield* fx.write("dm-original");
            fx.helperImages.length = 0;
            fx.pulledDigests.length = 0;

            // When: a copy-mode snapshot is taken, the volume changes, and the snapshot is restored.
            const handle = yield* mover
              .snapshot(volume, { volumeSnapshot: "copy", format: "tar" })
              .pipe(Effect.provideService(RuntimeProvider, fx.provider));
            yield* Effect.addFinalizer(() =>
              mover.removeSnapshot(handle).pipe(
                Effect.provideService(RuntimeProvider, fx.provider),
                Effect.catch((cause) =>
                  Effect.logWarning("live DataMover snapshot cleanup failed", { id: handle.id, cause }),
                ),
              ),
            );
            yield* fx.write("dm-mutated");
            yield* mover.restore(handle, volume).pipe(Effect.provideService(RuntimeProvider, fx.provider));

            // Then: the original bytes are restored from the host archive.
            expect(yield* fx.read).toBe("dm-original");

            // And: the copy helper ran from the pinned digest ref, which the provider verified.
            expect(fx.helperImages.length).toBeGreaterThan(0);
            expect(new Set(fx.helperImages)).toEqual(new Set([dataHelperImage.ref]));
            expect(new Set(fx.pulledDigests)).toEqual(new Set([dataHelperImage.digest]));
          }),
        ),
      );
    },
    180_000,
  );
});
