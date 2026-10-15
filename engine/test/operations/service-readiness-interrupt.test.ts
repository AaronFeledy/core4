import { expect, test } from "bun:test";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { isReadinessInterruptCause } from "../../src/lifecycle/readiness-failure.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { withRetainedSession } from "../../src/operations/retained-session.ts";
import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const mode of ["fiber", "signal"] as const) {
  test.each(["start", "restart", "rebuild", "restart-selected", "rebuild-selected"] as const)(
    `%s retains its applied app and managed resources on readiness ${mode} interruption`,
    async (operation) => {
      const probing = Deferred.makeUnsafe<void>();
      const controller = new AbortController();
      let applied = false;
      let cleanup = 0;
      let closed = 0;
      const scope = await Effect.runPromise(Scope.make());
      const plannedApp = {
        ...plan,
        services: {
          [web.name]: {
            ...web,
            healthcheck: {
              kind: "command" as const,
              command: ["check"],
              startPeriodSeconds: 90,
              intervalSeconds: 10,
              timeoutSeconds: 5,
              retries: 5,
            },
          },
        },
      };
      const harness = makeHarness({
        plannedApp,
        onApply: () => {
          applied = true;
        },
        onDestroy: () => {
          if (applied) cleanup++;
        },
        onRemoveRoutes: () => {
          if (applied) cleanup++;
        },
        inspect: (target) =>
          Effect.succeed({
            app: plan.id,
            service: target.service,
            providerId: plan.provider,
            status: "running",
            state: "running",
            containerId: "container",
            lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
          }),
        exec: () => Deferred.succeed(probing, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const target = {
        plan: plannedApp,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root } as const,
      };
      const options = {
        signal: controller.signal,
        ...(operation.endsWith("selected") ? { services: [web.name] } : {}),
      };
      const work =
        operation === "start"
          ? startApp(options, target, { scope }, { onFailedStart: Scope.close(scope, Exit.void) })
          : operation.startsWith("restart")
            ? restartApp(options, target, { scope })
            : rebuildApp(options, target, { scope });
      const fiber = Effect.runFork(
        withRetainedSession(Effect.succeed("resource"), () => work, {
          scope,
          close: () =>
            Effect.sync(() => {
              closed++;
            }),
        }).pipe(Effect.provide(harness.layer)),
      );
      await Effect.runPromise(Deferred.await(probing));
      if (mode === "fiber") await Effect.runPromise(Fiber.interrupt(fiber));
      else controller.abort();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(Exit.isFailure(exit) && isReadinessInterruptCause(exit.cause)).toBe(true);
      expect(cleanup).toBe(0);
      expect(closed).toBe(0);
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(closed).toBe(1);
    },
  );
}
