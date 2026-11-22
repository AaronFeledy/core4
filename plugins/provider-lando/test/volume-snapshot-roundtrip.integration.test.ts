import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { encodeUstarHeader } from "@lando/container-runtime/tar";
import { volumeSnapshotCaptureCommand } from "@lando/container-runtime/volume-archive";
import * as BunDataMover from "@lando/data-mover/service";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeLandoPaths } from "@lando/paths";
import { makePodmanApiClient, layer as providerLayer } from "@lando/provider-lando";
import { RedactionService } from "@lando/redaction/service";
import { DataTransferError, VolumeOperationError } from "@lando/sdk/errors";
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
  type ExecResult,
  type LandoEvent,
  PathsService,
  type ProviderError,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import * as StateStoreLayer from "@lando/state-store/service";
import { Effect, Fiber, Layer, Queue, Schema, type Scope, Stream } from "effect";
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
        socketPath,
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
  const helperScript = (script: string) =>
    provider.run({
      image: helper.ref,
      command: ["sh", "-c", script],
      mounts: [{ type: "volume", store, target: PortablePath.make("/data"), readOnly: false }],
      captureStdout: true,
      remove: true,
    });
  const writeTree = helperScript(
    [
      "mkdir -p /data/nested/child",
      "printf 'dm-original' > /data/app.txt",
      "chown 999:999 /data/app.txt",
      "printf 'nested-value' > /data/nested/child/value.txt",
      "chmod 0700 /data/nested",
      "ln -sf app.txt /data/link",
      "printf 'witness-target' > /data/.lando-volume-witness.json",
      "mkdir -p /data/.lando-witness-stage-target",
      "printf 'stage-target' > /data/.lando-witness-stage-target/record",
    ].join(" && "),
  ).pipe(Effect.tap((result) => Effect.sync(() => expect(result.exitCode).toBe(0))));
  const readTree = helperScript(
    [
      "stat -c '%n|%u|%a|%F' /data /data/app.txt /data/nested /data/link",
      "echo ---",
      "ls -lanR /data",
      "echo ---",
      "cat /data/app.txt",
      "echo",
      "cat /data/nested/child/value.txt",
      "echo",
      "test -e /data/target-only.txt && echo TARGET-ONLY-PRESENT || echo TARGET-ONLY-ABSENT",
      "echo ---",
      "cat /data/.lando-volume-witness.json 2>/dev/null || echo NO-WITNESS",
      "echo ---",
      "cat /data/.lando-witness-stage-target/record 2>/dev/null || echo NO-STAGING",
    ].join("; "),
  ).pipe(Effect.map((result) => result.stdout));
  const mutateTree = helperScript(
    "printf 'dm-mutated' > /data/app.txt && printf 'target-only' > /data/target-only.txt && printf 'witness-mutated' > /data/.lando-volume-witness.json && printf 'stage-mutated' > /data/.lando-witness-stage-target/record",
  ).pipe(Effect.tap((result) => Effect.sync(() => expect(result.exitCode).toBe(0))));
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
    writeTree,
    readTree,
    mutateTree,
    removeSnapshot,
    generation,
  };
});

const textDecoder = new TextDecoder();

