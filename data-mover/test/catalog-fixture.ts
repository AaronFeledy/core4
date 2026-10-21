import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDataMoverService } from "@lando/data-mover/service";
import * as ProcessRunner from "@lando/engine/services/process-runner";
import { makeLandoPaths } from "@lando/paths";
import { ProviderUnavailableError, errnoCode } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  ProviderId,
  type SnapshotInfo,
  type VolumeSnapshotArtifact,
  type VolumeSnapshotRef,
  planAppIdentity,
  snapshotHandle,
} from "@lando/sdk/schema";
import {
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as DiskStateStore from "@lando/state-store/service";
import { DateTime, Effect, Layer } from "effect";
import { openSnapshot } from "../src/snapshot-catalog.ts";
import { fixtureVolume } from "./support.ts";

export const store = { app: AppId.make("catalog-app"), store: "database" };
export const run = <A, E>(body: Effect.Effect<A, E>) => Effect.runPromise(body);
export const runScoped = <A, E>(body: Effect.Effect<A, E, import("effect").Scope.Scope>) =>
  run(Effect.scoped(body));
export const withCatalog = async (
  body: (fixture: Awaited<ReturnType<typeof catalogFixture>>) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-catalog-"));
  try {
    await body(await catalogFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const catalogFixture = async (root: string) => {
  const paths = makeLandoPaths({
    userDataRoot: join(root, "state"),
    userCacheRoot: join(root, "cache"),
    userConfRoot: join(root, "conf"),
    env: {},
  });
  const stateStore = await run(
    StateStore.pipe(
      Effect.provide(DiskStateStore.layer.pipe(Layer.provide(ProcessRunner.layer))),
      Effect.provideService(PathsService, paths),
    ),
  );
  const owner = planAppIdentity({ root: AbsolutePath.make(join(root, "app")) });
  const artifacts = new Map<string, VolumeSnapshotRef>();
  const removals: string[] = [];
  const provider = (overrides: Partial<RuntimeProviderShape> = {}): RuntimeProviderShape => ({
    ...TestRuntimeProvider,
    id: "A",
    capabilities: { ...TestRuntimeProvider.capabilities, volumeSnapshot: "native" },
    listVolumes: (filter) => {
      const volume = fixtureVolume({ app: filter.app ?? store.app, store: filter.store ?? store.store });
      return Effect.succeed([{ ...volume, identity: { ...volume.identity, ownerRoot: owner.appRoot } }]);
    },
    snapshotVolume: (spec) =>
      Effect.sync(() => {
        const ref: VolumeSnapshotRef = {
          provider: "A",
          id: spec.snapshotId ?? "fixture",
          format: "native",
          digest: "sha256:fixture",
          sizeBytes: 7,
        };
        artifacts.set(ref.id, ref);
        return ref;
      }),
    removeVolumeSnapshot: (ref) =>
      Effect.sync(() => {
        removals.push(ref.id);
        artifacts.delete(ref.id);
      }),
    listVolumeSnapshots: () =>
      Effect.succeed(
        Array.from(
          artifacts.values(),
          (ref): VolumeSnapshotArtifact => ({ ref, labels: {}, createdAt: DateTime.makeUnsafe(0) }),
        ),
      ),
    ...overrides,
  });
  const recording = provider();
  const registry = RuntimeProviderRegistry.of({
    list: Effect.succeed([ProviderId.make("A")]),
    capabilities: Effect.succeed(recording.capabilities),
    select: (id) =>
      id === "A"
        ? Effect.succeed(recording)
        : Effect.fail(
            new ProviderUnavailableError({
              providerId: String(id),
              message: "Missing fixture provider",
              operation: "select",
            }),
          ),
  });
  const mover = (selected = recording, storage: StateStoreShape = stateStore, providers = registry) =>
    makeDataMoverService(
      selected,
      { publish: () => Effect.void, redactText: (text) => text },
      { paths, stateStore: storage, providerRegistry: providers },
    );
  const info = (id = "snapshot"): SnapshotInfo => ({
    owner,
    id,
    store,
    digest: "sha256:fixture",
    sizeBytes: 7,
    createdAt: DateTime.makeUnsafe(0),
    native: { provider: "A", id, digest: "sha256:fixture", sizeBytes: 7, format: "native" },
  });
  const put = (value: SnapshotInfo) =>
    run(
      openSnapshot({ paths, stateStore }, snapshotHandle(value)).pipe(
        Effect.flatMap((bucket) => bucket.set(value)),
      ),
    );
  const files = async () =>
    readdir(paths.snapshotsDir, { recursive: true }).catch((cause: unknown) => {
      if (errnoCode(cause) === "ENOENT") return [];
      throw cause;
    });
  return {
    root,
    paths,
    stateStore,
    owner,
    provider,
    recording,
    registry,
    mover,
    info,
    put,
    files,
    artifacts,
    removals,
  };
};
