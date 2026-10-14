import { expect, test } from "bun:test";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
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
    const plannedApp = jobPlan();
    const harness = makeHarness({
      plannedApp,
      inspect: () => Effect.succeed(runtime({ status: "stopped", state: "stopped", exitCode: 0 })),
      exec: () => Effect.die("Jobs must not execute healthchecks"),
    });
    const selected = { ...target, plan: plannedApp };
    const effect =
      operation === "restart"
        ? restartApp({ services: [web.name] }, selected)
        : rebuildApp({ services: [web.name] }, selected);
    const timed = await runExitUnderClock(effect.pipe(Effect.provide(harness.layer)), "0 seconds");
    expect(successOf(timed.exit).servicesStarted).toEqual([
      expect.objectContaining({ name: "web", state: "completed" }),
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