const tarEntryNames = (archive: Uint8Array): ReadonlyArray<string> => {
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string => {
      const bytes = header.subarray(start, start + length);
      const end = bytes.indexOf(0);
      return textDecoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
    };
    const size = Number.parseInt(field(124, 12) || "0", 8);
    const prefix = field(345, 155);
    const name = field(0, 100);
    names.push(prefix.length > 0 ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
};

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

  test.each(["tar", "tar.gz", "tar.zst"] as const).skipIf(live === undefined)(
    "DataMover copy-mode snapshot and restore run the pinned data helper (%s)",
    async (format) => {
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
                        readAppliedPlanStrict: () => Effect.succeed(undefined),
                        appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
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

            // Given: a volume holding a directory tree. Host paths stay out of this case:
            // DataMover confines them to a discovered app root, and this temp tree has none.
            yield* fx.writeTree;
            fx.helperImages.length = 0;
            fx.pulledDigests.length = 0;

            // When: a copy-mode snapshot is taken, the volume changes, and the snapshot is restored.
            const handle = yield* mover
              .snapshot(volume, { volumeSnapshot: "copy", format })
              .pipe(Effect.provideService(RuntimeProvider, fx.provider));
            yield* Effect.addFinalizer(() =>
              mover.removeSnapshot(handle).pipe(
                Effect.provideService(RuntimeProvider, fx.provider),
                Effect.catch((cause) =>
                  Effect.logWarning("live DataMover snapshot cleanup failed", { id: handle.id, cause }),
                ),
              ),
            );
            // And: the stored archive is the tree itself, with no payload envelope and no
            // ownership witness or staging entries.
            const archivePath = join(paths.snapshotsDir, handle.ownerKey, fx.store, `${handle.id}.${format}`);
            const stored = new Uint8Array(yield* Effect.promise(() => Bun.file(archivePath).arrayBuffer()));
            const tar =
              format === "tar"
                ? stored
                : format === "tar.gz"
                  ? Bun.gunzipSync(stored)
                  : Bun.zstdDecompressSync(stored);
            const names = tarEntryNames(tar);
            expect(names).toContain("./app.txt");
            expect(names).toContain("./nested/child/value.txt");
            expect(names).toContain("./link");
            expect(names.some((name) => name.includes(".lando-volume-witness.json"))).toBe(false);
            expect(names.some((name) => name.includes(".lando-witness-stage"))).toBe(false);
            expect(names).not.toContain("payload");

            yield* fx.mutateTree;
            yield* mover.restore(handle, volume).pipe(Effect.provideService(RuntimeProvider, fx.provider));

            // Then: the whole tree is restored, the post-snapshot file is gone, and the target
            // witness survives the import.
            const tree = yield* fx.readTree;
            expect(tree).toContain("dm-original");
            expect(tree).toContain("nested-value");
            expect(tree).toContain("TARGET-ONLY-ABSENT");
            expect(tree).toContain("witness-mutated");
            expect(tree).not.toContain("witness-target");
            expect(tree).toContain("stage-mutated");
            expect(tree).toContain("/data/app.txt|999|644|regular file");
            expect(tree).toContain("/data/nested|0|700|directory");
            expect(tree).toContain("link -> app.txt");

            // And: the provider data plane acquired and ran the pinned helper itself; the archive
            // assertions above prove the archive path, and helper verification is unit-tested.
          }),
        ),
      );
    },
    180_000,
  );
});

const tarArchive = (
  members: ReadonlyArray<{
    readonly name: string;
    readonly data?: string;
    readonly typeflag?: "0" | "2" | "5";
    readonly linkName?: string;
    readonly mode?: number;
    readonly uid?: number;
  }>,
): Uint8Array => {
  const blocks: Uint8Array[] = [];
  for (const member of members) {
    const payload = textEncoder.encode(member.data ?? "");
    const header = encodeUstarHeader(
      {
        name: member.name,
        size: payload.byteLength,
        mode: member.mode ?? 0o644,
        typeflag: member.typeflag ?? "0",
        ...(member.linkName === undefined ? {} : { linkName: member.linkName }),
        uid: member.uid ?? 0,
        gid: member.uid ?? 0,
        mtime: 0,
      },
      { longNames: "ustar-prefix" },
    );
    blocks.push(header);
    if (payload.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(payload.byteLength / 512) * 512);
      padded.set(payload);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.byteLength;
  }
  return output;
};

const helperFor = (
  fx: { readonly provider: RuntimeProviderShape },
  store: string,
  script: string,
  target = "/data",
): Effect.Effect<ExecResult, ProviderError, Scope.Scope> =>
  fx.provider.run({
    image: dataHelperImage.ref,
    command: ["sh", "-c", script],
    mounts: [{ type: "volume", store, target: PortablePath.make(target), readOnly: false }],
    captureStdout: true,
    remove: true,
  });

const archiveStream = (bytes: Uint8Array) => Stream.make(bytes);

