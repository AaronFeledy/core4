import { describe, expect, test } from "bun:test";

import { Clock, DateTime, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type DependencyPlan,
  type HealthcheckPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import {
  buildServiceStartGraph,
  runServiceStartSchedule,
  serviceStartNodeId,
} from "../src/service-start-schedule.ts";

const provider = ProviderId.make("test");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-07-17T00:00:00Z"),
  source: "service-start-schedule.test",
  runtime: 4 as const,
};

const commandHealthcheck: HealthcheckPlan = {
  kind: "command",
  command: ["pg_isready"],
  intervalSeconds: 0,
  timeoutSeconds: 5,
  retries: 1,
};

const service = (name: string, overrides: Partial<ServicePlan> = {}): readonly [string, ServicePlan] => {
  const serviceName = ServiceName.make(name);
  return [
    name,
    {
      name: serviceName,
      type: "test",
      provider,
      primary: name === "web",
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
      ...overrides,
    },
  ];
};

const dependency = (
  name: string,
  condition: DependencyPlan["condition"],
  required = true,
): DependencyPlan => ({ service: ServiceName.make(name), condition, required });

const planOf = (services: ReadonlyArray<readonly [string, ServicePlan]>): AppPlan => ({
  id: AppId.make("start-schedule"),
  name: "Start schedule",
  slug: "start-schedule",
  root: AbsolutePath.make("/tmp/start-schedule"),
  provider,
  services: Object.fromEntries(services),
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const recordingHandlers = (record: Array<string>, overrides: Record<string, unknown> = {}) => ({
  startService: (target: ServicePlan) =>
    Effect.sync(() => {
      record.push(`start:${String(target.name)}`);
      return { changed: true };
    }),
  execHealthcheck: (target: ServicePlan) =>
    Effect.sync(() => {
      record.push(`health:${String(target.name)}`);
      return { exitCode: 0 };
    }),
  waitForExit: (target: ServicePlan) =>
    Effect.sync(() => {
      record.push(`wait:${String(target.name)}`);
      return { exitCode: 0 };
    }),
  ...overrides,
});

describe("buildServiceStartGraph", () => {
  test("materializes only the gates some dependent actually demands", () => {
    // Given
    const plan = planOf([
      service("db", { healthcheck: commandHealthcheck }),
      service("web", { dependsOn: [dependency("db", "service_healthy")] }),
    ]);

    // When
    const graph = buildServiceStartGraph(plan);

    // Then
    expect(graph.nodes.map((node) => node.id)).toEqual(["svc:db", "svc:web", "gate:db:healthy"]);
    expect(graph.edges).toEqual([
      { predecessor: "svc:db", dependent: "gate:db:healthy", required: true },
      { predecessor: "gate:db:healthy", dependent: "svc:web", required: true },
    ]);
  });

  test("shares one gate node across dependents while keeping required edge-local", () => {
    // Given
    const plan = planOf([
      service("db", { healthcheck: commandHealthcheck }),
      service("web", { dependsOn: [dependency("db", "service_healthy", true)] }),
      service("cache", { dependsOn: [dependency("db", "service_healthy", false)] }),
    ]);

    // When
    const graph = buildServiceStartGraph(plan);

    // Then
    expect(graph.nodes.filter((node) => node.id === "gate:db:healthy")).toHaveLength(1);
    expect(graph.edges).toContainEqual({
      predecessor: "gate:db:healthy",
      dependent: "svc:web",
      required: true,
    });
    expect(graph.edges).toContainEqual({
      predecessor: "gate:db:healthy",
      dependent: "svc:cache",
      required: false,
    });
  });

  test("drops dependencies on services this plan does not contain", () => {
    // Given
    const plan = planOf([service("web", { dependsOn: [dependency("absent", "service_started", false)] })]);

    // When
    const graph = buildServiceStartGraph(plan);

    // Then
    expect(graph.nodes.map((node) => node.id)).toEqual(["svc:web"]);
    expect(graph.edges).toEqual([]);
  });
});

describe("runServiceStartSchedule", () => {
  test.each([
    { exits: [0], period: 30, interval: 10, elapsed: 0 },
    { exits: [1, 1, 0], period: 90, interval: 10, elapsed: 2_000 },
    { exits: [1, 1, 1, 0], period: 3, interval: 10, elapsed: 3_000 },
    { exits: [1, 0], period: 30, interval: 0.25, elapsed: 250 },
  ])(
    "probes immediately through start-period grace ($elapsed ms)",
    async ({ exits, period, interval, elapsed }) => {
      const plan = planOf([
        service("db", {
          healthcheck: { ...commandHealthcheck, startPeriodSeconds: period, intervalSeconds: interval },
        }),
        service("web", { dependsOn: [dependency("db", "service_healthy")] }),
      ]);
      let attempts = 0;
      const timed = await Effect.runPromise(
        Effect.gen(function* () {
          const start = yield* Clock.currentTimeMillis;
          const fiber = yield* Effect.forkChild(
            runServiceStartSchedule(plan, {
              ...recordingHandlers([]),
              execHealthcheck: () => Effect.sync(() => ({ exitCode: exits[attempts++] ?? 1 })),
            }).pipe(
              Effect.map((result) => ({ result, elapsed: 0 })),
              Effect.flatMap(({ result }) =>
                Effect.map(Clock.currentTimeMillis, (now) => ({ result, elapsed: now - start })),
              ),
            ),
          );
          yield* TestClock.adjust(elapsed);
          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestClock.layer())),
      );
      expect(timed.result).toEqual({ _tag: "Settled", changed: true, blocked: [] });
      expect(timed.elapsed).toBe(elapsed);
      expect(attempts).toBe(exits.length);
    },
  );

  test("bounds each gate attempt after grace and retains its timeout evidence", async () => {
    const plan = planOf([
      service("db", {
        healthcheck: {
          ...commandHealthcheck,
          startPeriodSeconds: 1,
          timeoutSeconds: 1,
          retries: 2,
          intervalSeconds: 1,
        },
      }),
      service("web", { dependsOn: [dependency("db", "service_healthy")] }),
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          runServiceStartSchedule(plan, {
            ...recordingHandlers([]),
            execHealthcheck: () => Effect.never,
          }),
        );
        yield* TestClock.adjust("4 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result).toMatchObject({
      _tag: "Settled",
      blocked: [{ service: "web", dependency: "db", timedOut: true }],
    });
  });
  test("starts a dependency before its dependent regardless of declaration order", async () => {
    // Given
    const forward = planOf([
      service("db", { healthcheck: commandHealthcheck }),
      service("web", { dependsOn: [dependency("db", "service_healthy")] }),
    ]);
    const reversed = planOf([
      service("web", { dependsOn: [dependency("db", "service_healthy")] }),
      service("db", { healthcheck: commandHealthcheck }),
    ]);

    // When
    const forwardCalls: Array<string> = [];
    const reversedCalls: Array<string> = [];
    const forwardResult = await Effect.runPromise(
      runServiceStartSchedule(forward, recordingHandlers(forwardCalls)),
    );
    await Effect.runPromise(runServiceStartSchedule(reversed, recordingHandlers(reversedCalls)));

    // Then
    expect(forwardCalls).toEqual(["start:db", "health:db", "start:web"]);
    expect(reversedCalls).toEqual(forwardCalls);
    expect(forwardResult).toEqual({ _tag: "Settled", changed: true, blocked: [] });
  });

  test("waits for a successful exit before starting a completion dependent", async () => {
    // Given
    const plan = planOf([
      service("seed"),
      service("web", { dependsOn: [dependency("seed", "service_completed_successfully")] }),
    ]);
    const calls: Array<string> = [];

    // When
    const result = await Effect.runPromise(runServiceStartSchedule(plan, recordingHandlers(calls)));

    // Then
    expect(calls).toEqual(["start:seed", "wait:seed", "start:web"]);
    expect(result).toEqual({ _tag: "Settled", changed: true, blocked: [] });
  });

  test("blocks a required dependent when its gate fails and names the unmet gate", async () => {
    // Given
    const plan = planOf([
      service("db", { healthcheck: commandHealthcheck }),
      service("web", { dependsOn: [dependency("db", "service_healthy")] }),
    ]);
    const calls: Array<string> = [];

    // When
    const result = await Effect.runPromise(
      runServiceStartSchedule(
        plan,
        recordingHandlers(calls, {
          execHealthcheck: (target: ServicePlan) =>
            Effect.sync(() => {
              calls.push(`health:${String(target.name)}`);
              return { exitCode: 1 };
            }),
        }),
      ),
    );

    // Then
    expect(calls).toEqual(["start:db", "health:db"]);
    expect(result).toEqual({
      _tag: "Settled",
      changed: true,
      blocked: [{ service: "web", unmetGate: "db:healthy", dependency: "db", lastExitCode: 1 }],
    });
  });

  test("lets an optional dependent start when the shared gate fails", async () => {
    // Given
    const plan = planOf([
      service("db", { healthcheck: commandHealthcheck }),
      service("cache", { dependsOn: [dependency("db", "service_healthy", false)] }),
    ]);
    const calls: Array<string> = [];

    // When
    const result = await Effect.runPromise(
      runServiceStartSchedule(
        plan,
        recordingHandlers(calls, {
          execHealthcheck: () => Effect.succeed({ exitCode: 1 }),
        }),
      ),
    );

    // Then
    expect(calls).toEqual(["start:db", "start:cache"]);
    expect(result).toEqual({ _tag: "Settled", changed: true, blocked: [] });
  });

  test("fails closed for a non-command service_healthy gate", async () => {
    // Given
    const plan = planOf([
      service("db", { healthcheck: { ...commandHealthcheck, kind: "http", url: "http://localhost" } }),
      service("web", { dependsOn: [dependency("db", "service_healthy")] }),
    ]);
    const calls: Array<string> = [];

    // When
    const result = await Effect.runPromise(runServiceStartSchedule(plan, recordingHandlers(calls)));

    // Then
    expect(calls).toEqual(["start:db"]);
    expect(result).toEqual({
      _tag: "Settled",
      changed: true,
      blocked: [{ service: "web", unmetGate: "db:healthy", dependency: "db" }],
    });
  });

  test("records a healthcheck timeout on the blocked dependency instead of parsing unmetGate", async () => {
    // Given
    const plan = planOf([
      service("db", { healthcheck: { ...commandHealthcheck, timeoutSeconds: 0, retries: 1 } }),
      service("web", { dependsOn: [dependency("db", "service_healthy")] }),
    ]);

    // When
    const result = await Effect.runPromise(
      runServiceStartSchedule(
        plan,
        recordingHandlers([], {
          execHealthcheck: () => Effect.never,
        }),
      ),
    );

    // Then
    expect(result).toEqual({
      _tag: "Settled",
      changed: true,
      blocked: [{ service: "web", unmetGate: "db:healthy", dependency: "db", timedOut: true }],
    });
  });

  test("records a failed completion exit code on the blocked dependency", async () => {
    // Given
    const plan = planOf([
      service("seed"),
      service("web", { dependsOn: [dependency("seed", "service_completed_successfully")] }),
    ]);

    // When
    const result = await Effect.runPromise(
      runServiceStartSchedule(
        plan,
        recordingHandlers([], {
          waitForExit: () => Effect.succeed({ exitCode: 3 }),
        }),
      ),
    );

    // Then
    expect(result).toEqual({
      _tag: "Settled",
      changed: true,
      blocked: [{ service: "web", unmetGate: "seed:completed", dependency: "seed", lastExitCode: 3 }],
    });
  });

  test("tolerates a start failure only when every consumer edge is optional", async () => {
    // Given
    const plan = planOf([
      service("db"),
      service("cache", { dependsOn: [dependency("db", "service_started", false)] }),
    ]);
    const calls: Array<string> = [];

    // When
    const result = await Effect.runPromise(
      runServiceStartSchedule(
        plan,
        recordingHandlers(calls, {
          startService: (target: ServicePlan) =>
            String(target.name) === "db"
              ? Effect.fail(new Error("optional dependency failed"))
              : Effect.succeed({ changed: true }),
        }),
      ),
    );

    // Then
    expect(result).toEqual({ _tag: "Settled", changed: true, blocked: [] });
  });

  test("cleans only the failed optional dependency before starting its dependent", async () => {
    // Given
    const plan = planOf([
      service("db"),
      service("cache", { dependsOn: [dependency("db", "service_started", false)] }),
    ]);
    const calls: Array<string> = [];
    const handlers = {
      ...recordingHandlers(calls, {
        startService: (target: ServicePlan) =>
          String(target.name) === "db"
            ? Effect.fail(new Error("optional dependency failed"))
            : Effect.sync(() => {
                calls.push(`start:${String(target.name)}`);
                return { changed: true };
              }),
      }),
      cleanupOptionalStartFailure: (target: ServicePlan) =>
        Effect.sync(() => {
          calls.push(`cleanup:${String(target.name)}`);
        }),
    };

    // When
    await Effect.runPromise(runServiceStartSchedule(plan, handlers));

    // Then
    expect(calls).toEqual(["cleanup:db", "start:cache"]);
  });

  test("does not tolerate interruption of an optional-only dependency start", async () => {
    // Given
    const plan = planOf([
      service("db"),
      service("cache", { dependsOn: [dependency("db", "service_started", false)] }),
    ]);
    const calls: Array<string> = [];

    // When
    const exit = await Effect.runPromiseExit(
      runServiceStartSchedule(
        plan,
        recordingHandlers(calls, {
          startService: (target: ServicePlan) =>
            String(target.name) === "db"
              ? Effect.interrupt
              : Effect.sync(() => {
                  calls.push(`start:${String(target.name)}`);
                  return { changed: true };
                }),
        }),
      ),
    );

    // Then
    expect(exit._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });

  test("keeps a standalone start failure fatal", async () => {
    // Given
    const plan = planOf([service("db")]);
    const handlers = {
      startService: () => Effect.fail(new Error("fatal start")),
      execHealthcheck: () => Effect.succeed({ exitCode: 0 }),
      waitForExit: () => Effect.succeed({ exitCode: 0 }),
    };

    // When
    const error = await Effect.runPromise(Effect.flip(runServiceStartSchedule(plan, handlers)));

    // Then
    expect(error.message).toBe("fatal start");
  });

  test("resolves a started gate without probing or waiting", async () => {
    // Given
    const plan = planOf([
      service("db"),
      service("web", { dependsOn: [dependency("db", "service_started")] }),
    ]);
    const calls: Array<string> = [];

    // When
    await Effect.runPromise(runServiceStartSchedule(plan, recordingHandlers(calls)));

    // Then
    expect(calls).toEqual(["start:db", "start:web"]);
  });

  test("reports a cycle instead of starting anything", async () => {
    // Given
    const plan = planOf([
      service("db", { dependsOn: [dependency("web", "service_started")] }),
      service("web", { dependsOn: [dependency("db", "service_started")] }),
    ]);
    const calls: Array<string> = [];

    // When
    const result = await Effect.runPromise(runServiceStartSchedule(plan, recordingHandlers(calls)));

    // Then
    expect(calls).toEqual([]);
    expect(result._tag).toBe("Cycle");
  });

  test("exposes the service node id vocabulary", () => {
    // Given / When / Then
    expect(serviceStartNodeId(ServiceName.make("db"))).toBe("svc:db");
  });
});
