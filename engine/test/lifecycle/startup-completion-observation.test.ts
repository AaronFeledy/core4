import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { BuildOrchestrator, EventService, StateStore } from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Stream } from "effect";
import { completeStartup } from "../../src/lifecycle/startup-completion.ts";
import { withGlobalConsumerAdmissionCheck } from "../../src/operations/global-consumer-lease.ts";
import { withActivationObservations } from "../../src/services/build-app-observation.ts";
import { BuildOwner } from "../../src/services/build-owner.ts";
import { openAppBuildResults } from "../../src/services/build-results.ts";
import { makeLayer, planWith, providerId, withTempRoots } from "../services/build-app-runner-test-support.ts";

for (const policy of ["user-start", "selected-rebuild"] as const) {
  test(`${policy} records the activation identity without build inspections`, async () => {
    await withTempRoots(async () => {
      let inspections = 0;
      let commands = 0;
      const provider = {
        ...TestRuntimeProvider,
        inspect: (target) => {
          inspections += 1;
          return Effect.succeed({
            ...target,
            providerId,
            status: "running" as const,
            publications: { status: "unknown" as const },
            containerId: "provider-B",
          });
        },
        execStream: () => {
          commands += 1;
          return Stream.make({ exitCode: 0 });
        },
      } satisfies RuntimeProviderShape;
      const plan = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });
      const entries = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const builds = yield* BuildOrchestrator;
            const events = yield* EventService;
            const initial = new Map([
              [
                "web",
                {
                  app: plan.id,
                  service: ServiceName.make("web"),
                  providerId,
                  status: "running" as const,
                  publications: { status: "unknown" as const },
                  containerId: "activation-A",
                },
              ],
            ]);
            yield* withActivationObservations(builds.buildApp(plan), initial);
            commands = 0;
            const common = { provider, plan, services: [], initial, builds, events };
            if (policy === "user-start") {
              yield* completeStartup({ ...common, policy, router: TestRouterService });
            } else {
              yield* completeStartup({ ...common, policy, selectedPlan: plan });
            }
            return yield* (yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(plan))).get;
          }),
        ).pipe(Effect.provide(makeLayer(provider))),
      );

      expect(commands).toBe(policy === "selected-rebuild" ? 1 : 0);
      expect(inspections).toBe(0);
      expect(entries?.map((entry) => entry.containerId)).toEqual(["activation-A"]);
    });
  });
}

test("selected restart never dispatches an app build", async () => {
  await withTempRoots(async () => {
    let commands = 0;
    let inspections = 0;
    const provider = {
      ...TestRuntimeProvider,
      inspect: () =>
        Effect.sync(() => {
          inspections += 1;
          return {
            app: plan.id,
            service: ServiceName.make("web"),
            providerId,
            status: "running" as const,
            publications: { status: "unknown" as const },
            containerId: "web-A",
          };
        }),
      execStream: () => {
        commands += 1;
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const plan = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });
    const entries = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* completeStartup({
            policy: "selected-restart",
            plan,
            selectedPlan: plan,
            provider,
            services: [],
            events: yield* EventService,
          });
          return yield* (yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(plan))).get;
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );
    expect(commands).toBe(0);
    expect(inspections).toBe(0);
    expect(entries).toEqual([]);
  });
});

test("readiness rejects external replacement after a snapshot-based build reuse", async () => {
  await withTempRoots(async () => {
    let commands = 0;
    let inspections = 0;
    let buildInspections: number | undefined;
    const plan = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });
    const initial = new Map([
      [
        "web",
        {
          app: plan.id,
          service: ServiceName.make("web"),
          providerId,
          status: "running" as const,
          publications: { status: "unknown" as const },
          containerId: "activation-A",
        },
      ],
    ]);
    const provider = {
      ...TestRuntimeProvider,
      inspect: (target) =>
        Effect.sync(() => {
          inspections += 1;
          return {
            ...target,
            providerId,
            status: "running" as const,
            publications: { status: "unknown" as const },
            containerId: "replacement-B",
          };
        }),
      execStream: () => {
        commands += 1;
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const builds = yield* BuildOrchestrator;
          yield* withActivationObservations(builds.buildApp(plan), initial);
          commands = 0;
          return yield* Effect.flip(
            withGlobalConsumerAdmissionCheck(
              Effect.sync(() => {
                buildInspections = inspections;
              }),
              completeStartup({
                policy: "user-start",
                provider,
                plan,
                services: [ServiceName.make("web")],
                initial,
                builds,
                events: yield* EventService,
                router: TestRouterService,
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );
    expect(buildInspections).toBe(0);
    expect(commands).toBe(0);
    expect(failure).toMatchObject({
      _tag: "ServiceNotReadyError",
      reason: "not-running",
      lastStatus: "Container replaced or restarted during readiness.",
    });
  });
});
