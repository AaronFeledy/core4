import { expect, test } from "bun:test";
import { type AppPlan, ServiceName, StartedService } from "@lando/sdk/schema";
import { DateTime, Effect, Layer, Schema } from "effect";

import { UrlScanner } from "@lando/sdk/services";
import { makeTestUrlScanner } from "@lando/sdk/test";

import { startApp } from "../../src/operations/start.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

test("start probes published URLs through UrlScanner with the plan", async () => {
  const scanner = makeTestUrlScanner();
  const harness = makeHarness();
  const result = await Effect.runPromise(
    startApp(
      {},
      {
        plan,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
      },
    ).pipe(
      Effect.provide(
        Layer.succeed(UrlScanner, {
          ...scanner,
          scan: (appId, options) =>
            scanner.scan(appId, options).pipe(
              Effect.map((result) => ({
                ...result,
                endpoints: (options?.urls ?? []).map((target) => ({
                  ...target,
                  reachable: true,
                  verdict: "ready" as const,
                  outcome: "green" as const,
                  statusCode: 200,
                })),
              })),
            ),
        }),
      ),
      Effect.provide(harness.layer),
    ),
  );
  const scan = scanner.calls.find((call) => call.op === "scan");
  const row = Schema.encodeSync(StartedService)(
    Schema.decodeUnknownSync(StartedService)(result.servicesStarted[0]),
  );
  expect(row).toEqual({
    name: "web",
    state: "running",
    connections: [
      {
        scope: "app",
        source: "listener",
        binding: "assigned",
        protocol: "http",
        host: "web",
        port: 3000,
        url: "http://web:3000",
        alternateUrls: [],
        state: "active",
        endpoint: { port: 3000, transport: "tcp", names: ["http"], primary: false },
      },
      {
        scope: "host",
        source: "publication",
        binding: "assigned",
        protocol: "http",
        host: "localhost",
        port: 3000,
        url: "http://localhost:3000",
        alternateUrls: [],
        state: "active",
        endpoint: { port: 3000, transport: "tcp", names: ["http"], primary: false },
      },
    ],
  });
  expect(result.servicesStarted).toEqual([row]);
  expect(scan?.op).toBe("scan");
  expect(scan && "appId" in scan ? scan.appId : undefined).toBe(plan.id);
  expect(scan && "options" in scan ? scan.options?.plan : undefined).toBeDefined();
  expect(scan && "options" in scan ? scan.options?.urls : undefined).toEqual([
    {
      service: web.name,
      url: "http://localhost:3000/",
      endpoint: { port: 3000, transport: "tcp", names: ["http"], primary: false },
    },
  ]);
  const scanTreeId = `start-scan-${plan.id}`;
  const trees = byTag(harness.events, "task.tree.start");
  expect(trees.findIndex((tree) => tree.parentId === scanTreeId)).toBeGreaterThan(
    trees.findIndex((tree) => tree.parentId === `apply-${plan.id}`),
  );
  expect(trees.find((tree) => tree.parentId === scanTreeId)).toMatchObject({
    label: `Checking ${plan.name}`,
    children: [`${scanTreeId}:web-1`],
  });
  expect(
    byTag(harness.events, "task.tree.complete").find((tree) => tree.parentId === scanTreeId),
  ).toMatchObject({ summary: `${plan.name} answered on 1 URL`, succeeded: 1, failed: 0 });
  expect(result.checks).toMatchObject([
    {
      id: "http:web:http://localhost:3000/",
      kind: "http",
      service: "web",
      verdict: "ready",
      statusCode: 200,
    },
  ]);
});

test("initial full start keeps completed routed jobs out of addresses and URL scans", async () => {
  // Given a routed job already exited successfully before its first inspection.
  const consumer = ServiceName.make("consumer");
  const plannedApp: AppPlan = {
    ...plan,
    router: { enabled: true },
    services: {
      [web.name]: web,
      [consumer]: {
        ...web,
        name: consumer,
        dependsOn: [{ service: web.name, condition: "service_completed_successfully", required: true }],
      },
    },
    routes: [
      {
        hostname: "job.example.test",
        scheme: "https",
        priority: 2,
        service: web.name,
        backend: { service: web.name, protocol: "http", port: 3000 },
      },
    ],
  };
  const scanner = makeTestUrlScanner();
  const harness = makeHarness({
    plannedApp,
    inspect: ({ service }) =>
      Effect.succeed({
        app: plan.id,
        providerId: plan.provider,
        service,
        status: service === web.name ? "stopped" : "running",
        state: service === web.name ? "stopped" : "running",
        ...(service === web.name ? { exitCode: 0 } : {}),
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
        publications: {
          status: "present",
          bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 3000 }],
        },
      }),
  });
  // When the public start operation applies routes and builds scan targets.
  const result = await Effect.runPromise(
    startApp(
      {},
      {
        plan: plannedApp,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
      },
    ).pipe(Effect.provideService(UrlScanner, scanner), Effect.provide(harness.layer)),
  );
  // Then completed addresses remain configured and only the running consumer is scanned.
  const completed = result.servicesStarted.find((row) => row.name === "web");
  expect(completed?.state).toBe("completed");
  expect(completed?.connections.map((connection) => connection.state)).toEqual([
    "inactive",
    "inactive",
    "inactive",
  ]);
  expect(scanner.calls.find((call) => call.op === "scan")).toMatchObject({
    options: { urls: [{ service: consumer, url: "http://localhost:3000/" }] },
  });
});

test("projects the latest binding only after readiness changes the final observation", async () => {
  const plannedApp: AppPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        endpoints: [{ _tag: "published", protocol: "http", port: 3000, publication: {} }],
        healthcheck: {
          kind: "command",
          command: ["check"],
          retries: 1,
          timeoutSeconds: 1,
          intervalSeconds: 1,
        },
      },
    },
  };
  let hostPort = 8080;
  const harness = makeHarness({
    plannedApp,
    inspect: ({ service }) =>
      Effect.succeed({
        app: plan.id,
        service,
        providerId: plan.provider,
        status: "running",
        publications: {
          status: "present",
          bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort }],
        },
      }),
    exec: () =>
      Effect.sync(() => {
        hostPort = 9090;
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
  });
  const result = await Effect.runPromise(
    startApp(
      {},
      { plan: plannedApp, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } },
    ).pipe(Effect.provide(harness.layer)),
  );
  expect(result.servicesStarted[0]?.state).toBe("ready");
  expect(
    result.servicesStarted[0]?.connections.find((connection) => connection.scope === "host"),
  ).toMatchObject({ port: 9090, url: "http://localhost:9090", state: "active" });
  expect(result.servicesStarted).toEqual(
    result.servicesStarted.map((row) => Schema.encodeSync(StartedService)(row)),
  );
});
