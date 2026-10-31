import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import {
  withGlobalActivationScope,
  withGlobalPolicyChange,
  withGlobalRoutePublication,
} from "../../src/global-app/activation-scope.ts";

test("a route publication excludes sibling policy and route writes until asynchronous completion", async () => {
  await Effect.runPromise(
    withGlobalActivationScope(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const publication = yield* Effect.forkScoped(
            withGlobalRoutePublication(
              Effect.gen(function* () {
                // A callback can inspect the claim without waiting on the short state gate.
                const nested = yield* withGlobalPolicyChange(
                  "disable",
                  Effect.die("must not change policy"),
                ).pipe(Effect.result);
                expect(nested).toMatchObject({
                  _tag: "Failure",
                  failure: { _tag: "GlobalAppError", operation: "policy-coordination" },
                });
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }),
            ),
          );
          yield* Deferred.await(entered);
          const policy = yield* withGlobalPolicyChange("enable", Effect.die("must not change policy")).pipe(
            Effect.result,
          );
          const route = yield* withGlobalRoutePublication(Effect.die("must not overwrite routes")).pipe(
            Effect.result,
          );
          expect(policy).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "GlobalAppError", operation: "policy-coordination" },
          });
          expect(route).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "GlobalAppError", operation: "route-coordination" },
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(publication);
          expect(yield* withGlobalPolicyChange("enable", Effect.succeed("after publication"))).toBe(
            "after publication",
          );
        }),
      ),
    ).pipe(Effect.timeout("2 seconds")),
  );
});

test("policy cleanup excludes a later route publication and releases ownership on completion", async () => {
  await Effect.runPromise(
    withGlobalActivationScope(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const policy = yield* Effect.forkScoped(
            withGlobalPolicyChange(
              "reconcile",
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
          );
          yield* Deferred.await(entered);
          const route = yield* withGlobalRoutePublication(Effect.die("must not publish during cleanup")).pipe(
            Effect.result,
          );
          expect(route).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "GlobalAppError", operation: "route-coordination" },
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(policy);
          expect(yield* withGlobalRoutePublication(Effect.succeed("after cleanup"))).toBe("after cleanup");
        }),
      ),
    ).pipe(Effect.timeout("2 seconds")),
  );
});

test("failed and cancelled route publications preserve body errors and release their claim", async () => {
  const failure = { message: "router write failed" };
  await Effect.runPromise(
    withGlobalActivationScope(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* withGlobalRoutePublication(Effect.fail(failure)).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure).toBe(failure);
          const entered = yield* Deferred.make<void>();
          let finalized = false;
          const publication = yield* Effect.forkScoped(
            withGlobalRoutePublication(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized = true;
                  }),
                ),
              ),
            ),
          );
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(publication);
          expect(finalized).toBe(true);
          expect(yield* withGlobalPolicyChange("disable", Effect.succeed("released"))).toBe("released");
        }),
      ),
    ).pipe(Effect.timeout("2 seconds")),
  );
});
