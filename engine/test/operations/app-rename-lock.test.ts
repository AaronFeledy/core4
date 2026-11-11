import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Deferred, Effect, Fiber } from "effect";
import {
  appLockTarget,
  appMutationLockIdentity,
  appMutationLockKey,
  withAppMutationLock,
} from "../../src/operations/app-mutation-lock.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("user lock identity survives rename while scratch and global retain id plus root", async () => {
  const user = appLockTarget(plan);
  const renamed = appLockTarget({ ...plan, id: "renamed" });
  const scratch = appLockTarget({ ...plan, extensions: { "@lando/core/scratch": { id: plan.id } } });
  const first = await Effect.runPromise(appMutationLockIdentity(user));
  const second = await Effect.runPromise(appMutationLockIdentity(renamed));
  const scratchKey = await Effect.runPromise(appMutationLockIdentity(scratch));
  expect(first.key).toBe(second.key);
  expect(scratchKey.key).not.toBe(first.key);
  expect(appMutationLockKey("other", first.canonicalRoot, "scratch")).not.toBe(scratchKey.key);
  const globalKeys = ["global", "global-policy"].map((id) => appMutationLockKey(id, first.canonicalRoot));
  expect(new Set([first.key, ...globalKeys]).size).toBe(3);
});

test("different user names serialize across fibers sharing a root", async () => {
  const acquired = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const waiting = await Effect.runPromise(Deferred.make<void>());
  const harness = makeHarness({
    onPublish: (event) =>
      event._tag === "message.warn" && event.body.includes("app lock")
        ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid)
        : Effect.void,
  });
  let entered = false;
  const holder = Effect.runFork(
    withAppMutationLock(
      appLockTarget(plan),
      Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.provide(harness.layer)),
  );
  await Effect.runPromise(Deferred.await(acquired));
  const waiter = Effect.runFork(
    withAppMutationLock(
      appLockTarget({ ...plan, id: "renamed" }),
      Effect.sync(() => {
        entered = true;
      }),
    ).pipe(Effect.provide(harness.layer)),
  );
  try {
    await Effect.runPromise(Deferred.await(waiting).pipe(Effect.timeout("2 seconds")));
    expect(entered).toBe(false);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(holder));
    await Effect.runPromise(Fiber.join(waiter));
    expect(entered).toBe(true);
  } finally {
    await Effect.runPromise(Fiber.interrupt(holder));
    await Effect.runPromise(Fiber.interrupt(waiter));
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});
