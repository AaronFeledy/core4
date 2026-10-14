import { expect, test } from "bun:test";
import { FileSyncSessionRef } from "@lando/sdk/schema";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { readJournal } from "../../src/operations/accelerated-start-journal.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { failureOf } from "../subsystems/healthcheck/support.ts";
import { acceleratedPlan, target as acceleratedTarget } from "./accelerated-start-recovery-support.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test("post-apply readiness failure retains the accelerated lease, journal, and managed scope", async () => {
  let cleanup = 0;
  let scopeClosed = 0;
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(
    Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        scopeClosed++;
      }),
    ),
  );
  const harness = makeHarness({
    plannedApp: acceleratedPlan,
    onDestroy: () => {
      cleanup++;
    },
    onRemoveRoutes: () => {
      cleanup++;
    },
    onFileSyncRollback: () => {
      cleanup++;
    },
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId: plan.provider,
        status: "stopped",
        state: "stopped",
        exitCode: 17,
      }),
    fileSync: {
      ...TestFileSyncEngine,
      id: "mutagen",
      isAvailable: Effect.succeed(true),
      sessionsPersistAcrossProcesses: true,
      createSession: () => Effect.succeed(FileSyncSessionRef.make("retained")),
      listSessions: () => Effect.succeed([]),
      flushSession: () => Effect.void,
      terminateSession: () =>
        Effect.sync(() => {
          cleanup++;
        }),
      pauseSession: () =>
        Effect.sync(() => {
          cleanup++;
        }),
    },
  });
  const exit = await Effect.runPromiseExit(
    startApp(
      {},
      acceleratedTarget,
      { scope },
      {
        onFailedStart: Scope.close(scope, Exit.void),
      },
    ).pipe(Effect.provide(harness.layer)),
  );
  expect(failureOf(exit)).toMatchObject({ _tag: "ServiceNotReadyError", reason: "not-running" });
  expect(cleanup).toBe(0);
  expect(scopeClosed).toBe(0);
  const journal = await Effect.runPromise(
    readJournal(acceleratedTarget.app).pipe(Effect.provide(harness.layer)),
  );
  expect(journal.pending).toMatchObject({ phase: "completed", sessions: [{ name: "web/app-mount" }] });
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(scopeClosed).toBe(1);
});

test("interrupted readiness retains the accelerated lease and completed journal without closing its scope", async () => {
  let cleanup = 0;
  let closed = 0;
  const probing = Deferred.makeUnsafe<void>();
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(
    Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        closed++;
      }),
    ),
  );
  const acceleratedWeb = acceleratedPlan.services[web.name];
  if (acceleratedWeb === undefined) throw new TypeError("Expected accelerated service fixture");
  const plannedApp = {
    ...acceleratedPlan,
    services: {
      [web.name]: {
        ...acceleratedWeb,
        healthcheck: {
          kind: "command" as const,
          command: ["check"],
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
          startPeriodSeconds: 90,
        },
      },
    },
  };
  const harness = makeHarness({
    plannedApp,
    onDestroy: () => {
      cleanup++;
    },
    onRemoveRoutes: () => {
      cleanup++;
    },
    onFileSyncRollback: () => {
      cleanup++;
    },
    exec: () => Deferred.succeed(probing, undefined).pipe(Effect.andThen(Effect.never)),
    fileSync: {
      ...TestFileSyncEngine,
      id: "mutagen",
      isAvailable: Effect.succeed(true),
      sessionsPersistAcrossProcesses: true,
      createSession: () => Effect.succeed(FileSyncSessionRef.make("retained-interrupt")),
      listSessions: () => Effect.succeed([]),
      flushSession: () => Effect.void,
      terminateSession: () =>
        Effect.sync(() => {
          cleanup++;
        }),
      pauseSession: () =>
        Effect.sync(() => {
          cleanup++;
        }),
    },
  });
  const fiber = Effect.runFork(
    startApp(
      {},
      { ...acceleratedTarget, plan: plannedApp },
      { scope },
      {
        onFailedStart: Scope.close(scope, Exit.void),
      },
    ).pipe(Effect.provide(harness.layer)),
  );
  await Effect.runPromise(Deferred.await(probing));
  await Effect.runPromise(Fiber.interrupt(fiber));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(cleanup).toBe(0);
  expect(closed).toBe(0);
  const journal = await Effect.runPromise(
    readJournal(acceleratedTarget.app).pipe(Effect.provide(harness.layer)),
  );
  expect(journal.pending).toMatchObject({ phase: "completed", sessions: [{ name: "web/app-mount" }] });
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(closed).toBe(1);
});

test.each(["restart", "rebuild"] as const)(
  "full %s does not remove routes or tear down after readiness failure",
  async (operation) => {
    let applied = false;
    let cleanupAfterApply = 0;
    const harness = makeHarness({
      onApply: () => {
        applied = true;
      },
      onDestroy: () => {
        if (applied) cleanupAfterApply++;
      },
      onRemoveRoutes: () => {
        if (applied) cleanupAfterApply++;
      },
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId: plan.provider,
          status: applied ? "stopped" : "running",
          state: applied ? "stopped" : "running",
          containerId: "container",
          lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
          exitCode: 17,
        }),
    });
    const target = { plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } as const };
    const effect = operation === "restart" ? restartApp({}, target) : rebuildApp({}, target);
    const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(harness.layer)));
    expect(failureOf(exit)).toMatchObject({ _tag: "ServiceNotReadyError", service: String(web.name) });
    expect(cleanupAfterApply).toBe(0);
  },
);
