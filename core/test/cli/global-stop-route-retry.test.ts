import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyApplyError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, ServiceName } from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import { globalStop } from "../../src/cli/commands/meta/global-stop.ts";
import { globalPlanAt, globalTeardownHarness } from "../_support/global-teardown-harness.ts";

test("selected global stop retries failed route cleanup after its container was removed", async () => {
  // Given applied routes and containers, with the first route publication failing after removal.
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-stop-route-retry-"));
  try {
    const base = globalPlanAt(AbsolutePath.make(join(dataRoot, "global")));
    const [service] = Object.values(base.services);
    if (service === undefined) throw new Error("fixture requires an applied service");
    const plan: AppPlan = {
      ...base,
      services: {
        ...base.services,
        [ServiceName.make("sibling")]: { ...service, name: ServiceName.make("sibling") },
      },
      routes: ["ssh-agent", "sibling"].map((name) => ({
        hostname: `${name}.lndo.site`,
        priority: 1,
        scheme: "http",
        service: ServiceName.make(name),
        endpoint: 80,
        backend: { service: ServiceName.make(name), protocol: "http", port: 80 },
      })),
    };
    const containers = new Map<string, ServiceRuntimeInfo>(
      ["ssh-agent", "sibling"].map((name) => [
        name,
        {
          app: plan.id,
          appRoot: plan.root,
          providerId: plan.provider,
          service: ServiceName.make(name),
          containerId: `${name}-container`,
          status: "running",
        },
      ]),
    );
    const removed: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      appliedPlans: Effect.succeed([plan]),
      list: () => Effect.sync(() => Array.from(containers.values())),
      removeObservedService: (observation: ServiceRuntimeInfo) =>
        Effect.sync(() => {
          removed.push(String(observation.containerId));
          containers.delete(String(observation.service));
          return { kind: "removed" as const };
        }),
      ensureReady: Effect.die("route retry must not start the runtime"),
      apply: () => Effect.die("route retry must not recreate containers"),
      start: () => Effect.die("route retry must not start containers"),
      restart: () => Effect.die("route retry must not restart containers"),
      stop: () => Effect.die("route retry must not recreate or restart a container"),
      destroy: () => Effect.die("selected stop must not destroy the whole app"),
    };
    let routeAttempts = 0;
    let persistedRoutes = plan.routes;
    const router = {
      ...makeTestRouterService(),
      setup: () => Effect.die("stop must not set up the router"),
      applyRoutes: (routes: AppPlan["routes"]) =>
        Effect.gen(function* () {
          routeAttempts++;
          if (routeAttempts === 1)
            return yield* Effect.fail(
              new ProxyApplyError({
                message: "route apply failed",
                proxyId: "test",
                app: plan.id,
                remediation: "Retry route publication.",
              }),
            );
          persistedRoutes = routes;
          return { app: plan.id, appliedRoutes: routes, authorities: [] };
        }),
    };
    const harness = await globalTeardownHarness(dataRoot, { plan });
    const stop = globalStop({ services: ["ssh-agent"] }).pipe(
      Effect.provideService(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          list: Effect.succeed([plan.provider]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Effect.provideService(RouterService, router),
      Effect.provide(harness.layer),
    );
    const first = await Effect.runPromise(stop.pipe(Effect.result));
    expect(first).toMatchObject({ _tag: "Failure", failure: { _tag: "ProxyApplyError" } });
    expect(harness.calls).toEqual(["pre-global-stop"]);
    // When the same command retries after the selected container is already gone.
    const retry = await Effect.runPromise(stop);
    // Then route cleanup succeeds, the receipt stays honest, and the sibling container and route survive.
    expect(retry).toMatchObject({ outcome: "unchanged", servicesStopped: [] });
    expect(routeAttempts).toBe(2);
    expect(persistedRoutes.map((route) => String(route.service))).toEqual(["sibling"]);
    expect(removed).toEqual(["ssh-agent-container"]);
    expect(Array.from(containers.values()).map((container) => container.containerId)).toEqual([
      "sibling-container",
    ]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
