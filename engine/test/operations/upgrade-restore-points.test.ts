import { expect, test } from "bun:test";
import { failureOutcomeFromCause, taggedErrorJson } from "@lando/sdk/command-result";
import { DataTransferError, ProviderUnavailableError } from "@lando/sdk/errors";
import { PortNumber, SnapshotId, type VolumeIdentity, planAppIdentity, planDataId } from "@lando/sdk/schema";
import { DataMover, type ServiceRuntimeIdentity, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { withPhysicalVolumeLock } from "@lando/state-store/volume-lock";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { emptySnapshots } from "./data-mover-support.ts";
import { databaseRuntime, versionedPlan } from "./data-version-support.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const id = SnapshotId.make("pre-upgrade");

const fixture = (
  input: {
    readonly from?: string;
    readonly to?: string;
    readonly state?: "running" | "exited";
    readonly failure?: "pull" | "helper-pull" | "capture" | "apply" | "replacement";
    readonly failResume?: boolean;
    readonly afterSnapshotCommit?: Effect.Effect<void>;
    readonly offlineVersion?: string;
    readonly recordBuild?: boolean;
    readonly recordPreStop?: boolean;
  } = {},
) => {
  const from = input.from ?? "10.11";
  const to = input.to ?? "11.4";
  const { nonSqlCreds: _nonSqlCreds, sqlite: _sqlite, ...base } = web;
  const database = {
    ...base,
    connection: {
      family: "mariadb" as const,
      port: PortNumber.make(3306),
      creds: { user: "user", password: "password", database: "db" },
    },
  };
  const applied = versionedPlan(plan, database, from);
  const desired = versionedPlan(plan, database, to);
  const owner = planAppIdentity(applied);
  const mount = applied.services[web.name]?.mounts.find((mount) => mount.type === "volume");
  if (mount === undefined) throw new Error("fixture requires a mounted store");
  const ref = { app: planDataId(applied), store: mount.store };
  const physical: VolumeIdentity = {
    coordinationKey: `fixture:${ref.store}`,
    nativeName: ref.store,
    generation: "fixture-volume",
    ownerRoot: owner.appRoot,
    origin: "created",
  };
  const original = { containerId: "database-original", imageIdentity: "sha256:original" };
  let status = input.state ?? "running";
  let native = original;
  const actions: string[] = [];
  const captured: Parameters<DataMover["Service"]["snapshot"]>[1][] = [];
  const snapshots = new Set<SnapshotId>();
  const stateStore = makeTestStateStore();
  const failure = new ProviderUnavailableError({
    providerId: plan.provider,
    operation: "pull",
    message: "Cannot pull the selected artifact.",
    remediation: "Check the connection.",
  });
  const snapshot = (
    series: string,
    snapshotId: string,
    createdAt: number,
    source: "record" | "applied-plan" = "record",
    generation = physical.generation,
  ) => ({
    id: SnapshotId.make(snapshotId),
    store: ref,
    owner,
    digest: "sha256:snapshot",
    sizeBytes: 10,
    createdAt: DateTime.makeUnsafe(createdAt),
    metadata: {
      service: web.name,
      recoveryReason: "upgrade" as const,
      volumeInstanceId: generation,
      family: "mariadb",
      imageIdentity: original.imageIdentity,
      dataVersion: { label: "MariaDB", series, source },
    },
  });
  const mover = DataMover.of({
    ...emptySnapshots,
    snapshot: (store, opts, onCommit) =>
      withPhysicalVolumeLock(
        stateStore.service,
        { key: physical.coordinationKey, name: physical.nativeName, mode: "exclusive" },
        Effect.gen(function* () {
          if (status !== "exited" || store.store !== ref.store || store.app !== ref.app)
            return yield* Effect.die("Snapshot attempted on a running or foreign volume.");
          actions.push("capture");
          captured.push(opts);
          if (input.failure === "capture")
            return yield* new DataTransferError({
              operation: "snapshot",
              message: "Disk is full.",
              remediation: "Free space before retrying.",
            });
          const handle = { id, ownerKey: owner.ownerKey, store };
          snapshots.add(id);
          onCommit?.(handle);
          yield* input.afterSnapshotCommit ?? Effect.void;
          return handle;
        }),
      ).pipe(Effect.catchTag("StateStoreError", Effect.die)),
    removeSnapshot: (handle) =>
      Effect.sync(() => {
        if (handle.ownerKey !== owner.ownerKey || handle.store.store !== ref.store)
          throw new Error("Activation tried to remove a foreign snapshot.");
        snapshots.delete(handle.id);
      }),
    listSnapshots: (filter) =>
      Effect.succeed(
        filter.ownerKey === owner.ownerKey && filter.service === web.name && filter.store === ref.store
          ? [
              snapshot(to, "older", 1),
              snapshot(to, "newest-matching", 2),
              snapshot("5.5", "wrong-series", 3),
              snapshot(to, "unverified", 4, "applied-plan"),
              snapshot(to, "old-volume", 5, "record", "previous-volume"),
            ]
          : [],
      ),
  });
  const changeOriginal = (identity: ServiceRuntimeIdentity, next: "running" | "exited") =>
    Effect.sync(() => {
      if (identity.containerId !== native.containerId || identity.imageIdentity !== native.imageIdentity)
        throw new Error("Activation did not pin the runtime identity.");
      actions.push(next === "running" ? "resume" : "suspend");
      status = next;
    });
  const harness = makeHarness({
    plannedApp: desired,
    appliedPlans: [applied],
    resolveAppliedPlan: () => Effect.succeed(applied),
    stateStore,
    dataMoverLayer: Layer.succeed(DataMover, mover),
    locateVolume: () =>
      Effect.succeed({
        nativeName: ref.store,
        coordinationKey: physical.coordinationKey,
        identity: physical,
      }),
    inspect: (target) =>
      Effect.sync(
        () =>
          ({
            ...databaseRuntime(applied, target.service),
            ...native,
            appRoot: owner.appRoot,
            status,
          }) satisfies ServiceRuntimeInfo,
      ),
    exec: (_target, command) =>
      Effect.succeed({
        exitCode: 0,
        stdout: command.command.includes("/var/lib/mysql/mariadb_upgrade_info")
          ? `+${from}.7-MariaDB\n\0`
          : "",
        stderr: "",
      }),
    providerOverrides: {
      ...(input.failure === "pull" || input.failure === "helper-pull"
        ? {
            capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
            pullArtifact: ({ ref }) =>
              input.failure === "pull" || ref.includes("library/alpine")
                ? Effect.fail(failure)
                : Effect.succeed({ ref, providerId: plan.provider }),
          }
        : {}),
      observeBoundVolume: (target) =>
        target.expectedContainerId === native.containerId
          ? Effect.succeed({ ref, identity: physical })
          : Effect.fail(failure),
      run: (spec) =>
        Effect.sync(() => {
          if (
            status !== "exited" ||
            spec.mounts?.[0]?.readOnly !== true ||
            spec.mounts[0].store !== ref.store
          )
            throw new Error("Offline version read did not use the stopped, read-only database volume.");
          return {
            exitCode: 0,
            stdout: input.offlineVersion === undefined ? "-\0" : `+${input.offlineVersion}.7-MariaDB\n\0`,
            stderr: "",
          };
        }),
      suspend: (_target, identity) => changeOriginal(identity, "exited"),
      resume: (_target, identity) =>
        input.failResume === true ? Effect.fail(failure) : changeOriginal(identity, "running"),
    },
    onStop: () => actions.push("stop"),
    ...(input.recordPreStop === true
      ? {
          onPublish: (event) =>
            Effect.sync(() => {
              if (event._tag === "pre-stop") actions.push(`pre-stop:${status}`);
            }),
        }
      : {}),
    ...(input.recordBuild === true ? { onBuild: () => actions.push("build") } : {}),
    onDestroy: () => actions.push("teardown"),
    onApply: () =>
      Effect.gen(function* () {
        actions.push("apply");
        if (input.failure === "apply") return yield* failure;
        native = { containerId: "database-new", imageIdentity: "sha256:new" };
        if (input.failure === "replacement") return yield* failure;
        status = "running";
      }),
  });
  const target = {
    root: desired.root,
    plan: desired,
    app: { kind: "user" as const, id: desired.id, root: desired.root },
  };
  return { ...harness, target, actions, captured, snapshots, status: () => status };
};

test.each([
  ["start", false],
  ["start", true],
  ["restart", false],
  ["restart", true],
  ["rebuild", false],
  ["rebuild", true],
] as const)(
  "%s (selected=%s) captures under reentrant volume coordination before replacing the database",
  async (operation, selected) => {
    const f = fixture();
    const options = selected ? { services: [web.name] } : {};
    const launch = operation === "start" ? startApp : operation === "restart" ? restartApp : rebuildApp;
    const result = await Effect.runPromise(launch(options, f.target).pipe(Effect.provide(f.layer)));

    expect(f.actions.slice(0, 2)).toEqual(["suspend", "capture"]);
    expect(f.actions).toContain("apply");
    expect(f.status()).toBe("running");
    expect(result.dataVersionChanges).toEqual([
      { service: web.name, from: "10.11", to: "11.4", restorePoint: id },
    ]);
  },
);

test("selected rebuild finishes its artifact build before taking the database offline", async () => {
  const f = fixture({ recordBuild: true });
  await Effect.runPromise(rebuildApp({ services: [web.name] }, f.target).pipe(Effect.provide(f.layer)));
  expect(f.actions).toEqual(["build", "suspend", "capture", "stop", "apply"]);
});

test("whole restart runs pre-stop while the old database is still running", async () => {
  const f = fixture({ recordPreStop: true });
  await Effect.runPromise(restartApp({}, f.target).pipe(Effect.provide(f.layer)));
  expect(f.actions.slice(0, 3)).toEqual(["pre-stop:running", "suspend", "capture"]);
});

test.each([
  ["pull", "running", [], "running", []],
  ["helper-pull", "running", [], "running", []],
  ["capture", "running", ["suspend", "capture", "resume"], "running", []],
  ["apply", "running", ["suspend", "capture", "apply", "resume"], "running", []],
  ["apply", "exited", ["capture", "apply"], "exited", []],
  ["replacement", "running", ["suspend", "capture", "apply"], "exited", [id]],
] as const)(
  "failed %s with a previously %s database keeps a restore point only if the upgrade might have run",
  async (failure, state, actions, finalStatus, remaining) => {
    const f = fixture({ failure, state });
    const error = await Effect.runPromise(startApp({}, f.target).pipe(Effect.provide(f.layer), Effect.flip));

    expect(f.actions).toEqual([...actions]);
    expect(f.status()).toBe(finalStatus);
    expect([...f.snapshots]).toEqual([...remaining]);
    expect(error._tag).toBe(
      failure === "capture" || failure === "helper-pull"
        ? "ServiceRestorePointError"
        : "ProviderUnavailableError",
    );
    if (failure === "capture" && error._tag === "ServiceRestorePointError") {
      expect(error.dataVersion).toEqual({ label: "MariaDB", from: "10.11", to: "11.4" });
      expect(error.remediation).toContain("--no-snapshot");
      expect(error.cause).toBeInstanceOf(DataTransferError);
    }
  },
);

test("a failed resume preserves the primary failure and reports the kept point and rollback error", async () => {
  const f = fixture({ failure: "apply", failResume: true });
  const exit = await Effect.runPromiseExit(startApp({}, f.target).pipe(Effect.provide(f.layer)));

  if (Exit.isSuccess(exit)) throw new Error("expected activation to fail");
  const failure = failureOutcomeFromCause(exit.cause);
  expect(taggedErrorJson(failure.error)._tag).toBe("ProviderUnavailableError");
  expect(failure.additionalErrors.map(({ role, error }) => [role, taggedErrorJson(error)._tag])).toEqual([
    ["rollback", "ServiceRestorePointError"],
  ]);
  expect(failure.failureContext?.restorePointIds).toEqual([id]);
  expect([...f.snapshots]).toEqual([id]);
  expect(f.status()).toBe("exited");
});

test("cancelling after snapshot commit resumes the original and removes the committed point", async () => {
  const committed = Deferred.makeUnsafe<void>();
  const f = fixture({
    afterSnapshotCommit: Deferred.succeed(committed, undefined).pipe(Effect.andThen(Effect.never)),
  });
  const fiber = Effect.runFork(startApp({}, f.target).pipe(Effect.provide(f.layer)));
  await Effect.runPromise(Deferred.await(committed).pipe(Effect.timeout("5 seconds")));
  await Effect.runPromise(Fiber.interrupt(fiber));

  const exit = await Effect.runPromise(Fiber.await(fiber));
  if (Exit.isSuccess(exit)) throw new Error("expected capture to be interrupted");
  const outcome = failureOutcomeFromCause(exit.cause);
  expect(outcome.kind).toBe("none");
  expect(outcome.failureContext).toEqual({ discardedRestorePointIds: [id] });
  expect(f.actions).toEqual(["suspend", "capture", "resume"]);
  expect(f.status()).toBe("running");
  expect([...f.snapshots]).toEqual([]);
});

test("an already-stopped database gets an upgrade restore point without resuming it for observation", async () => {
  const f = fixture({ state: "exited" });
  await Effect.runPromise(startApp({}, f.target).pipe(Effect.provide(f.layer)));
  expect(f.actions).toEqual(["capture", "apply"]);
  expect(f.captured[0]?.metadata).toMatchObject({
    recoveryReason: "upgrade",
    dataVersion: { label: "MariaDB", series: "10.11", source: "applied-plan" },
  });
  expect(f.captured[0]?.metadata?.version).toBeUndefined();
});

test.each([
  ["10.11", "11.4", "ServiceRestorePointError"],
  ["11.4", "10.11", "ServiceDataVersionError"],
] as const)(
  "a stopped service planned at %s cannot upgrade from a false baseline to %s",
  async (from, to, tag) => {
    const f = fixture({ from, to, state: "exited", offlineVersion: "11.4" });
    const error = await Effect.runPromise(startApp({}, f.target).pipe(Effect.provide(f.layer), Effect.flip));

    expect(error._tag).toBe(tag);
    if (error._tag === "ServiceDataVersionError")
      expect(error.dataVersion).toMatchObject({
        direction: "downgrade",
        evidence: "record",
        imageVersion: "10.11",
      });
    expect(f.actions).toEqual([]);
    expect(f.snapshots.size).toBe(0);
  },
);

test("labels a stopped database's snapshot with the record on disk, not the applied image", async () => {
  const f = fixture({ state: "exited", offlineVersion: "10.6" });
  await Effect.runPromise(startApp({}, f.target).pipe(Effect.provide(f.layer)));
  expect(f.captured[0]?.metadata?.dataVersion).toMatchObject({ series: "10.6", source: "record" });
});

test.each([
  ["11.4", "ServiceRestorePointError"],
  ["11.8", "ServiceDataVersionError"],
] as const)("rechecks running admission evidence before capturing %s data", async (offlineVersion, tag) => {
  const f = fixture({ offlineVersion });
  const error = await Effect.runPromise(startApp({}, f.target).pipe(Effect.provide(f.layer), Effect.flip));

  expect(error._tag).toBe(tag);
  expect(f.actions).toEqual(["suspend", "resume"]);
  expect(f.snapshots.size).toBe(0);
});

test.each([
  [undefined, "10.11", "applied-plan"],
  ["10.6", "10.6", "record"],
] as const)(
  "labels running database data using its locked observation %s",
  async (offlineVersion, series, source) => {
    const f = fixture(offlineVersion === undefined ? {} : { offlineVersion });
    await Effect.runPromise(startApp({}, f.target).pipe(Effect.provide(f.layer)));

    expect(f.captured[0]?.metadata?.dataVersion).toMatchObject({ series, source });
  },
);

test.each([true, false])(
  "does not capture for an opt-out (%s) or unchanged database series",
  async (noSnapshot) => {
    const f = fixture(noSnapshot ? {} : { to: "10.11" });
    const result = await Effect.runPromise(startApp({ noSnapshot }, f.target).pipe(Effect.provide(f.layer)));
    expect(f.actions).toEqual(["apply"]);
    expect(result.dataVersionChanges?.[0]?.restorePoint).toBeUndefined();
  },
);

test("downgrade refusal points to the newest same-series restore point without stopping the database", async () => {
  const f = fixture({ from: "11.4", to: "10.11" });
  const error = await Effect.runPromise(startApp({}, f.target).pipe(Effect.provide(f.layer), Effect.flip));
  expect(error._tag).toBe("ServiceDataVersionError");
  if (error._tag === "ServiceDataVersionError")
    expect(error.remediation).toContain("lando db:restore newest-matching --service web");
  expect(f.actions).toEqual([]);
});
