import { expect, test } from "bun:test";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Clock, DateTime, Deferred, Effect, Exit, Scope, Stream } from "effect";
import { withRetainedSession } from "../../src/operations/retained-session.ts";
import { waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { startApp } from "../../src/operations/start.ts";
import { failureOf, runExitUnderClock, successOf } from "../subsystems/healthcheck/support.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const app = { kind: "user", id: plan.id, root: plan.root } as const;
const target = { app, root: plan.root, plan };
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
const health = {
  kind: "command",
  command: ["check"],
  intervalSeconds: 10,
  timeoutSeconds: 1,
  retries: 1,
  startPeriodSeconds: 30,
} as const;
const withHealth = (): AppPlan => ({ ...plan, services: { [web.name]: { ...web, healthcheck: health } } });
const logs: RuntimeProviderShape["logs"] = () =>
  Stream.make({ service: web.name, stream: "stderr", line: "fatal startup problem" });
const readinessError = (exit: Exit.Exit<unknown, unknown>): ServiceNotReadyError => {
  const error = failureOf(exit);
  expect(error).toBeInstanceOf(ServiceNotReadyError);
  if (!(error instanceof ServiceNotReadyError)) throw new TypeError("Expected readiness error");
  return error;
};

test("delayed exit without a healthcheck fails start with evidence and retains the applied app", async () => {
  let destroyed = 0;
  let routesRemoved = 0;
  const inspected = Deferred.makeUnsafe<void>();
  const harness = makeHarness({
    logs,
    onDestroy: () => {
      destroyed++;
    },
    onRemoveRoutes: () => {
      routesRemoved++;
    },
    inspect: () =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        runtime(now >= 500 ? { status: "stopped", state: "stopped", exitCode: 17 } : {}),
      ).pipe(Effect.tap(() => Deferred.succeed(inspected, undefined))),
  });
  const timed = await runExitUnderClock(
    startApp({}, target).pipe(Effect.provide(harness.layer)),
    "500 millis",
    Deferred.await(inspected),
  );
  expect(readinessError(timed.exit)).toMatchObject({
    reason: "not-running",
    exitCode: 17,
    logTail: { lines: ["fatal startup problem"] },
  });
  expect(timed.elapsedMs).toBe(500);
  expect(destroyed).toBe(0);
  expect(routesRemoved).toBe(0);
  expect(byTag(harness.events, "post-app-start")).toHaveLength(0);
  expect(byTag(harness.events, "post-start")).toHaveLength(0);
});

test("passing after start-period failures returns ready before the grace period ends", async () => {
  const plannedApp = withHealth();
  let attempts = 0;
  const probing = Deferred.makeUnsafe<void>();
  const harness = makeHarness({
    plannedApp,
    inspect: () => Effect.succeed(runtime()),
    exec: () =>
      Effect.sync(() => ({ exitCode: ++attempts < 3 ? 1 : 0, stdout: "", stderr: "" })).pipe(
        Effect.tap(() => Deferred.succeed(probing, undefined)),
      ),
  });
  const timed = await runExitUnderClock(
    startApp({}, { ...target, plan: plannedApp }).pipe(Effect.provide(harness.layer)),
    "2 seconds",
    Deferred.await(probing),
  );
  expect(successOf(timed.exit).servicesStarted[0]?.state).toBe("ready");
  expect(timed.elapsedMs).toBe(2_000);
  expect(attempts).toBe(3);
  expect(byTag(harness.events, "post-start")).toHaveLength(1);
});

test.each(["failed", "timeout"] as const)(
  "an exhausted healthcheck (%s) retains resources",
  async (outcome) => {
    const plannedApp = {
      ...withHealth(),
      services: { [web.name]: { ...web, healthcheck: { ...health, startPeriodSeconds: 0 } } },
    };
    let destroyed = 0;
    const probing = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      plannedApp,
      inspect: () => Effect.succeed(runtime()),
      logs,
      onDestroy: () => {
        destroyed++;
      },
      exec: () =>
        Deferred.succeed(probing, undefined).pipe(
          Effect.andThen(
            outcome === "timeout" ? Effect.never : Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }),
          ),
        ),
    });
    const timed = await runExitUnderClock(
      startApp({}, { ...target, plan: plannedApp }).pipe(Effect.provide(harness.layer)),
      "1 second",
      Deferred.await(probing),
    );
    expect(readinessError(timed.exit)).toMatchObject({ reason: `healthcheck-${outcome}`, attempts: 1 });
    expect(destroyed).toBe(0);
    expect(byTag(harness.events, "post-start")).toHaveLength(0);
  },
);

test("a service that has passed readiness is still monitored while a sibling waits", async () => {
  const slow = ServiceName.make("slow");
  const plannedApp = {
    ...plan,
    services: {
      [web.name]: web,
      [slow]: { ...web, name: slow, healthcheck: { ...health, startPeriodSeconds: 90 } },
    },
  };
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    logs,
    inspect: (selected) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        runtime({
          service: selected.service,
          lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
          ...(selected.service === web.name && now >= 3_000
            ? { status: "stopped", state: "stopped", exitCode: 2 }
            : {}),
        }),
      ),
    exec: () => Effect.never,
  } satisfies RuntimeProviderShape;
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan: plannedApp, services: [web.name, slow] }),
    "3 seconds",
  );
  expect(readinessError(timed.exit)).toMatchObject({ service: "web", reason: "not-running", exitCode: 2 });
  expect(timed.elapsedMs).toBe(3_000);
});

test("container replacement during readiness fails instead of accepting a fresh incarnation", async () => {
  const provider = {
    ...TestRuntimeProvider,
    logs,
    inspect: () =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        runtime({ containerId: now >= 250 ? "replacement" : "original" }),
      ),
  } satisfies RuntimeProviderShape;
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan, services: [web.name] }),
    "250 millis",
  );
  expect(readinessError(timed.exit)).toMatchObject({
    reason: "not-running",
    lastStatus: expect.stringContaining("restarted"),
  });
});

test("no-healthcheck services wait only for the remainder of their current two-second startup window", async () => {
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed(
        runtime({
          lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-1_500)),
        }),
      ),
  } satisfies RuntimeProviderShape;
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan, services: [web.name] }),
    "500 millis",
  );
  expect(successOf(timed.exit)[0]?.state).toBe("running");
  expect(timed.elapsedMs).toBe(500);
});

test("a healthcheck wait fails fast when the process exits rather than exhausting its budget", async () => {
  const provider = {
    ...TestRuntimeProvider,
    logs,
    inspect: () =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        runtime(now >= 250 ? { status: "stopped", state: "stopped", exitCode: 7 } : {}),
      ),
    exec: () => Effect.never,
  } satisfies RuntimeProviderShape;
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan: withHealth(), services: [web.name] }),
    "250 millis",
  );
  expect(readinessError(timed.exit)).toMatchObject({ reason: "not-running", exitCode: 7 });
  expect(timed.elapsedMs).toBe(250);
});

test("retained sessions transfer to managed ownership even when readiness fails", async () => {
  const scope = await Effect.runPromise(Scope.make());
  let closed = 0;
  const error = new ServiceNotReadyError({
    message: "not ready",
    app: "app",
    service: "web",
    providerId: "lando",
    reason: "not-running",
    remediation: "Read logs",
  });
  const exit = await Effect.runPromiseExit(
    withRetainedSession(Effect.succeed("session"), () => Effect.fail(error), {
      scope,
      close: () =>
        Effect.sync(() => {
          closed++;
        }),
    }),
  );
  expect(readinessError(exit)).toBe(error);
  expect(closed).toBe(0);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(closed).toBe(1);
});
