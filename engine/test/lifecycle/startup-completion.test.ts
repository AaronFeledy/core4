import { expect, test } from "bun:test";
import { ProxyApplyError, ProxySetupError } from "@lando/sdk/errors";
import { type AppPlan, FileSyncSessionRef, ServiceName } from "@lando/sdk/schema";
import { BuildOrchestrator, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { prepareRouteUrlBindings } from "../../src/lifecycle/route-url-bindings.ts";
import { completeStartup } from "../../src/lifecycle/startup-completion.ts";
import { provideFileSyncEngine } from "../file-sync-engine.ts";
import { acceleratedPlan } from "../operations/accelerated-start-recovery-support.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";
import { publicUrlRouter, urlReadingPlan } from "./route-url-fixture.ts";

const policies = ["user-start", "selected", "ensure-global", "scratch"] as const;

test("scratch with bound URLs fails with the router's own publication failure as its cause", async () => {
  const failure = new ProxyApplyError({
    proxyId: "test",
    app: urlReadingPlan.id,
    message: "Offline",
    remediation: "Restore the proxy.",
  });
  const router = { ...publicUrlRouter(), applyRoutes: () => Effect.fail(failure) };
  const routeUrls = await Effect.runPromise(
    prepareRouteUrlBindings({ plan: urlReadingPlan, routes: urlReadingPlan.routes, router }),
  );
  const result = await Effect.runPromise(
    completeStartup({
      policy: "scratch",
      id: "scratch-url",
      plan: urlReadingPlan,
      routeUrls,
      router,
      provider: TestRuntimeProvider,
      services: [web.name],
    }).pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ScratchAppError",
      operation: "start",
      cause: failure,
      remediation: expect.stringContaining(failure.remediation),
    },
  });
});

test("a changed router authority fails startup after route publication", async () => {
  const router = publicUrlRouter(9443);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const routeUrls = yield* prepareRouteUrlBindings({
        plan: urlReadingPlan,
        routes: urlReadingPlan.routes,
        router,
      });
      return yield* completeStartup({
        policy: "scratch",
        id: "scratch-url",
        plan: urlReadingPlan,
        router,
        routeUrls,
        provider: TestRuntimeProvider,
        services: [web.name],
      });
    }).pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "RouteUrlBindingError", reason: "authority-changed", service: web.name },
  });
});
test.each([...policies, "forced-user-start" as const, "forced-selected" as const])(
  "%s owns its complete ordered post-apply policy",
  async (policy) => {
    // Given recording services and a selected service with an unselected sibling.
    const calls: string[] = [];
    const consumer = ServiceName.make("consumer");
    const selectedPlan: AppPlan = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          healthcheck: {
            kind: "command",
            command: ["probe"],
            retries: 1,
            intervalSeconds: 0,
            timeoutSeconds: 1,
          },
        },
      },
    };
    const fullPlan: AppPlan = {
      ...selectedPlan,
      services: { ...selectedPlan.services, [consumer]: { ...web, name: consumer } },
      routes: [
        {
          hostname: "web.test",
          scheme: "http",
          service: web.name,
          priority: 1,
          backend: { service: web.name, port: 3000, protocol: "http" },
        },
      ],
    };
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      inspect: (target) =>
        Effect.succeed({
          app: fullPlan.id,
          service: target.service,
          providerId: fullPlan.provider,
          status: "running",
          publications: { status: "unknown" },
          lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
          containerId: "web",
        }),
      exec: () =>
        Effect.sync(() => {
          calls.push("readiness");
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    };
    const builds = BuildOrchestrator.of({
      build: (plan) => Effect.succeed(plan),
      buildApp: (plan, options) =>
        Effect.sync(() => {
          expect(Object.keys(plan.services)).toEqual(
            policy === "user-start" || policy === "forced-user-start" ? ["web", "consumer"] : ["web"],
          );
          calls.push(options?.force === true ? "forced-build" : "build");
        }),
    });
    const router = {
      ...TestRouterService,
      setup: () =>
        Effect.sync(() => {
          calls.push("route-setup");
        }),
      applyRoutes: () =>
        Effect.sync(() => {
          calls.push("routes");
          return { app: plan.id, appliedRoutes: [], authorities: [] };
        }),
    };
    const events = { publish: () => Effect.void };
    const readiness = { provider, plan: fullPlan, services: [web.name] };
    const completion = Effect.gen(function* () {
      switch (policy) {
        case "user-start":
          return yield* completeStartup({ ...readiness, policy, builds, router, events });
        case "forced-user-start":
          return yield* completeStartup({
            ...readiness,
            policy: "user-start",
            builds,
            router,
            events,
            forceAppBuild: true,
          });
        case "selected":
          return yield* completeStartup({
            ...readiness,
            policy,
            selectedPlan: {
              ...selectedPlan,
              services: acceleratedPlan.services,
              fileSync: acceleratedPlan.fileSync,
            },
            routePlan: fullPlan,
            builds,
            router,
            events,
          });
        case "forced-selected":
          return yield* completeStartup({
            ...readiness,
            policy: "selected",
            selectedPlan: {
              ...selectedPlan,
              services: acceleratedPlan.services,
              fileSync: acceleratedPlan.fileSync,
            },
            routePlan: fullPlan,
            builds,
            router,
            events,
            forceAppBuild: true,
          });
        case "ensure-global":
          return yield* completeStartup({ ...readiness, policy });
        case "scratch":
          return yield* completeStartup({ ...readiness, policy, id: "scratch-web", router });
        default:
          return policy satisfies never;
      }
    });
    // When completion runs against the real readiness runner and file-sync owner.
    const rows = await Effect.runPromise(
      completion.pipe(
        provideFileSyncEngine({
          ...TestFileSyncEngine,
          id: "mutagen",
          isAvailable: Effect.succeed(true),
          listSessions: () => Effect.succeed([]),
          createSession: () => Effect.succeed(FileSyncSessionRef.make("sync")),
          flushSession: () =>
            Effect.sync(() => {
              calls.push("file-sync");
            }),
        }),
      ),
    );
    // Then each policy has exactly its required ordering and one selected readiness probe.
    const expected = {
      "user-start": ["build", "route-setup", "routes", "readiness"],
      "forced-user-start": ["forced-build", "route-setup", "routes", "readiness"],
      selected: ["file-sync", "build", "route-setup", "routes", "readiness"],
      "forced-selected": ["file-sync", "forced-build", "route-setup", "routes", "readiness"],
      "ensure-global": ["readiness"],
      scratch: ["route-setup", "routes", "readiness"],
    };
    expect(calls).toEqual(expected[policy]);
    expect(rows.map((row) => [row.name, row.state])).toEqual([["web", "ready"]]);
  },
);

