import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DataTransferError, LandofileValidationError } from "@lando/sdk/errors";
import { SnapshotInfo, appIdentityKey } from "@lando/sdk/schema";
import { DataMover, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { startChildTaskId } from "@lando/sdk/task-progress";
import { Effect, Schema } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp, destroyAppForTarget } from "../../src/operations/destroy.ts";
import { recoveryHarness, target } from "./accelerated-start-recovery-support.ts";
import { emptySnapshots } from "./data-mover-support.ts";
import { byTag, destroyTreeId, makeHarness, plan } from "./destroy-progress-topology-support.ts";

test("destroy fails closed before its bracket when only an unfinished root journal survives", async () => {
  // Given: no provider evidence, an invalid Landofile, and retained sync sessions/journal.
  const harness = await Effect.runPromise(recoveryHarness({ appliedState: "unknown" }));
  const file = join(target.root, ".lando.yml");
  await Bun.write(file, "services: [invalid\n");
  const invalid = new LandofileValidationError({
    message: "Invalid Landofile",
    remediation: "Restore the matching Landofile.",
    file,
    issues: [{ path: [], message: "Invalid services" }],
  });
  try {
    // When: the public cwd destroy path has no readable desired plan to recover.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        return yield* withResolvedCwd(target.root, destroyApp({ volumes: true })).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...registry,
            resolveAppliedPlan: () => Effect.succeed(undefined),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          }),
          Effect.provideService(LandofileService, {
            discover: Effect.fail(invalid),
          }),
          Effect.result,
        );
      }).pipe(Effect.provide(harness.layer)),
    );
    // Then: retained resources survive, and no lifecycle bracket has opened.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "FileSyncStopError",
        message: "Retained sync state cannot be matched to a readable app plan for safe destroy.",
      },
    });
    expect(harness.calls).toEqual([]);
    expect(harness.sessions).toHaveLength(1);
    expect(byTag(harness.events, "pre-destroy")).toEqual([]);
  } finally {
    await rm(file, { force: true });
  }
});

test.each([false, true])("retained destroy purges before disposal (purge fails=%s)", async (fails) => {
  // Given: an accelerated retained start and one owned snapshot.
  const harness = await Effect.runPromise(recoveryHarness({ appliedState: "unknown" }));
  const snapshot = Schema.decodeUnknownSync(SnapshotInfo)({
    id: "owned",
    owner: { appRoot: target.root, ownerKey: appIdentityKey("owner", target.root) },
    store: { app: target.app.id, store: "database" },
    digest: "sha256:snapshot",
    sizeBytes: 1,
    createdAt: "2026-05-15T00:00:00Z",
    native: { provider: "lando", id: "owned", digest: "sha256:snapshot", sizeBytes: 1, format: "native" },
  });
  let snapshots = [snapshot];
  const failure = new DataTransferError({ message: "Snapshot removal failed", operation: "removeSnapshot" });
  const mover = DataMover.of({
    ...emptySnapshots,
    listSnapshots: () => Effect.sync(() => snapshots),
    removeSnapshot: () =>
      Effect.sync(() => {
        harness.calls.push("snapshots");
      }).pipe(
        Effect.andThen(
          fails
            ? Effect.fail(failure)
            : Effect.sync(() => {
                snapshots = [];
              }),
        ),
      ),
  });
  // When: purge executes through the real destroy operation.
  const result = await Effect.runPromise(
    destroyAppForTarget({ purgeSnapshots: true, volumes: true }, target).pipe(
      Effect.provideService(DataMover, mover),
      Effect.provide(harness.layer),
      Effect.result,
    ),
  );
  // Then: one file-sync task spans quiescence, snapshot purge, and disposal.
  const child = (id: string) => startChildTaskId(destroyTreeId(target.app.id), id);
  expect(byTag(harness.events, "task.tree.start")[0]?.children).toEqual(
    ["file-sync", "snapshots", "provider", "host-proxy", "routes"].map(child),
  );
  expect(
    byTag(harness.events, "task.start").filter((event) => event.taskId === child("file-sync")),
  ).toHaveLength(1);
  if (fails) {
    expect(result).toMatchObject({ _tag: "Failure", failure });
    expect(harness.calls).toEqual(["quiesce-retained", "snapshots"]);
    expect(harness.sessions).toHaveLength(1);
    expect(await Effect.runPromise(mover.listSnapshots({ ownerKey: snapshot.owner.ownerKey }))).toEqual([
      snapshot,
    ]);
    expect(byTag(harness.events, "post-destroy")).toEqual([]);
    expect(byTag(harness.events, "task.complete").map((event) => event.taskId)).not.toContain(
      child("file-sync"),
    );
  } else {
    expect(result).toMatchObject({ _tag: "Success", success: { outcome: "destroyed", snapshotsRemoved: 1 } });
    expect(harness.calls).toEqual([
      "quiesce-retained",
      "snapshots",
      "drain",
      "dispose",
      "dispose-targets",
      "complete",
      "destroy:true",
    ]);
    const completed = byTag(harness.events, "task.complete").map((event) => event.taskId);
    expect(completed.indexOf(child("snapshots"))).toBeLessThan(completed.indexOf(child("file-sync")));
    expect(completed.indexOf(child("file-sync"))).toBeLessThan(completed.indexOf(child("provider")));
  }
});

test("destroy reports unchanged when the provider returns no-op and nothing else is removed", async () => {
  // Given: a planned service whose provider no longer has an applied plan.
  const harness = makeHarness();
  let destroys = 0;
  // When: the provider's no-op receipt crosses the full destroy path.
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const provider = yield* registry.select(plan);
      return yield* destroyAppForTarget(
        { volumes: true },
        {
          plan,
          root: plan.root,
          app: { kind: "user", id: plan.id, root: plan.root },
        },
      ).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...registry,
          select: () =>
            Effect.succeed({
              ...provider,
              destroy: () =>
                Effect.sync(() => {
                  destroys += 1;
                  return { kind: "no-op", reason: "no-applied-plan" } as const;
                }),
            }),
        }),
      );
    }).pipe(Effect.provide(harness.layer)),
  );
  // Then: neither the result nor its closing event claims planned services were removed.
  expect(destroys).toBe(1);
  expect(result).toMatchObject({ outcome: "unchanged", servicesDestroyed: [], volumesRemoved: false });
  expect(byTag(harness.events, "post-destroy")).toMatchObject([{ outcome: "unchanged" }]);
});
