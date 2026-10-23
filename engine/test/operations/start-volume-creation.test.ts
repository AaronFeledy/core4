import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, type VolumeIdentity, appIdentityKey } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect, Result } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopApp, stopAppWithPlan } from "../../src/operations/stop.ts";
import { resolveTeardownEvidence } from "../../src/providers/applied-state-resolution.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

for (const operation of ["stop", "destroy"] as const) {
  test(`${operation} removes the retained owned network after a failed apply`, async () => {
    // Given a failed first apply with success-only applied state.
    const plannedApp: AppPlan = {
      ...plan,
      identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
    };
    let networkExists = false;
    let rollbackAttempts = 0;
    const failure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "apply",
      message: "Failure after private network creation.",
    });
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      isAvailable: Effect.succeed(true),
      appliedPlans: Effect.succeed([]),
      canCleanupOwnedResources: Effect.succeed(true),
      resourceOwnership: () =>
        Effect.succeed(
          networkExists
            ? {
                appRoot: plannedApp.root,
                ownerKey: plannedApp.identity?.ownerKey ?? "",
                providerId: plannedApp.provider,
                appIds: [plannedApp.id],
              }
            : undefined,
        ),
      cleanupOwnedResources: () =>
        Effect.sync(() => {
          const networksRemoved = networkExists ? 1 : 0;
          networkExists = false;
          return { servicesRemoved: [], networksRemoved, volumesRemoved: 0 };
        }),
    };
    const harness = makeHarness({
      plannedApp,
      providerOverrides: provider,
      apply: () =>
        Effect.sync(() => {
          networkExists = true;
        }).pipe(Effect.andThen(Effect.fail(failure))),
      destroyEffect: Effect.sync(() => {
        rollbackAttempts += 1;
      }).pipe(Effect.andThen(Effect.fail(failure))),
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: (root) => resolveTeardownEvidence(root, [provider]),
    });
    const failed = await Effect.runPromise(
      startApp(
        {},
        {
          plan: plannedApp,
          root: plannedApp.root,
          app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
        },
      ).pipe(Effect.provide(harness.layer), Effect.result),
    );
    expect(Result.isFailure(failed)).toBe(true);
    expect(rollbackAttempts).toBe(0);
    expect(networkExists).toBe(true);

    // When whole-app teardown runs later, without a successful applied plan.
    const result = await Effect.runPromise(
      withResolvedCwd(
        plannedApp.root,
        operation === "stop"
          ? stopApp().pipe(Effect.map((result) => result.outcome))
          : destroyApp().pipe(Effect.map((result) => result.outcome)),
      ).pipe(Effect.provide(harness.layer)),
    );

    // Then network-only cleanup is observable work, not an unchanged result.
    expect(networkExists).toBe(false);
    expect(result).toBe(operation === "stop" ? "stopped" : "destroyed");
  });
}

test("internal selected stop preserves unrelated ownership hints", async () => {
  // Given
  const plannedApp = {
    ...plan,
    identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
  };
  let cleanups = 0;
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    isAvailable: Effect.succeed(true),
    appliedPlans: Effect.succeed([plannedApp]),
    canCleanupOwnedResources: Effect.succeed(true),
    resourceOwnership: () =>
      Effect.succeed({ ...plannedApp.identity, providerId: plannedApp.provider, appIds: [plannedApp.id] }),
    cleanupOwnedResources: () =>
      Effect.sync(() => {
        cleanups += 1;
        return { servicesRemoved: [], networksRemoved: 1, volumesRemoved: 0 };
      }),
  };
  const harness = makeHarness({
    plannedApp,
    providerOverrides: provider,
    resolveTeardownEvidence: (root) => resolveTeardownEvidence(root, [provider]),
  });
  // When
  await Effect.runPromise(
    stopAppWithPlan(
      {},
      {
        plan: plannedApp,
        root: plannedApp.root,
        app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
      },
      { skipInitEvents: true },
    ).pipe(Effect.provide(harness.layer)),
  );
  // Then
  expect(cleanups).toBe(0);
});

test("a retry can claim seed initialization after apply creates a volume then fails", async () => {
  const stateStore = makeTestStateStore();
  const plannedApp: AppPlan = {
    ...plan,
    identity: { appRoot: plan.root, ownerKey: "owner" },
    stores: [{ name: "data", scope: "app", kind: "data" }],
  };
  const identity: VolumeIdentity = {
    coordinationKey: "daemon/data",
    nativeName: "data",
    generation: "first-generation",
    ownerRoot: plan.root,
    origin: "created",
  };
  let created = false;
  let callbacks = 0;
  const harness = makeHarness({
    plannedApp,
    stateStore,
    locateVolume: () =>
      Effect.succeed({
        coordinationKey: identity.coordinationKey,
        nativeName: identity.nativeName,
        ...(created ? { identity } : {}),
      }),
    apply: (_plan, options) =>
      Effect.gen(function* () {
        if (!created) {
          created = true;
          if (options.onVolumeCreated !== undefined) {
            callbacks += 1;
            yield* options.onVolumeCreated(identity);
          }
          return yield* Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "apply",
              message: "Web container creation failed after creating the database volume.",
            }),
          );
        }
        return { changed: true, createdVolumes: [] };
      }),
  });

  const start = startApp(
    {},
    {
      plan: plannedApp,
      root: plannedApp.root,
      app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
    },
  ).pipe(Effect.provide(harness.layer));
  const failed = await Effect.runPromise(Effect.result(start));
  const retried = await Effect.runPromise(start);

  expect(Result.isFailure(failed)).toBe(true);
  expect(retried.servicesStarted).toHaveLength(1);
  expect(callbacks).toBe(1);
  const initialization = await Effect.runPromise(volumeInitialization(stateStore.service, identity));
  expect((await Effect.runPromise(initialization.read))?.state._tag).toBe("fresh");
  expect(await Effect.runPromise(initialization.begin("db-seed"))).toBe(true);
});
