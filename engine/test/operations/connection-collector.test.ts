import { expect, test } from "bun:test";
import { ServiceName, StartedService } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { collectObservedConnections, observeService } from "../../src/operations/connection-collector.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test("observes routes once for the plan and retains unmatched runtime rows without leaking runtime", async () => {
  const other = ServiceName.make("other");
  const planned = {
    ...plan,
    services: { [web.name]: web, [other]: { ...web, name: other } },
    routes: [
      {
        hostname: "web.test",
        scheme: "https" as const,
        service: web.name,
        priority: 1,
        backend: { service: web.name, protocol: "http" as const, port: 3000 },
      },
    ],
  };
  let calls = 0;
  const observations = [web.name, other, ServiceName.make("unplanned")].map((service) =>
    observeService(planned, {
      app: plan.id,
      providerId: plan.provider,
      service,
      status: "running",
      publications: {
        status: "present",
        bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 3000 }],
      },
    }),
  );
  const rows = await Effect.runPromise(
    collectObservedConnections(planned, observations).pipe(
      Effect.provideService(RouterService, {
        ...makeTestRouterService(),
        observeRoutes: (_app, routes) =>
          Effect.sync(() => {
            calls++;
            expect(routes).toEqual(planned.routes);
            return { configuredAuthorities: [], observation: { status: "unknown" as const } };
          }),
      }),
    ),
  );
  expect(calls).toBe(1);
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => Schema.encodeSync(StartedService)(row))).toEqual(rows);
  expect(rows.at(-1)?.connections).toMatchObject([
    { protocol: "tcp", endpoint: { names: [], primary: false } },
  ]);
  expect(rows.map((row) => Object.keys(row).sort())).toEqual(
    Array.from({ length: 3 }, () => ["connections", "name", "state"]),
  );
});

test.each([false, true])("requires completion intent as well as exit zero (intent %s)", (intent) => {
  const consumer = ServiceName.make("consumer");
  const planned = {
    ...plan,
    services: {
      [web.name]: web,
      ...(intent
        ? {
            [consumer]: {
              ...web,
              name: consumer,
              dependsOn: [
                { service: web.name, condition: "service_completed_successfully" as const, required: true },
              ],
            },
          }
        : {}),
    },
  };
  const row = observeService(planned, {
    app: plan.id,
    providerId: plan.provider,
    service: web.name,
    status: "stopped",
    exitCode: 0,
    publications: { status: "missing" },
  });
  expect(row.state).toBe(intent ? "completed" : "stopped");
});
