import { expect, test } from "bun:test";
import { DataTransferError, ProviderUnavailableError } from "@lando/sdk/errors";
import { PortNumber, SnapshotId, type VolumeIdentity, planAppIdentity, planDataId } from "@lando/sdk/schema";
import { DataMover, type ServiceRuntimeIdentity, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { withPhysicalVolumeLock } from "@lando/state-store/volume-lock";
import { DateTime, Effect, Layer } from "effect";
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
    readonly failure?: "capture" | "apply" | "replacement";
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
  const stateStore = makeTestStateStore();
  const failure = new ProviderUnavailableError({
    providerId: plan.provider,
    operation: "pull",
    message: "Cannot pull the selected artifact.",
    remediation: "Check the connection.",
  });
  const snapshot = (series: string, snapshotId: string, createdAt: number) => ({
    id: SnapshotId.make(snapshotId),
    store: ref,
    owner,
    digest: "sha256:snapshot",
    sizeBytes: 10,
    createdAt: DateTime.makeUnsafe(createdAt),
    metadata: {
      service: web.name,
      recoveryReason: "upgrade" as const,
      volumeInstanceId: physical.generation,
      family: "mariadb",
      imageIdentity: original.imageIdentity,
      dataVersion: { label: "MariaDB", series, source: "record" as const },
    },
  });
  const mover = DataMover.of({
    ...emptySnapshots,
    snapshot: (store, opts) =>
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
          return { id, ownerKey: owner.ownerKey, store };
        }),
      ).pipe(Effect.catchTag("StateStoreError", Effect.die)),
    listSnapshots: (filter) =>
      Effect.succeed(
        filter.ownerKey === owner.ownerKey && filter.service === web.name && filter.store === ref.store
          ? [snapshot(to, "older", 1), snapshot(to, "newest-matching", 2), snapshot("5.5", "wrong-series", 3)]
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
      observeBoundVolume: (target) =>
        target.expectedContainerId === native.containerId
          ? Effect.succeed({ ref, identity: physical })
          : Effect.fail(failure),
      suspend: (_target, identity) => changeOriginal(identity, "exited"),
      resume: (_target, identity) => changeOriginal(identity, "running"),
    },
    onStop: () => actions.push("stop"),
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
  return { ...harness, target, actions, captured, status: () => status };
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

test.each(["capture", "apply", "replacement"] as const)(
  "failed %s resumes only the original database",
  async (failure) => {
    const f = fixture({ failure });
    const error = await Effect.runPromise(startApp({}, f.target).pipe(Effect.provide(f.layer), Effect.flip));

    expect(f.actions).toEqual(
      failure === "capture"
        ? ["suspend", "capture", "resume"]
        : failure === "apply"
          ? ["suspend", "capture", "apply", "resume"]
          : ["suspend", "capture", "apply"],
    );
    expect(error._tag).toBe(failure === "capture" ? "ServiceRestorePointError" : "ProviderUnavailableError");
    if (error._tag === "ServiceRestorePointError") {
      expect(error.dataVersion).toEqual({ label: "MariaDB", from: "10.11", to: "11.4" });
      expect(error.remediation).toContain("--no-snapshot");
    }
  },
);

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