describe("live volume archive data plane", () => {
  test.skipIf(live === undefined)(
    "export and staged import preserve tree contents, ownership, hardlinks, fifos, and the witness",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fx = yield* liveFixture;
            const volume = { app: fx.app, store: fx.store };
            const treeScript = [
              "mkdir -p /data/nested/deep",
              "printf 'alpha' > /data/app.txt",
              "chown 999:999 /data/app.txt",
              "printf 'deep' > /data/nested/deep/value.txt",
              "chmod 0700 /data/nested",
              "chmod 0750 /data",
              "ln -sf app.txt /data/link",
              "ln /data/app.txt /data/hard.txt",
              "mkfifo /data/fifo",
              "printf 'space' > '/data/name with space.txt'",
              "printf 'dash' > /data/-leading.txt",
              "printf 'witness-bytes' > /data/.lando-volume-witness.json",
              "stat -c '%n|%i|%u|%g|%a' /data /data/app.txt /data/hard.txt /data/.lando-volume-witness.json",
            ].join(" && ");
            const created = yield* helperFor(fx, fx.store, treeScript);
            expect(created.exitCode).toBe(0);
            const before: string[] = created.stdout.trim().split("\n");
            const appBefore = before.find((line) => line.startsWith("/data/app.txt|"));
            const hardBefore = before.find((line) => line.startsWith("/data/hard.txt|"));
            const witnessBefore = before.find((line) => line.startsWith("/data/.lando-volume-witness.json|"));
            if (appBefore === undefined || hardBefore === undefined || witnessBefore === undefined) {
              throw new Error(`unexpected stat output: ${created.stdout}`);
            }
            expect(appBefore.split("|")[1]).toBe(hardBefore.split("|")[1]);

            const archive = yield* Stream.runCollect(fx.provider.exportVolume(volume)).pipe(
              Effect.map((chunks) => {
                const total = Array.from(chunks).reduce((sum, chunk) => sum + chunk.byteLength, 0);
                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                  bytes.set(chunk, offset);
                  offset += chunk.byteLength;
                }
                return bytes;
              }),
            );

            // Mutate live data between export and import.
            const mutated = yield* helperFor(
              fx,
              fx.store,
              "rm -f /data/app.txt /data/hard.txt /data/fifo && printf 'mutated' > /data/mutated.txt",
            );
            expect(mutated.exitCode).toBe(0);

            yield* Effect.scoped(
              fx.provider.importVolume<never, never>({
                target: volume,
                archive: archiveStream(archive),
                beforeCommit: Effect.void,
              }),
            );

            const after = yield* helperFor(
              fx,
              fx.store,
              [
                "stat -c '%n|%i|%u|%g|%a' /data /data/nested /data/app.txt /data/hard.txt /data/.lando-volume-witness.json",
                "cat /data/app.txt",
                "echo",
                "cat /data/nested/deep/value.txt",
                "echo",
                "cat '/data/name with space.txt'",
                "echo",
                "cat /data/-leading.txt",
                "echo",
                "test -p /data/fifo && echo FIFO",
                "test -e /data/mutated.txt && echo MUTATED || echo CLEAN",
                "ls -a /data | grep -E '^\\.lando-(import|replaced)-' || echo NO-LEFTOVERS",
              ].join("; "),
            );
            expect(after.exitCode).toBe(0);
            expect(after.stdout).toContain("alpha");
            expect(after.stdout).toContain("deep");
            expect(after.stdout).toContain("space");
            expect(after.stdout).toContain("dash");
            expect(after.stdout).toContain("FIFO");
            expect(after.stdout).toContain("CLEAN");
            expect(after.stdout).toContain("NO-LEFTOVERS");
            const afterLines: string[] = after.stdout.trim().split("\n");
            const afterApp = afterLines.find((line) => line.startsWith("/data/app.txt|"));
            const afterHard = afterLines.find((line) => line.startsWith("/data/hard.txt|"));
            // Inodes are allocated afresh, but the two hardlinked entries must still share one.
            expect(afterApp?.split("|").slice(2)).toEqual(appBefore.split("|").slice(2));
            expect(afterHard?.split("|")[1]).toBe(afterApp?.split("|")[1]);
            expect(afterLines.find((line) => line.startsWith("/data/.lando-volume-witness.json|"))).toBe(
              witnessBefore,
            );
            expect(afterLines.find((line) => line.startsWith("/data|"))).toContain("|0|0|750");
            expect(afterLines.find((line) => line.startsWith("/data/nested|")) ?? "").toContain("|700");
          }),
        ),
      );
    },
    180_000,
  );

  test.skipIf(live === undefined)(
    "unsafe archives, source failures, and interruption leave the live volume unchanged",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fx = yield* liveFixture;
            const volume = { app: fx.app, store: fx.store };
            const seeded = yield* helperFor(fx, fx.store, "printf 'stable' > /data/app.txt");
            expect(seeded.exitCode).toBe(0);
            const safe = tarArchive([{ name: "app.txt", data: "replacement" }]);

            const parentEscape = tarArchive([{ name: "../escape.txt", data: "escape" }]);
            const absolute = tarArchive([{ name: "/etc/escape.txt", data: "escape" }]);
            const reserved = tarArchive([{ name: ".lando-volume-witness.json", data: "forged" }]);
            const truncated = safe.subarray(0, 700);

            for (const archive of [parentEscape, absolute, reserved, truncated]) {
              const result = yield* Effect.result(
                Effect.scoped(
                  fx.provider.importVolume<void, never>({
                    target: volume,
                    archive: archiveStream(archive),
                    beforeCommit: Effect.void,
                  }),
                ),
              );
              expect(result._tag).toBe("Failure");
            }

            const sourceFailure = new DataTransferError({
              message: "source failed after tar bytes",
              operation: "read",
              remediation: "Retry the transfer.",
            });
            const failedSource = yield* Effect.result(
              Effect.scoped(
                fx.provider.importVolume<DataTransferError, never>({
                  target: volume,
                  archive: Stream.concat(Stream.make(safe), Stream.fail(sourceFailure)),
                  beforeCommit: Effect.void,
                }),
              ),
            );
            expect(failedSource).toMatchObject({ _tag: "Failure", failure: sourceFailure });

            const fiber = Effect.runFork(
              Effect.scoped(
                fx.provider.importVolume<never, never>({
                  target: volume,
                  archive: Stream.concat(
                    Stream.make(safe),
                    Stream.fromEffect(Effect.sleep("10 seconds")).pipe(Stream.drain),
                  ),
                  beforeCommit: Effect.die("must not commit"),
                }),
              ),
            );
            yield* Effect.sleep("750 millis");
            yield* Fiber.interrupt(fiber);

            const after = yield* helperFor(
              fx,
              fx.store,
              "cat /data/app.txt; echo; ls -a /data | grep -E '^\\.lando-import-' || echo NO-STAGING",
            );
            expect(after.stdout).toContain("stable");
            expect(after.stdout).not.toContain("replacement");
            expect(after.stdout).toContain("NO-STAGING");
          }),
        ),
      );
    },
    180_000,
  );

  test.skipIf(live === undefined)(
    "an unmappable archive uid either succeeds with a readable file or fails unchanged",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fx = yield* liveFixture;
            const seeded = yield* helperFor(fx, fx.store, "printf 'stable' > /data/app.txt");
            expect(seeded.exitCode).toBe(0);
            const unmapped = tarArchive([{ name: "app.txt", data: "unmapped", uid: 1_234_567 }]);

            const result = yield* Effect.result(
              Effect.scoped(
                fx.provider.importVolume<never, never>({
                  target: { app: fx.app, store: fx.store },
                  archive: archiveStream(unmapped),
                  beforeCommit: Effect.void,
                }),
              ),
            );

            // Rootless Podman maps only a uid range into the user namespace. Busybox tar cannot
            // chown an unmapped numeric uid: the import either succeeds because tar preserved the
            // bytes and warned, or it fails and leaves the previous contents in place. It must never
            // leave staging behind or expose a half-written tree.
            const contents = yield* helperFor(
              fx,
              fx.store,
              "cat /data/app.txt; echo; ls -a /data | grep -E '^\\.lando-(import|replaced)-' || echo NO-LEFTOVERS",
            );
            expect(contents.exitCode).toBe(0);
            expect(contents.stdout).toContain("NO-LEFTOVERS");
            if (result._tag === "Success") {
              expect(contents.stdout).toContain("unmapped");
            } else {
              expect(result.failure).toBeInstanceOf(VolumeOperationError);
              expect(contents.stdout).toContain("stable");
            }
          }),
        ),
      );
    },
    180_000,
  );

  test.skipIf(live === undefined)(
    "the capture pipeline reports a failing tar producer",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fx = yield* liveFixture;
            const seeded = yield* helperFor(fx, fx.store, "printf 'pipefail' > /data/app.txt");
            expect(seeded.exitCode).toBe(0);
            const script = volumeSnapshotCaptureCommand()[2] ?? "";
            if (!script.includes("set -o pipefail")) throw new Error("capture script lost pipefail");
            const shim = [
              "mkdir -p /tmp/shim",
              'printf \'#!/bin/sh\\nif [ "$1" = "-cf" ]; then /bin/tar "$@"; exit 7; fi\\nexec /bin/tar "$@"\\n\' > /tmp/shim/tar',
              "chmod +x /tmp/shim/tar",
              "PATH=/tmp/shim:$PATH",
            ].join("; ");
            const withoutPipefail = yield* helperFor(
              fx,
              fx.store,
              `${shim}; ${script.replace("set -o pipefail\n", "")}`,
              "/lando-data",
            );
            expect(withoutPipefail.exitCode).toBe(0);
            const withPipefail = yield* helperFor(fx, fx.store, `${shim}; ${script}`, "/lando-data");
            expect(withPipefail.exitCode).not.toBe(0);
          }),
        ),
      );
    },
    180_000,
  );

  test.skipIf(live === undefined)(
    "reconciliation finishes a publication that crossed the commit point",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fx = yield* liveFixture;
            const id = crypto.randomUUID();
            const planted = yield* helperFor(
              fx,
              fx.store,
              [
                "printf 'old-live' > /data/old.txt",
                `mkdir /data/.lando-import-${id} /data/.lando-replaced-${id}`,
                `printf 'new' > /data/.lando-import-${id}/new.txt`,
                `printf 'old' > /data/.lando-replaced-${id}/old.txt`,
              ].join(" && "),
            );
            expect(planted.exitCode).toBe(0);

            // Export reconciles first, so it must complete the interrupted publication.
            yield* Stream.runCollect(fx.provider.exportVolume({ app: fx.app, store: fx.store }));

            const after = yield* helperFor(
              fx,
              fx.store,
              "cat /data/new.txt; echo; test -e /data/old.txt && echo OLD || echo CLEAN; ls -a /data | grep -E '^\\.lando-(import|replaced)-' || echo NO-LEFTOVERS",
            );
            expect(after.stdout).toContain("new");
            expect(after.stdout).toContain("CLEAN");
            expect(after.stdout).toContain("NO-LEFTOVERS");
          }),
        ),
      );
    },
    180_000,
  );

  test.skipIf(live === undefined)(
    "ENOSPC during extraction maps to the free-space remediation and leaves data unchanged",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fx = yield* liveFixture;
            const api = makePodmanApiClient(fx.socketPath);
            if (api.request === undefined) return yield* Effect.die(new Error("api missing"));
            const name = `snaprt-tmpfs-${unique()}`;
            const request = api.request;
            if (request === undefined) return yield* Effect.die(new Error("api missing"));
            const created = yield* request({
              method: "POST",
              path: "/libpod/volumes/create",
              body: {
                Name: name,
                Driver: "local",
                Options: { type: "tmpfs", device: "tmpfs", o: "size=1m" },
              },
            });
            expect(created.status).toBeLessThan(300);
            yield* Effect.addFinalizer(() =>
              request({
                method: "DELETE",
                path: `/libpod/volumes/${encodeURIComponent(name)}`,
              }).pipe(
                Effect.asVoid,
                Effect.catch(() => Effect.void),
              ),
            );
            const payload = new Uint8Array(2 * 1024 * 1024);
            payload.fill(7);
            const big = tarArchive([{ name: "big.bin", data: "x".repeat(payload.byteLength) }]);
            const result = yield* Effect.result(
              Effect.scoped(
                fx.provider.importVolume<never, never>({
                  target: { app: fx.app, store: name },
                  archive: archiveStream(big),
                  beforeCommit: Effect.void,
                }),
              ),
            );
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              const failure = result.failure;
              expect(failure).toBeInstanceOf(VolumeOperationError);
              if (failure instanceof VolumeOperationError) {
                expect(failure.details).toMatchObject({ phase: "extract" });
                expect(failure.remediation).toContain("Free disk space");
              }
            }
            // The failed extraction leaves no staging behind; exporting the volume succeeds on
            // the unchanged (empty) contents and its first step reconciles leftovers.
            yield* Stream.runCollect(fx.provider.exportVolume({ app: fx.app, store: name }));
          }),
        ),
      );
    },
    180_000,
  );
});
