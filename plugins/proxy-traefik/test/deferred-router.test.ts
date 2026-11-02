import { expect, test } from "bun:test";
import { Context, Deferred, Effect, Fiber } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import { makeTestRouterService } from "@lando/sdk/test";

import { deferredRouter } from "../src/deferred-router.ts";

const Caller = Context.Reference<string>("@test/DeferredRouterCaller", { defaultValue: () => "default" });

test("a failed root resolution can recover and concurrent calls retain one router in caller context", async () => {
  const constructing = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const callers: string[] = [];
  const constructionCallers: string[] = [];
  let attempts = 0;
  const failure = new ProxyError({
    proxyId: "test",
    message: "Global storage is unavailable.",
    remediation: "Configure global storage and retry.",
  });
  const service = {
    ...makeTestRouterService(),
    status: Effect.gen(function* () {
      callers.push(yield* Caller);
      return { state: "stopped" as const, authorities: [], configuredApps: [] };
    }),
  };
  const router = await Effect.runPromise(
    deferredRouter(
      service,
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(failure)
          : Effect.gen(function* () {
              constructionCallers.push(yield* Caller);
              yield* Deferred.succeed(constructing, undefined);
              yield* Deferred.await(release);
              return service;
            });
      }),
    ),
  );
  expect(await Effect.runPromise(Effect.result(router.status))).toMatchObject({
    _tag: "Failure",
    failure,
  });
  const first = Effect.runFork(router.status.pipe(Effect.provideService(Caller, "first")));
  await Effect.runPromise(Deferred.await(constructing));
  const second = Effect.runFork(router.status.pipe(Effect.provideService(Caller, "second")));
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await Promise.all([Effect.runPromise(Fiber.join(first)), Effect.runPromise(Fiber.join(second))]);
  await Effect.runPromise(router.status.pipe(Effect.provideService(Caller, "later")));
  expect(attempts).toBe(2);
  expect(constructionCallers).toEqual(["first"]);
  expect(callers.sort()).toEqual(["first", "later", "second"]);
});

test("interrupting the first root resolution releases construction for a later operation", async () => {
  const entered = Deferred.makeUnsafe<void>();
  let attempts = 0;
  const service = makeTestRouterService();
  const router = await Effect.runPromise(
    deferredRouter(
      service,
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(service);
      }),
    ),
  );
  const interrupted = Effect.runFork(router.status);
  await Effect.runPromise(Deferred.await(entered));
  await Effect.runPromise(Fiber.interrupt(interrupted));
  expect((await Effect.runPromise(router.status)).state).toBe("stopped");
  expect(attempts).toBe(2);
});
