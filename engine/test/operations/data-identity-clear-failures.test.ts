import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { destroyApp } from "../../src/operations/destroy.ts";
import { readAppDataIdentity, recordAppDataIdentity } from "../../src/planner/data-identity.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { identity, identityPlan, identityTarget } from "./data-identity-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

test.each(["scoped", "observe", "select", "available", "status", "volumes", "list"] as const)(
  "completed destroy retains its data identity when cleanup evidence is %s",
  async (failureAt) => {
    const plan = identityPlan("current", "original");
    const store = makeTestStateStore();
    let destroyed = false;
    let observations = 0;
    const harness = makeHarness({
      plannedApp: plan,
      stateStore: store,
      appliedPlans: [plan],
      onDestroy: () => {
        destroyed = true;
      },
      providerOverrides: { getStatus: Effect.succeed({ running: true }) },
    });
    const failure = new ProviderUnavailableError({
      providerId: "docker",
      operation: "observation",
      message: "Unrelated provider is unavailable",
      remediation: "Restore its connection.",
    });
    try {
      await Effect.runPromise(recordAppDataIdentity(identity, "original").pipe(Effect.provide(store.layer)));
      const registry = harness.runtimeProviderRegistry;
      const docker = ProviderId.make("docker");
      const result = await Effect.runPromise(
        destroyApp(
          { volumes: true, ...(failureAt === "scoped" ? { providerId: plan.provider } : {}) },
          identityTarget(plan),
        ).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...registry,
            list: failureAt === "list" ? Effect.fail(failure) : Effect.succeed([plan.provider, docker]),
            select: (target) =>
              target !== docker
                ? registry.select(target)
                : failureAt === "select"
                  ? Effect.fail(failure)
                  : Effect.succeed({
                      ...TestRuntimeProvider,
                      id: docker,
                      isAvailable: failureAt === "available" ? Effect.fail(failure) : Effect.succeed(true),
                      getStatus:
                        failureAt === "status" ? Effect.fail(failure) : Effect.succeed({ running: true }),
                      listVolumes: () =>
                        failureAt === "volumes" ? Effect.fail(failure) : Effect.succeed([]),
                    }),
            ...(failureAt === "scoped" || failureAt === "observe"
              ? {
                  observeRuntime: Effect.sync(() => {
                    observations++;
                  }).pipe(Effect.andThen(Effect.fail(failure))),
                }
              : {}),
          }),
          Effect.provide(harness.layer),
        ),
      );
      expect(result).toMatchObject({
        outcome: "destroyed",
        servicesDestroyed: ["web"],
        volumesRemoved: true,
      });
      expect(destroyed).toBe(true);
      expect(
        await Effect.runPromise(readAppDataIdentity(identity).pipe(Effect.provide(store.layer))),
      ).toEqual({ name: "original" });
      if (failureAt === "scoped") expect(observations).toBe(0);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
