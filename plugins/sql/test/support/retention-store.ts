import { join } from "node:path";
import { Effect } from "effect";

import { makeDataMoverService } from "@lando/data-mover/service";
import { makeLandoPaths } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  ProviderId,
  ServiceName,
  type SnapshotMetadata,
  planAppIdentity,
} from "@lando/sdk/schema";
import { RuntimeProvider, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as DiskStateStore from "@lando/state-store/service";

import { makeSqlTestDeps } from "./fakes.ts";

export const makeRetentionTestDeps = async (
  options: Parameters<typeof makeSqlTestDeps>[0] = { password: "lando" },
) => {
  const harness = makeSqlTestDeps(options);
  const stateStore = await Effect.runPromise(StateStore.pipe(Effect.provide(DiskStateStore.layer)));
  const paths = makeLandoPaths({
    userConfRoot: join(harness.root, "conf"),
    userDataRoot: join(harness.root, "data"),
    userCacheRoot: join(harness.root, "cache"),
    env: {},
  });
  const removed: string[] = [];
  const captured: string[] = [];
  const warnings: unknown[] = [];
  const moverForRoot = (sourceRoot: string) =>
    makeDataMoverService(
      RuntimeProvider.of({
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, volumeSnapshot: "native" },
        listVolumes: ({ app, store }) =>
          Effect.succeed([
            {
              ref: { app: app ?? AppId.make("sql-app"), store: store ?? "sql-app_database_data" },
              identity: {
                coordinationKey: `daemon:${store}`,
                nativeName: store ?? "sql-app_database_data",
                generation: `volume-instance:${store}`,
                ownerRoot: AbsolutePath.make(sourceRoot),
                origin: "created",
              },
              provenance: "known",
            },
          ]),
        snapshotVolume: ({ snapshotId }) =>
          Effect.succeed({
            provider: ProviderId.make("test"),
            id: snapshotId ?? "snapshot",
            digest: "sha256:fixture",
            sizeBytes: 12,
            format: "native",
          }),
        removeVolumeSnapshot: (snapshot) =>
          Effect.sync(() => {
            removed.push(snapshot.id);
          }),
      }),
      { redactText: (text) => text, publish: () => Effect.void },
      { paths, stateStore },
    );
  const mover = moverForRoot(harness.root);
  const deps = {
    ...harness.deps,
    plan: { ...harness.deps.plan, identity: planAppIdentity({ root: AbsolutePath.make(harness.root) }) },
    snapshot: (store: Parameters<typeof mover.snapshot>[0], opts: Parameters<typeof mover.snapshot>[1]) =>
      Effect.scoped(mover.snapshot(store, opts)).pipe(
        Effect.tap((snapshot) =>
          Effect.sync(() => {
            captured.push(snapshot.id);
          }),
        ),
      ),
    listSnapshots: mover.listSnapshots,
    resolveSnapshot: mover.resolveSnapshot,
    pruneSnapshots: mover.pruneSnapshots,
    publish: (event: Parameters<typeof harness.deps.publish>[0]) =>
      Effect.sync(() => {
        if (event._tag === "message.warn") warnings.push(event);
      }).pipe(Effect.andThen(harness.deps.publish(event))),
  };
  const snapshot = (
    reason: SnapshotMetadata["recoveryReason"],
    scope: {
      readonly store?: string;
      readonly root?: string;
      readonly service?: string;
      readonly app?: string;
    } = {},
  ) => {
    const root = scope.root ?? harness.root;
    const store = scope.store ?? "sql-app_database_data";
    return Effect.scoped(
      moverForRoot(root).snapshot(
        { app: AppId.make(scope.app ?? "sql-app"), store },
        {
          metadata: {
            service: ServiceName.make(scope.service ?? "database"),
            volumeInstanceId: `volume-instance:${store}`,
            family: "mysql",
            version: "8.0",
            imageIdentity: "sha256:mysql-runtime",
            recoveryReason: reason,
          },
        },
      ),
    );
  };
  return { harness, deps, snapshot, mover, removed, captured, warnings };
};