const routedPlan: AppPlan = {
  ...plan,
  routes: [
    {
      hostname: "web.test",
      scheme: "http",
      service: web.name,
      priority: 1,
      backend: { service: web.name, port: 3000, protocol: "http" },
    },
  ],
};
const proxyFailure = new ProxyApplyError({
  proxyId: "test",
  app: plan.id,
  message: "offline",
  remediation: "Restore the proxy.",
});

test.each(["setup", "applyRoutes"] as const)(
  "a routed scratch without URL consumers fails when router %s fails, before readiness",
  async (failing) => {
    // Given a routed scratch that binds no URLs and a router whose setup or publication fails.
    const calls: string[] = [];
    const router = {
      ...TestRouterService,
      setup: () =>
        failing === "setup"
          ? Effect.fail(
              new ProxySetupError({ proxyId: "test", message: "offline", remediation: "Restore the proxy." }),
            )
          : Effect.void,
      applyRoutes: () => Effect.fail(proxyFailure),
    };
    // When scratch completion runs.
    const result = await Effect.runPromise(
      completeStartup({
        policy: "scratch",
        id: "scratch-web",
        plan: routedPlan,
        services: [web.name],
        router,
        provider: {
          ...TestRuntimeProvider,
          inspect: () =>
            Effect.sync(() => {
              calls.push("readiness");
              return {
                app: plan.id,
                service: web.name,
                providerId: plan.provider,
                status: "running" as const,
                publications: { status: "unknown" },
              };
            }),
        },
      }).pipe(Effect.result),
    );
    // Then the router failure fails startup as a scratch failure and readiness never runs.
    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ScratchAppError",
        operation: "start",
        cause: { _tag: failing === "setup" ? "ProxySetupError" : "ProxyApplyError" },
        remediation: expect.stringContaining("Restore the proxy."),
      },
    });
  },
);

test("a route-free scratch never sets up or touches the router", async () => {
  // Given a router that records every call and a scratch plan with no routes.
  const calls: string[] = [];
  const router = {
    ...TestRouterService,
    setup: () => Effect.sync(() => void calls.push("setup")),
    applyRoutes: () =>
      Effect.sync(() => {
        calls.push("routes");
        return { app: plan.id, appliedRoutes: [], authorities: [] };
      }),
    removeRoutes: () => Effect.sync(() => void calls.push("remove")),
  };
  // When scratch completion runs.
  const result = await Effect.runPromise(
    completeStartup({
      policy: "scratch",
      id: "scratch-web",
      plan: { ...plan, routes: [] },
      services: [],
      router,
      provider: TestRuntimeProvider,
    }).pipe(Effect.result),
  );
  // Then completion succeeds without any router call.
  expect(result._tag).toBe("Success");
  expect(calls).toEqual([]);
});
