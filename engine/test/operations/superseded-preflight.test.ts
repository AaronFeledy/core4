import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { FileSyncStartError } from "@lando/sdk/errors";
import { AppId, type AppPlan, appIdentityKey } from "@lando/sdk/schema";
import { ManagedFileTransactionGuard, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { Effect } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { FileSyncResolver } from "../../src/plugins/file-sync-resolver.ts";
import { acceleratedPlan } from "./accelerated-start-recovery-support.ts";
import { ordinaryPlan } from "./start-file-sync-rotation-support.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const old: AppPlan = {
  ...ordinaryPlan,
  id: AppId.make("previous"),
  name: "previous",
  slug: "previous",
  identity: { appRoot: ordinaryPlan.root, ownerKey: appIdentityKey("owner", ordinaryPlan.root) },
};

test.each(
  [startApp, restartApp, rebuildApp].flatMap((operation) =>
    (["engine", "provider"] as const).map((failure) => ({ operation, failure })),
  ),
)(
  "$operation validates desired accelerated $failure support before retiring an ordinary app",
  async ({ operation, failure }) => {
    const desired = {
      ...acceleratedPlan,
      fileSync: acceleratedPlan.fileSync.map((entry) => ({
        ...entry,
        engineId: failure === "engine" ? "unavailable" : TestFileSyncEngine.id,
      })),
    };
    let mutations = 0;
    const harness = makeHarness({
      plannedApp: desired,
      appliedPlans: [old],
      providerCanPrepareFileSync: failure !== "provider",
      onDestroy: () => mutations++,
      onApply: () => mutations++,
      onStop: () => mutations++,
    });
    try {
      const result = await Effect.runPromise(
        operation(
          {},
          { plan: desired, root: desired.root, app: { kind: "user", id: desired.id, root: desired.root } },
        ).pipe(
          Effect.provideService(
            FileSyncResolver,
            FileSyncResolver.of({
              candidates: [],
              select: () => Effect.succeed(undefined),
              acquire: (id) =>
                id === TestFileSyncEngine.id
                  ? Effect.succeed(TestFileSyncEngine)
                  : Effect.fail(
                      new FileSyncStartError({
                        engineId: id,
                        message: "Unavailable test engine",
                        remediation: "Restore the test engine.",
                      }),
                    ),
            }),
          ),
          Effect.provide(harness.layer),
          Effect.result,
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "FileSyncStartError",
          engineId: failure === "engine" ? "unavailable" : TestFileSyncEngine.id,
        },
      });
      expect(mutations).toBe(0);
      expect(harness.events).toEqual([]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test.each([startApp, restartApp, rebuildApp])(
  "%s prepares every superseded sync disposal before recovery or retirement",
  async (operation) => {
    const safe = {
      ...plan,
      id: AppId.make("safe-previous"),
      identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
    };
    const unsafe = { ...safe, id: AppId.make("unsafe-previous") };
    const calls: string[] = [];
    const harness = makeHarness({
      appliedPlans: [safe, unsafe],
      onDestroy: () => calls.push("destroy"),
      onApply: () => calls.push("apply"),
    });
    try {
      const base = await Effect.runPromise(harness.runtimeProviderRegistry.select());
      const result = await Effect.runPromise(
        operation({}, { plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } }).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...harness.runtimeProviderRegistry,
            select: () =>
              Effect.succeed({
                ...base,
                inspectAppliedFileSync: (plan) =>
                  Effect.succeed({ status: plan.id === unsafe.id ? "unknown" : "ordinary" }),
              }),
          }),
          Effect.provideService(ManagedFileTransactionGuard, {
            assertReadable: () => Effect.void,
            pending: () => Effect.succeed(null),
            ensureConsistent: () =>
              Effect.sync(() => {
                calls.push("recover");
              }),
          }),
          Effect.provide(harness.layer),
          Effect.result,
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "FileSyncStopError" } });
      expect(calls).toEqual([]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
