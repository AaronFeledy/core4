import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AppId, ServiceName, StartedService, appIdentityKey } from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRouterService, makeTestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import {
  collectObservedConnections,
  collectPlanObservations,
  observeService,
} from "../../src/operations/connection-collector.ts";
import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test("observes an unapplied service as absent while preserving provider failures", async () => {
  const provider = makeTestRuntimeProvider();
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed([]),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
    list: Effect.succeed([plan.provider]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
  const rows = await Effect.runPromise(
    collectPlanObservations(plan, plan, provider).pipe(
      Effect.provideService(RuntimeProviderRegistry, registry),
    ),
  );
  expect(
    rows.map((row) => ({
      name: row.name,
      status: row.runtime.status,
      publications: row.runtime.publications,
    })),
  ).toEqual([{ name: web.name, status: "absent", publications: { status: "missing" } }]);
  const error = new ProviderUnavailableError({
    providerId: "test",
    operation: "inspect",
    message: "offline",
    remediation: "Start the provider.",
  });
  const result = await Effect.runPromise(
    Effect.result(
      collectPlanObservations(plan, plan, { ...provider, inspect: () => Effect.fail(error) }),
    ).pipe(Effect.provideService(RuntimeProviderRegistry, registry)),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBe(error);
});

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
        observeRoutes: (_owner, routes) =>
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
    status: "exited",
    exitCode: 0,
    publications: { status: "missing" },
  });
  expect(row.state).toBe(intent ? "completed" : "stopped");
});

test("observes cwd scratch routes under the scratch owner instead of the source root", async () => {
  const id = AppId.make("scratch-source-123456");
  const route = {
    hostname: "scratch.test",
    scheme: "https" as const,
    service: web.name,
    priority: 2,
    backend: { service: web.name, protocol: "http" as const, port: 3000 },
  };
  const scratch = { ...plan, id, routes: [route], extensions: { [SCRATCH_EXTENSION_KEY]: { id } } };
  const router = makeTestRouterService();
  await Effect.runPromise(Effect.scoped(router.setup({ defaultDomain: "lndo.site" })));
  await Effect.runPromise(
    router.applyRoutes([route], { id, ownerKey: appIdentityKey("owner", `scratch:${id}`) }),
  );
  const runtime = observeService(scratch, {
    app: id,
    providerId: plan.provider,
    service: web.name,
    status: "running",
    publications: { status: "missing" },
  });

  const rows = await Effect.runPromise(
    collectObservedConnections(scratch, [runtime]).pipe(Effect.provideService(RouterService, router)),
  );

  expect(rows[0]?.connections.find((connection) => connection.source === "route")).toMatchObject({
    url: "https://scratch.test:38443",
    state: "active",
  });
});
