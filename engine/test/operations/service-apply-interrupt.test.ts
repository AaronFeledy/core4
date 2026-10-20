import { expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { type PublishSession, withRetainedSession } from "../../src/operations/retained-session.ts";
import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("provider-apply interruption retains the app and managed resources", async () => {
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
      (publish: PublishSession<string>) => publish("resource").pipe(Effect.as("resource")),
      () =>
        startApp(
          {},
          {
            plan,
            root: plan.root,
            app: { kind: "user", id: plan.id, root: plan.root },
          },
          { scope },
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
  expect(destroyed).toBe(0);
  expect(closed).toBe(0);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(closed).toBe(1);
});
