import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AppId, ProviderId, appIdentityKey } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp, destroyAppForTarget } from "../../src/operations/destroy.ts";
import { stopApp, stopAppForTarget, stopAppWithPlan } from "../../src/operations/stop.ts";
import { resolveTeardownEvidence } from "../../src/providers/applied-state-resolution.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("whole-app internal stop never prepares ownership cleanup", async () => {
  // Given
  let stopped = false;
  const harness = makeHarness({
    resolveAppliedPlan: () => Effect.succeed(plan),
    resolveTeardownEvidence: () => Effect.die("internal stop must not resolve teardown evidence"),
    onDestroy: () => {
      stopped = true;
    },
  });
  // When
  const { result } = await Effect.runPromise(
    withResolvedCwd(plan.root, stopAppWithPlan()).pipe(Effect.provide(harness.layer)),
  );
  // Then
  expect(result.outcome).toBe("stopped");
  expect(stopped).toBe(true);
});

test("selected internal stop preserves the non-teardown orphan refusal", async () => {
  // Given
  let removals = 0;
  const refusal = new ProviderUnavailableError({
    providerId: "lando",
    operation: "resolveAppliedPlan",
    message: "Orphaned resources have no applied state.",
  });
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    removeObservedService: () =>
      Effect.sync(() => {
        removals += 1;
        return { kind: "removed" as const };
      }),
  };
  const harness = makeHarness({
    selectProvider: () => Effect.succeed(provider),
    resolveAppliedPlan: () => Effect.fail(refusal),
    resolveTeardownEvidence: () =>
      Effect.succeed({
        kind: "orphans",
        groups: [{ providerId: plan.provider, appId: plan.id, services: [], volumes: [] }],
      }),
  });
  // When
  const exit = await Effect.runPromiseExit(
    stopAppWithPlan(
      {},
      {
        plan,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
        landofile: literalTestLandofile({ name: plan.name, services: {} }),
      },
      { skipInitEvents: true },
    ).pipe(Effect.provide(harness.layer)),
  );
  // Then
  expect(exit._tag).toBe("Failure");
  expect(removals).toBe(0);
});

