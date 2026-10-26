import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";
import { RouterService, type RuntimeProviderShape, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer } from "effect";
import { infoApp } from "../../src/operations/info.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { failureOf, runExitUnderClock, successOf } from "../subsystems/healthcheck/support.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const target = { root: plan.root, plan, app: { kind: "user", id: plan.id, root: plan.root } as const };
const runtime = (extras: Partial<ServiceRuntimeInfo> = {}): ServiceRuntimeInfo => ({
  app: plan.id,
  service: web.name,
  providerId: plan.provider,
  status: "running",
  state: "running",
  publications: { status: "unknown" },
  containerId: "web-container",
  lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
  ...extras,
});
const jobPlan = (): AppPlan => {
  const consumer = ServiceName.make("consumer");
  return {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        healthcheck: {
          kind: "command",
          command: ["check"],
          intervalSeconds: 10,
          timeoutSeconds: 1,
          retries: 1,
        },
      },
      [consumer]: {
        ...web,
        name: consumer,
        dependsOn: [{ service: web.name, condition: "service_completed_successfully", required: true }],
      },
    },
  };
};

test("selected info preserves full-plan completion intent without inspecting unrelated services", async () => {
  // Given a successful job whose completion intent comes from its consumer.
  const plannedApp = jobPlan();
  const inspected: string[] = [];
  const harness = makeHarness({
    plannedApp,
    inspect: ({ service }) =>
      Effect.sync(() => {
        inspected.push(String(service));
        return runtime({ service, status: "stopped", state: "stopped", exitCode: 0 });
      }),
  });
  try {
    // When info is requested for the full app and then only the job.
    const [full, selected] = await Effect.runPromise(
      Effect.gen(function* () {
        const full = yield* infoApp({}, { ...target, plan: plannedApp });
        inspected.length = 0;
        const selected = yield* infoApp({ services: [web.name] }, { ...target, plan: plannedApp });
        return [full, selected] as const;
      }).pipe(Effect.provide(harness.layer)),
    );
    // Then selection changes only the output scope, not job classification.
    expect(full.services.find((row) => row.service === web.name)?.status).toBe("completed");
    expect(selected.services).toHaveLength(1);
    expect(selected.services[0]?.status).toBe("completed");
    expect(inspected).toEqual([String(web.name)]);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

test.each([0, 1])("completion-intent services require verified exit 0 (actual %s)", async (exitCode) => {
  const provider = {
    ...TestRuntimeProvider,
    inspect: () => Effect.succeed(runtime({ status: "stopped", state: "stopped", exitCode })),
    exec: () => Effect.die("Jobs must not execute healthchecks"),
  } satisfies RuntimeProviderShape;
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan: jobPlan(), services: [web.name] }),
    "0 seconds",
  );
  if (exitCode === 0) expect(successOf(timed.exit)[0]?.state).toBe("completed");
  else
    expect(failureOf(timed.exit)).toMatchObject({
      _tag: "ServiceNotReadyError",
      reason: "not-running",
      exitCode: 1,
    });
});

test.each(["restart", "rebuild"] as const)(
  "selected %s preserves completion intent from the full plan",
  async (operation) => {
    const plannedApp: AppPlan = {
      ...jobPlan(),
      router: { enabled: true },
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
    const harness = makeHarness({
      plannedApp,
      onApply: (_applied, options) => {
        expect(options?.completionPlan?.services[ServiceName.make("consumer")]?.dependsOn).toEqual([
          { service: web.name, condition: "service_completed_successfully", required: true },
        ]);
      },
      inspect: () => Effect.succeed(runtime({ status: "stopped", state: "stopped", exitCode: 0 })),
      exec: () => Effect.die("Jobs must not execute healthchecks"),
    });
    const selected = { ...target, plan: plannedApp };
    const effect =
      operation === "restart"
        ? restartApp({ services: [web.name] }, selected)
        : rebuildApp({ services: [web.name] }, selected);
    const timed = await runExitUnderClock(
      effect.pipe(
        Effect.provide(
          Layer.succeed(RouterService, {
            ...TestRouterService,
            status: Effect.succeed({
              state: "running" as const,
              configuredApps: [plannedApp.id],
              authorities: [{ scheme: "https" as const, hostname: "job.example.test", port: 443 }],
            }),
          }),
        ),
        Effect.provide(harness.layer),
      ),
      "0 seconds",
    );
    const rows = successOf(timed.exit).servicesStarted;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("completed");
    expect(rows[0]?.connections.map((connection) => connection.state)).toEqual([
      "inactive",
      "inactive",
      "inactive",
    ]);
  },
);

test.each(["restart", "rebuild"] as const)(
  "selected %s retains applied services on readiness failure",
  async (operation) => {
    let applied = false;
    let destroyed = 0;
    let stopped = 0;
    const harness = makeHarness({
      onApply: () => {
        applied = true;
      },
      onDestroy: () => {
        destroyed++;
      },
      onStop: () => {
        stopped++;
      },
      inspect: () =>
        Effect.succeed(runtime(applied ? { status: "stopped", state: "stopped", exitCode: 19 } : {})),
    });
    const effect =
      operation === "restart"
        ? restartApp({ services: [web.name] }, target)
        : rebuildApp({ services: [web.name] }, target);
    const timed = await runExitUnderClock(effect.pipe(Effect.provide(harness.layer)), "0 seconds");
    expect(failureOf(timed.exit)).toMatchObject({
      _tag: "ServiceNotReadyError",
      reason: "not-running",
      exitCode: 19,
    });
    expect(destroyed).toBe(0);
    expect(stopped).toBe(1);
    expect(byTag(harness.events, operation === "restart" ? "post-restart" : "post-rebuild")).toHaveLength(0);
  },
);
