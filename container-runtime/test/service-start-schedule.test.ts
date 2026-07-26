import { describe, expect, test } from "bun:test";

import { DateTime, Effect } from "effect";

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
  resolvedAt: DateTime.unsafeMake("2026-07-17T00:00:00Z"),
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
      blocked: [{ service: "web", unmetGate: "db:healthy" }],
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
      blocked: [{ service: "web", unmetGate: "db:healthy" }],
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
