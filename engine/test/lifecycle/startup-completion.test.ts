import { expect, test } from "bun:test";
import { ProxyApplyError } from "@lando/sdk/errors";
import { type AppPlan, FileSyncSessionRef, ServiceName } from "@lando/sdk/schema";
import { BuildOrchestrator, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { completeStartup } from "../../src/lifecycle/startup-completion.ts";
import { provideFileSyncEngine } from "../file-sync-engine.ts";
import { acceleratedPlan } from "../operations/accelerated-start-recovery-support.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";

const policies = ["user-start", "selected-restart", "selected-rebuild", "ensure-global", "scratch"] as const;
test.each([...policies, "forced-user-start" as const])(
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
          state: "running",
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
        case "selected-restart":
          return yield* completeStartup({
            ...readiness,
            policy,
            selectedPlan: {
              ...selectedPlan,
              services: acceleratedPlan.services,
              fileSync: acceleratedPlan.fileSync,
            },
            events,
          });
        case "selected-rebuild":
          return yield* completeStartup({ ...readiness, policy, selectedPlan, builds });
        case "ensure-global":
          return yield* completeStartup({ ...readiness, policy });
        case "scratch":
          return yield* completeStartup({ ...readiness, policy, router });
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
      "selected-restart": ["file-sync", "readiness"],
      "selected-rebuild": ["forced-build", "readiness"],
      "ensure-global": ["readiness"],
      scratch: ["route-setup", "routes", "readiness"],
    };
    expect(calls).toEqual(expected[policy]);
    expect(rows.map((row) => [row.name, row.state])).toEqual([["web", "ready"]]);
  },
);

test("scratch route publication failure remains soft and still runs readiness", async () => {
  // Given a proxy that fails route publication after setup.
  const calls: string[] = [];
  const routed: AppPlan = {
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
  const router = {
    ...TestRouterService,
    setup: () => Effect.void,
    applyRoutes: () =>
      Effect.fail(
        new ProxyApplyError({
          proxyId: "test",
          app: plan.id,
          message: "offline",
          remediation: "Restore the proxy.",
        }),
      ),
  };
  // When scratch completion sees an ordinary proxy failure.
  const rows = await Effect.runPromise(
    completeStartup({
      policy: "scratch",
      plan: routed,
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
              status: "stopped",
              state: "stopped",
              publications: { status: "unknown" },
              exitCode: 0,
            };
          }),
      },
    }).pipe(Effect.result),
  );
  // Then readiness was attempted rather than bypassed by the soft route error.
  expect(calls).toEqual(["readiness"]);
  expect(rows).toMatchObject({ _tag: "Failure", failure: { _tag: "ServiceNotReadyError" } });
});
