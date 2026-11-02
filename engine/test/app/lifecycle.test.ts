import { expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { makeAppLifecycle } from "../../src/app/lifecycle.ts";

test("discarding an unused staged scope leaves the current owner intact", async () => {
  let currentClosed = 0;
  let stagedClosed = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* makeAppLifecycle(yield* Scope.Scope);
        const current = yield* lifecycle.stageFresh;
        yield* Scope.addFinalizer(
          current,
          Effect.sync(() => {
            currentClosed++;
          }),
        );
        yield* lifecycle.replaceCurrent(current);
        const staged = yield* lifecycle.stageFresh;
        yield* Scope.addFinalizer(
          staged,
          Effect.sync(() => {
            stagedClosed++;
          }),
        );
        yield* lifecycle.discardStaged(staged);
        expect(yield* lifecycle.current).toBe(current);
        expect(currentClosed).toBe(0);
        expect(stagedClosed).toBe(1);
        yield* lifecycle.discardStaged(current);
        expect(currentClosed).toBe(0);
        yield* lifecycle.closeCurrent;
        expect(currentClosed).toBe(1);
      }),
    ),
  );
  expect(currentClosed).toBe(1);
  expect(stagedClosed).toBe(1);
});

test("a scope that became current is retained until its normal owner closes", async () => {
  const owner = await Effect.runPromise(Scope.make());
  const lifecycle = await Effect.runPromise(makeAppLifecycle(owner));
  const staged = await Effect.runPromise(lifecycle.stageFresh);
  let closed = 0;
  await Effect.runPromise(
    Scope.addFinalizer(
      staged,
      Effect.sync(() => {
        closed++;
      }),
    ),
  );
  await Effect.runPromise(lifecycle.replaceCurrent(staged));
  await Effect.runPromise(lifecycle.discardStaged(staged));
  expect(closed).toBe(0);
  expect(await Effect.runPromise(lifecycle.current)).toBe(staged);
  await Effect.runPromise(Scope.close(owner, Exit.void));
  expect(closed).toBe(1);
});
