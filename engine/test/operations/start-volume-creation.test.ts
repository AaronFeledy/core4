import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, PortablePath, type VolumeIdentity, appIdentityKey } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect, Result } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { RECREATED_DATA_VOLUME_CODE } from "../../src/lifecycle/recreated-volumes.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { haltAppRuntime, stopApp } from "../../src/operations/stop.ts";
import { resolveTeardownEvidence } from "../../src/providers/applied-state-resolution.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const operation of ["stop", "destroy"] as const) {
  test(`${operation} ${operation === "stop" ? "keeps" : "removes"} the retained owned network after a failed apply`, async () => {
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
      remediation: "Install or start the `lando` provider and confirm it can perform `apply`.",
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
          return { servicesRemoved: [], networksRemoved, volumesRemoved: { data: 0, cache: 0 } };
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

    // Then destroy's network-only cleanup is observable work; stop removes nothing, so the network
    // stays (resource-ownership-teardown.test.ts pins stop's outcome for an inventory-only root).
    expect(networkExists).toBe(operation === "stop");
    if (operation === "destroy") expect(result).toBe("destroyed");
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
        return { servicesRemoved: [], networksRemoved: 1, volumesRemoved: { data: 0, cache: 0 } };
      }),
  };
  const harness = makeHarness({
    plannedApp,
    providerOverrides: provider,
    resolveTeardownEvidence: (root) => resolveTeardownEvidence(root, [provider]),
  });
  // When
  await Effect.runPromise(
    haltAppRuntime({
      plan: plannedApp,
      root: plannedApp.root,
      app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
    }).pipe(Effect.provide(harness.layer)),
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
              remediation: "Install or start the `lando` provider and confirm it can perform `apply`.",
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

test("start makes the provider ready before it locates plan volumes", async () => {
  // Given a powered-off runtime: locating a volume only works after ensureReady.
  const plannedApp: AppPlan = {
    ...plan,
    identity: { appRoot: plan.root, ownerKey: "owner" },
    stores: [{ name: "data", scope: "app", kind: "data" }],
  };
  const calls: string[] = [];
  const harness = makeHarness({
    plannedApp,
    providerOverrides: {
      ...TestRuntimeProvider,
      ensureReady: Effect.sync(() => {
        calls.push("ensureReady");
      }),
    },
    locateVolume: () =>
      Effect.sync(() => {
        calls.push("locateVolume");
        return { coordinationKey: "daemon/data", nativeName: "data" };
      }),
  });

  // When
  await Effect.runPromise(
    startApp(
      {},
      {
        plan: plannedApp,
        root: plannedApp.root,
        app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
      },
    ).pipe(Effect.provide(harness.layer)),
  );

  // Then
  expect(calls[0]).toBe("ensureReady");
  expect(calls).toContain("locateVolume");
});

const dataVolumeMount = {
  type: "volume" as const,
  store: "web-data",
  target: PortablePath.make("/var/www/html"),
  origin: "service" as const,
  readOnly: false,
};

const withDataVolume = (app: AppPlan): AppPlan => ({
  ...app,
  identity: { appRoot: app.root, ownerKey: appIdentityKey("owner", app.root) },
  services: { [web.name]: { ...web, mounts: [dataVolumeMount] } },
  stores: [{ name: "web-data", scope: "app", kind: "data" }],
});

const recreatedVolumeRun = async (operation: "start" | "selected start" | "restart", recorded: boolean) => {
  const plannedApp = withDataVolume(plan);
  const warnings = makeCommandWarnings(false);
  const harness = makeHarness({
    plannedApp,
    ...(recorded
      ? {
          appliedPlans: [withDataVolume(plan)],
          resolveAppliedPlan: () => Effect.succeed(withDataVolume(plan)),
        }
      : { appliedPlans: [] }),
    applyOutcome: () => ({
      changed: true,
      createdVolumes: [{ nativeName: "web-data", generation: "second", ownerRoot: plannedApp.root }],
    }),
  });
  const target = {
    plan: plannedApp,
    root: plannedApp.root,
    app: { kind: "user" as const, id: plannedApp.id, root: plannedApp.root },
  };
  const launch =
    operation === "restart"
      ? restartApp({}, target)
      : startApp(operation === "selected start" ? { services: [web.name] } : {}, target);
  await Effect.runPromise(
    launch.pipe(
      Effect.provide(harness.layer),
      Effect.provideService(CommandWarnings, CommandWarnings.of(warnings)),
    ),
  );
  return {
    warnings: await Effect.runPromise(warnings.list),
    printed: harness.events.filter((event) => event._tag === "message.warn").map((event) => event.body),
  };
};

test.each(["start", "selected start", "restart"] as const)(
  "%s warns once when a recorded data volume is recreated",
  async (operation) => {
    const result = await recreatedVolumeRun(operation, true);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: RECREATED_DATA_VOLUME_CODE,
      context: { app: String(plan.id), service: "web", volume: "web-data", target: "/var/www/html" },
    });
    expect(result.printed).toHaveLength(1);
    expect(result.printed[0]).toContain("recreated without its previous contents");
  },
);

test("a first start with no recorded volume makes no recreated-volume claim", async () => {
  const result = await recreatedVolumeRun("start", false);

  expect(result.warnings).toEqual([]);
  expect(result.printed).toEqual([]);
});