for (const operation of ["stop", "destroy"] as const) {
  test(`${operation} refuses hints from a host-supported but stopped provider`, async () => {
    // Given
    let mutations = 0;
    const hints = {
      appRoot: plan.root,
      ownerKey: appIdentityKey("owner", plan.root),
      providerId: plan.provider,
      appIds: [plan.id],
    };
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      isAvailable: Effect.succeed(true),
      getStatus: Effect.succeed({ running: false, message: "offline" }),
      cleanupOwnedResources: () =>
        Effect.sync(() => {
          mutations += 1;
          return { servicesRemoved: [], networksRemoved: 0, volumesRemoved: 0 };
        }),
    };
    const harness = makeHarness({
      selectProvider: () => Effect.succeed(provider),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "owned", ownership: [hints] }),
    });
    // When
    const exit = await Effect.runPromiseExit(
      withResolvedCwd(
        plan.root,
        operation === "stop" ? stopApp().pipe(Effect.asVoid) : destroyApp().pipe(Effect.asVoid),
      ).pipe(Effect.provide(harness.layer)),
    );
    // Then
    expect(exit._tag).toBe("Failure");
    expect(mutations).toBe(0);
  });
  test(`explicit-target ${operation} uses cleanup hints without non-teardown applied-state resolution`, async () => {
    // Given
    const hints = {
      appRoot: plan.root,
      ownerKey: appIdentityKey("owner", plan.root),
      providerId: plan.provider,
      appIds: [plan.id],
    };
    let cleaned = false;
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      isAvailable: Effect.succeed(true),
      cleanupOwnedResources: () =>
        Effect.sync(() => {
          cleaned = true;
          return { servicesRemoved: [], networksRemoved: 1, volumesRemoved: 0 };
        }),
    };
    const harness = makeHarness({
      selectProvider: () => Effect.succeed(provider),
      resolveAppliedPlan: () => Effect.die("Non-teardown resolution must not be used for cleanup hints"),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "owned", ownership: [hints] }),
    });
    const target = {
      plan,
      root: plan.root,
      app: { kind: "user" as const, id: plan.id, root: plan.root },
      landofile: literalTestLandofile({ name: plan.name, services: {} }),
    };
    // When
    const outcome = await Effect.runPromise(
      (operation === "stop"
        ? stopAppForTarget({}, target).pipe(Effect.map((result) => result.outcome))
        : destroyAppForTarget({}, target).pipe(Effect.map((result) => result.outcome))
      ).pipe(Effect.provide(harness.layer)),
    );
    // Then
    expect(cleaned).toBe(true);
    expect(outcome).toBe(operation === "stop" ? "stopped" : "destroyed");
  });
  test(`${operation} cleans failed provider B alongside applied provider A`, async () => {
    // Given
    const applied = {
      ...plan,
      identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
    };
    const calls: string[] = [];
    const a = {
      ...TestRuntimeProvider,
      id: "lando",
      appliedPlans: Effect.succeed([applied]),
      isAvailable: Effect.succeed(true),
      destroy: () =>
        Effect.sync(() => {
          calls.push("a");
          return { kind: "destroyed" as const };
        }),
    };
    const b = {
      ...TestRuntimeProvider,
      id: "docker",
      appliedPlans: Effect.succeed([]),
      isAvailable: Effect.succeed(true),
      resourceOwnership: () =>
        Effect.succeed({
          ...applied.identity,
          providerId: ProviderId.make("docker"),
          appIds: [AppId.make("failed-b")],
        }),
      canCleanupOwnedResources: Effect.succeed(true),
      cleanupOwnedResources: () =>
        Effect.sync(() => {
          calls.push("b");
          return { servicesRemoved: [], networksRemoved: 1, volumesRemoved: 0 };
        }),
    };
    const harness = makeHarness({
      plannedApp: applied,
      providerOverrides: a,
      selectProvider: (target) =>
        Effect.succeed((typeof target === "string" ? target : target?.provider) === "docker" ? b : a),
      resolveAppliedPlan: () => Effect.succeed(applied),
      resolveTeardownEvidence: (root) => resolveTeardownEvidence(root, [a, b]),
    });
    // When
    const outcome = await Effect.runPromise(
      withResolvedCwd(
        plan.root,
        operation === "stop"
          ? stopApp().pipe(Effect.map((result) => result.outcome))
          : destroyApp().pipe(Effect.map((result) => result.outcome)),
      ).pipe(Effect.provide(harness.layer)),
    );
    // Then
    expect(calls).toEqual(["a", "b"]);
    expect(outcome).toBe(operation === "stop" ? "stopped" : "destroyed");
  });

  test(`${operation} reports unchanged when every ownership hint is already absent`, async () => {
    // Given
    let retired = false;
    const hints = {
      appRoot: plan.root,
      ownerKey: appIdentityKey("owner", plan.root),
      providerId: plan.provider,
      appIds: [plan.id],
    };
    const provider = {
      ...TestRuntimeProvider,
      isAvailable: Effect.succeed(true),
      cleanupOwnedResources: () =>
        Effect.sync(() => {
          retired = true;
          return { servicesRemoved: [], networksRemoved: 0, volumesRemoved: 0 };
        }),
    };
    const harness = makeHarness({
      selectProvider: () => Effect.succeed(provider),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "owned", ownership: [hints] }),
    });
    // When
    const outcome = await Effect.runPromise(
      withResolvedCwd(
        plan.root,
        operation === "stop"
          ? stopApp().pipe(Effect.map((result) => result.outcome))
          : destroyApp().pipe(Effect.map((result) => result.outcome)),
      ).pipe(Effect.provide(harness.layer)),
    );
    // Then
    expect(retired).toBe(true);
    expect(outcome).toBe("unchanged");
  });
}
import { literalTestLandofile } from "../compiled-landofile.ts";
