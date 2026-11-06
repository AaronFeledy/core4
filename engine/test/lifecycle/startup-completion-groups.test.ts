import { expect, test } from "bun:test";
import { ServiceStartError } from "@lando/sdk/errors";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Deferred, Effect, Fiber } from "effect";
import { withGlobalActivationScope } from "../../src/global-app/activation-scope.ts";
import { completeStartup } from "../../src/lifecycle/startup-completion.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";
import { failureOf, successOf } from "../subsystems/healthcheck/support.ts";

test.each([false, true])(
  "global completion waits for every group before aggregate/routes (failure=%s)",
  async (fails) => {
    // Given three independent applied groups and, on failure, an earlier failed apply.
    const services = ["one", "two", "three"].map((name) => ({
      ...web,
      name: ServiceName.make(name),
      healthcheck: {
        kind: "command" as const,
        command: ["probe"],
        retries: 1,
        intervalSeconds: 0,
        timeoutSeconds: 10,
      },
    }));
    const builtPlan: AppPlan = {
      ...plan,
      services: Object.fromEntries(services.map((s) => [s.name, s])),
      routes: [
        {
          hostname: "one.test",
          service: ServiceName.make("one"),
          scheme: "http",
          priority: 1,
          backend: { service: ServiceName.make("one"), port: 3000, protocol: "http" },
        },
      ],
    };
    const calls: string[] = [];
    const entered = services.map(() => Deferred.makeUnsafe<void>());
    const gates = services.map(() => Deferred.makeUnsafe<void>());
    const provider = {
      ...TestRuntimeProvider,
      inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId: plan.provider,
          status: "running" as const,
          state: "running" as const,
          publications: { status: "unknown" as const },
          lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
          containerId: String(target.service),
        }),
      exec: (target: Parameters<typeof TestRuntimeProvider.exec>[0]) =>
        Effect.gen(function* () {
          const index = services.findIndex((service) => service.name === target.service);
          const arrival = entered[index];
          const gate = gates[index];
          if (arrival === undefined || gate === undefined) return yield* Effect.die("Unknown group");
          yield* Deferred.succeed(arrival, undefined);
          yield* Deferred.await(gate);
          calls.push(String(target.service));
          return { exitCode: fails && target.service !== "one" ? 1 : 0, stdout: "", stderr: "" };
        }),
    };
    const router = {
      ...TestRouterService,
      applyRoutes: () =>
        Effect.sync(() => {
          calls.push("routes");
          return { app: plan.id, appliedRoutes: [], authorities: [] };
        }),
    };
    // When all group probes enter before any is released, completion must remain blocked.
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.exit(
            completeStartup({
              policy: "global-groups",
              operation: "start",
              provider,
              router,
              outcome: {
                builtPlan,
                services,
                failures: fails
                  ? [
                      {
                        names: ["apply-failed"],
                        error: new ServiceStartError({
                          service: "apply-failed",
                          providerId: "lando",
                          operation: "apply",
                          message: "injected",
                          remediation:
                            "Inspect `lando logs -s apply-failed`, fix the service configuration or image, and start the app again.",
                        }),
                      },
                    ]
                  : [],
              },
            }),
          ),
        );
        yield* Effect.forEach(entered, (arrival) => Deferred.await(arrival));
        expect(calls).toEqual([]);
        yield* Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined));
        return yield* Fiber.join(fiber);
      }).pipe(withGlobalActivationScope),
    );
    // Then failed checks aggregate with apply failures; only all-ready groups publish routes.
    expect(calls.filter((call) => call !== "routes").sort()).toEqual(["one", "three", "two"]);
    if (fails) {
      expect(failureOf(exit)).toMatchObject({ _tag: "GlobalAppError", cause: { _tag: "ServiceStartError" } });
      expect(calls).not.toContain("routes");
    } else {
      expect(successOf(exit).ready).toHaveLength(3);
      expect(calls.at(-1)).toBe("routes");
    }
  },
);
