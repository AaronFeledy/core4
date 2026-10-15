import { expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { isReadinessInterruptCause } from "../../src/lifecycle/readiness-failure.ts";
import { withRetainedSession } from "../../src/operations/retained-session.ts";
import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("provider-apply interruption rolls back instead of taking post-commit readiness retention", async () => {
  const applying = Deferred.makeUnsafe<void>();
  const scope = await Effect.runPromise(Scope.make());
  let destroyed = 0;
  let closed = 0;
  const harness = makeHarness({
    applyEffect: Deferred.succeed(applying, undefined).pipe(Effect.andThen(Effect.never)),
    onDestroy: () => {
      destroyed++;
    },
  });
  const fiber = Effect.runFork(
    withRetainedSession(
      Effect.succeed("resource"),
      () =>
        startApp(
          {},
          {
            plan,
            root: plan.root,
            app: { kind: "user", id: plan.id, root: plan.root },
          },
          { scope },
          { onFailedStart: Scope.close(scope, Exit.void) },
        ),
      {
        scope,
        close: () =>
          Effect.sync(() => {
            closed++;
          }),
      },
    ).pipe(Effect.provide(harness.layer)),
  );
  await Effect.runPromise(Deferred.await(applying));
  await Effect.runPromise(Fiber.interrupt(fiber));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(Exit.isFailure(exit) && isReadinessInterruptCause(exit.cause)).toBe(false);
  expect(destroyed).toBe(1);
  expect(closed).toBe(1);
  await Effect.runPromise(Scope.close(scope, Exit.void));
});
