import { expect, test } from "bun:test";
import { ProviderInternalError } from "@lando/sdk/errors";
import { AppId, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { BuildOrchestrator, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Stream } from "effect";
import { BuildOwner } from "../../src/services/build-owner.ts";
import { openAppBuildResults } from "../../src/services/build-results.ts";
import { makeLayer, planWith, providerId, withTempRoots } from "./build-app-runner-test-support.ts";

test("#2297 reruns only the replaced service while a retained container with a new start time reuses its steps", async () => {
  await withTempRoots(async () => {
    const calls: string[] = [];
    const observations: string[] = [];
    let generation = 1;
    const provider = {
      ...TestRuntimeProvider,
      inspect: (target) => {
        observations.push(String(target.service));
        return Effect.succeed({
          service: target.service,
          app: AppId.make("app-build-runner"),
          providerId,
          publications: { status: "unknown" },
          status: "running",
          containerId: target.service === ServiceName.make("web") ? `web-${generation}` : "node-1",
          lastStartedAt: new Date(`2026-07-17T00:00:0${generation}Z`),
        });
      },
      execStream: (target, command) => {
        calls.push(`${target.service}:${command.command[0]}`);
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [
        { id: "prepare", phase: "app", command: { command: ["prepare"] } },
        { id: "install", phase: "app", command: { command: ["install"] } },
      ],
      node: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    const initialCalls = await Effect.runPromise(
      Effect.gen(function* () {
        const orchestrator = yield* BuildOrchestrator;
        yield* orchestrator.buildApp(plan);
        const initialCalls = calls.toSorted();
        calls.length = 0;
        observations.length = 0;
        generation = 2;
        yield* orchestrator.buildApp(plan);
        return initialCalls;
      }).pipe(Effect.provide(makeLayer(provider))),
    );

    expect(initialCalls).toEqual(["node:install", "web:install", "web:prepare"]);
    expect(calls).toEqual(["web:prepare", "web:install"]);
    expect(observations.toSorted()).toEqual(["node", "web"]);
  });
});

for (const observation of ["missing", "empty", "failure"] as const) {
  test(`app builds execute normally when container observation is ${observation}`, async () => {
    await withTempRoots(async () => {
      let known = true;
      let calls = 0;
      const provider = {
        ...TestRuntimeProvider,
        inspect: (target) => {
          if (!known && observation === "failure")
            return Effect.fail(
              new ProviderInternalError({
                providerId,
                operation: "inspect",
                message: "Cannot inspect container",
                remediation: "Check the provider.",
              }),
            );
          return Effect.succeed({
            service: target.service,
            app: AppId.make("app-build-runner"),
            providerId,
            publications: { status: "unknown" },
            status: "running",
            ...(known ? { containerId: "web-1" } : observation === "empty" ? { containerId: "" } : {}),
          } satisfies ServiceRuntimeInfo);
        },
        execStream: () => {
          calls += 1;
          return Stream.make({ exitCode: 0 });
        },
      } satisfies RuntimeProviderShape;
      const plan = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const orchestrator = yield* BuildOrchestrator;
          yield* orchestrator.buildApp(plan);
          known = false;
          yield* orchestrator.buildApp(plan);
          return yield* (yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(plan))).get;
        }).pipe(Effect.provide(makeLayer(provider))),
      );

      expect(calls).toBe(2);
      expect(entries?.[0]?.outcome).toBe("complete");
      expect(entries?.[0]?.containerId).toBeUndefined();
    });
  });
}

test("forced app builds observe and record identity and a failed attempt prevents later reuse", async () => {
  await withTempRoots(async () => {
    let calls = 0;
    let inspections = 0;
    let exitCode = 0;
    const dispatchCounts: number[] = [];
    const provider = {
      ...TestRuntimeProvider,
      inspect: (target) => {
        inspections += 1;
        return Effect.succeed({
          app: AppId.make("app-build-runner"),
          providerId,
          publications: { status: "unknown" },
          service: target.service,
          status: "running",
          containerId: "web-1",
        });
      },
      execStream: () => {
        calls += 1;
        return Stream.make({ exitCode });
      },
    } satisfies RuntimeProviderShape;
    const plan = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const orchestrator = yield* BuildOrchestrator;
        const bucket = yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(plan));
        yield* orchestrator.buildApp(plan, { force: true });
        dispatchCounts.push(calls);
        yield* orchestrator.buildApp(plan);
        dispatchCounts.push(calls);
        exitCode = 7;
        const failure = yield* Effect.flip(orchestrator.buildApp(plan, { force: true }));
        dispatchCounts.push(calls);
        const failedEntries = yield* bucket.get;
        exitCode = 0;
        yield* orchestrator.buildApp(plan);
        dispatchCounts.push(calls);
        return { entries: yield* bucket.get, failedEntries, failure };
      }).pipe(Effect.provide(makeLayer(provider))),
    );

    expect(dispatchCounts).toEqual([1, 1, 2, 3]);
    expect(inspections).toBe(4);
    expect(result.failure._tag).toBe("BuildPhaseFailedError");
    if (result.failure._tag !== "BuildPhaseFailedError") throw result.failure;
    expect(result.failure.failures[0]).toMatchObject({ exitCode: 7 });
    expect(result.failedEntries).toHaveLength(1);
    expect(result.failedEntries?.[0]).toMatchObject({ outcome: "fail", exitCode: 7, containerId: "web-1" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries?.[0]).toMatchObject({ outcome: "complete", containerId: "web-1" });
  });
});

test("an inspect failure preserves the ordinary app command failure", async () => {
  await withTempRoots(async () => {
    const provider = {
      ...TestRuntimeProvider,
      inspect: () =>
        Effect.fail(
          new ProviderInternalError({
            providerId,
            operation: "inspect",
            message: "Cannot inspect",
            remediation: "Check the provider.",
          }),
        ),
      execStream: () => Stream.make({ exitCode: 7 }),
    } satisfies RuntimeProviderShape;
    const plan = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });

    const failure = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (build) => build.buildApp(plan))).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    expect(failure._tag).toBe("BuildPhaseFailedError");
    if (failure._tag !== "BuildPhaseFailedError") throw failure;
    expect(failure.failures).toHaveLength(1);
    expect(failure.failures[0]).toMatchObject({ exitCode: 7, step: { id: "web:app:install" } });
  });
});
